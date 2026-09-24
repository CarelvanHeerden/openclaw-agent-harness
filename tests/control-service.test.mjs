import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ControlPlaneService } from "../dist/control/service.js";

function fixture(overrides = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(readFileSync(new URL("../src/state/schema.sql", import.meta.url), "utf8"));
  let starts = 0;
  let merges = 0;
  let now = 1_800_000_000_000;
  const service = new ControlPlaneService({
    db,
    now: () => now,
    crystallise: async () => ({ kind: "brief", brief: {
      title: "Bounded change", motivation: "Implement the requested behavior.",
      acceptanceCriteria: ["The focused behavior is tested."], filesLikelyTouched: ["src/**"],
      outOfScope: ["secrets/**"], repoHint: "acme/widget", riskLevel: "medium",
    }}),
    resolveRepository: async () => ({ repositoryIdentity: "acme/widget", baseRef: "main",
      baseRevision: "a".repeat(40), credentialRoute: "github/acme/U1", policyDigest: "b".repeat(64), securityClass: "medium" }),
    startEngine: async () => { starts += 1; return { engineSessionId: "engine-1" }; },
    mergeChange: async () => { merges += 1; return { merged: true, mergeSha: "c".repeat(40) }; },
    ...overrides,
  });
  const context = (event, actor = "U1", conversation = "W1:C1:T1") => ({
    requesterSenderId: actor, conversationId: conversation, hostEventId: event, receivedAt: now,
  });
  return { db, service, context, tick(ms = 10) { now += ms; }, counts: () => ({ starts, merges }) };
}

async function prepared(f) {
  return f.service.prepare({ request: "Implement one bounded tested behavior.", repository: "acme/widget", budgetUsd: 8,
    timeLimitSeconds: 1200, scope: ["src/**", "tests/**"], excludedScope: ["secrets/**"] }, f.context("prepare"));
}

test("prepare is immutable, complete, and does not dispatch execution", async () => {
  const f = fixture();
  const proposal = await prepared(f);
  assert.equal(proposal.state, "prepared");
  assert.equal(proposal.confirmable, true);
  assert.deepEqual(proposal.scope, ["src/**", "tests/**"]);
  assert.equal(f.counts().starts, 0);
  const row = f.db.prepare("SELECT state, generation, base_revision, brief_digest, policy_digest, scope_digest FROM control_changes").get();
  assert.deepEqual({ state: row.state, generation: row.generation, base: row.base_revision.length }, { state: "prepared", generation: 1, base: 40 });
  assert.match(row.brief_digest, /^[a-f0-9]{64}$/);
  assert.match(row.policy_digest, /^[a-f0-9]{64}$/);
  assert.match(row.scope_digest, /^[a-f0-9]{64}$/);
});

test("confirmation uses fresh host identity, consumes once, and dispatches once", async () => {
  const f = fixture();
  const proposal = await prepared(f);
  f.tick();
  await assert.rejects(() => f.service.confirm(proposal.changeId, f.context("wrong", "U2")), /preparing requester/);
  const accepted = await f.service.confirm(proposal.changeId, f.context("confirm-1"));
  assert.equal(accepted.state, "accepted");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.counts().starts, 1);
  await assert.rejects(() => f.service.confirm(proposal.changeId, f.context("confirm-1")), /already confirmed/i);
  assert.equal(f.counts().starts, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM control_attestations").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM control_execution_intents").get().n, 1);
});

test("result is conversation-private and excludes execution internals", async () => {
  const f = fixture();
  const proposal = await prepared(f);
  assert.throws(() => f.service.result(proposal.changeId, f.context("read", "U1", "W1:C2")), /not found/i);
  const result = f.service.result(proposal.changeId, f.context("read"));
  const encoded = JSON.stringify(result);
  assert.equal(result.state, "prepared");
  assert.doesNotMatch(encoded, /engine|session|subtask|worktree|nonce|hostEvent|brief_json|credential/i);
});

test("merge requires a later distinct host event and is provider-idempotent", async () => {
  const f = fixture();
  const proposal = await prepared(f);
  f.tick();
  await f.service.confirm(proposal.changeId, f.context("confirm"));
  await new Promise((resolve) => setImmediate(resolve));
  f.service.recordReadiness({ changeId: proposal.changeId, pullRequestNumber: 7, pullRequestUrl: "https://example.test/pr/7",
    verdict: "pass", blocking: 0, publishedSha: "d".repeat(40), prHeadSha: "d".repeat(40),
    requiredCiDigest: "f".repeat(64), runtimeEvidenceDigest: "1".repeat(64), spendUsd: 4 });
  f.tick();
  const merged = await f.service.merge(proposal.changeId, f.context("merge"));
  assert.equal(merged.state, "merged");
  assert.equal(f.counts().merges, 1);
  await assert.rejects(() => f.service.merge(proposal.changeId, f.context("merge-2")), /already merged/i);
  assert.equal(f.counts().merges, 1);
});
