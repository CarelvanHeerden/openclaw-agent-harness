import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openStateStoreSync } = await import("../dist/state/store.js");
const { ControlRepository } = await import("../dist/control/repository.js");
const { AutonomousControlEngine, decideEngineAuthority } = await import("../dist/control/engine.js");
const { evaluatePrReadiness } = await import("../dist/control/readiness.js");
const { createAuthorityEnvelope } = await import("../dist/control/authority.js");
const { InternalMergeService, createVerifiedMergeAuthorization } = await import("../dist/control/merge.js");

const sha = (c, n = 64) => c.repeat(n);
const authority = () => createAuthorityEnvelope({
  version: 1, requesterId: "U1", conversationId: "C1:T1", repository: "acme/repo", baseRef: "main",
  briefDigest: sha("a"), policyDigest: sha("b"), scope: { paths: ["src", "tests"] },
  allowedActions: ["implement", "retry", "repair", "test", "commit", "push_feature_branch", "open_pull_request", "update_pull_request"],
  limits: { budgetUsd: 20, activeTimeMs: 1000, cycles: 3, retries: 2 }, issuedAt: 1, expiresAt: 10_000, nonce: "n1",
});
const request = (overrides = {}) => ({
  requesterId: "U1", conversationId: "C1:T1", repository: "acme/repo", baseRef: "main",
  briefDigest: sha("a"), policyDigest: sha("b"), nonce: "n1", action: "repair", paths: ["src/x.ts"],
  projectedBudgetUsd: 10, projectedActiveTimeMs: 500, projectedCycles: 2, projectedRetries: 1, now: 100,
  ...overrides,
});
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "engine-v2-"));
  const store = openStateStoreSync(join(dir, "state.db"));
  return Promise.resolve(fn(store)).finally(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
}
function autonomous(repo, id = "r1") {
  let run = repo.createRun({ id, authority: authority(), createdAt: 10 });
  run = repo.transition({ runId: id, expectedVersion: run.version, to: "awaiting_confirmation", actor: "U1", reason: "prepared", at: 11 });
  return repo.transition({ runId: id, expectedVersion: run.version, to: "autonomous_run", actor: "host", reason: "confirmed", at: 12 });
}
function readyInput(overrides = {}) {
  const head = sha("c", 40);
  return {
    finalVerdict: "pass", blockingFindings: 0, reviewCompleted: true,
    verificationProbes: { completed: 3, required: 3, indeterminate: 0 }, candidateSha: head,
    publication: { sha: head, observedAt: 50 },
    pullRequest: { repository: "acme/repo", baseRef: "main", headSha: head, open: true },
    expectedRepository: "acme/repo", expectedBaseRef: "main",
    requiredCi: { registered: true, requiredChecks: ["test"], successfulChecks: ["test"], sha: head, status: "success" },
    runtimeEvidence: { status: "pass", sha: head, observedAt: 50 }, securityEvidence: { status: "pass", sha: head, observedAt: 50 },
    elapsedTimeMs: 500, timeLimitMs: 1000,
    changedPaths: ["src/x.ts"], allowedScope: ["src", "tests"], excludedScope: [],
    operationsPerformed: ["test"], operationReceipts: [{ operation: "test", observedAt: 50, source: "test-fixture" }], allowedOperations: ["test", "commit"],
    credentialRouteDigest: sha("9"), expectedCredentialRouteDigest: sha("9"),
    secretExposure: { detected: false, evidence: "pass" }, spendUsd: 12, budgetUsd: 20,
    ...overrides,
  };
}

test("autonomous authority continues safe choices and terminally maps expansion", async () => withStore(({ db }) => {
  const repo = new ControlRepository(db); const run = autonomous(repo);
  assert.deepEqual(decideEngineAuthority(run, { kind: "repair", request: request() }), { outcome: "continue", kind: "repair", auditCode: "autonomous_in_envelope" });
  assert.deepEqual(decideEngineAuthority(run, { kind: "retry", request: request({ projectedBudgetUsd: 21 }) }), { outcome: "terminate", code: "budget_exceeded", reason: "budget_expansion" });
  const engine = new AutonomousControlEngine({ repository: repo, ownerId: "worker", leaseTtlMs: 1000, now: () => 100 });
  const lease = engine.acquire(run.id);
  const ended = engine.decide(run.id, lease, { kind: "repair", request: request({ paths: ["docs/outside.md"] }) });
  assert.equal(ended.outcome, "terminate");
  assert.equal(repo.getRun(run.id).state, "failed");
}));

test("strict readiness rejects every indeterminate or stale signal", () => {
  assert.equal(evaluatePrReadiness(readyInput(), 99).ready, true);
  const bad = evaluatePrReadiness(readyInput({
    finalVerdict: "crashed", blockingFindings: 1, reviewCompleted: false,
    publication: { sha: sha("d", 40), observedAt: 50 },
    requiredCi: { registered: false, requiredChecks: [], successfulChecks: [], sha: sha("d", 40), status: "pending" },
    runtimeEvidence: { status: "indeterminate" }, securityEvidence: { status: "fail" }, spendUsd: 21,
  }));
  assert.equal(bad.ready, false);
  for (const code of ["review_not_passed", "review_crash", "blocking_findings", "stale_publication", "required_ci_unregistered", "required_ci_not_green", "runtime_evidence_indeterminate", "security_evidence_failed", "spend_exceeded"]) assert.ok(bad.failures.includes(code), code);
});

test("fenced checkpoints reject stale lease generations", async () => withStore(({ db }) => {
  const repo = new ControlRepository(db); const run = autonomous(repo);
  const engine = new AutonomousControlEngine({ repository: repo, ownerId: "a", leaseTtlMs: 10, now: () => 100 });
  const first = engine.acquire(run.id);
  engine.checkpoint(run.id, first, sha("e", 40), sha("f"));
  const second = repo.acquireLease(run.id, "b", 10, 111, first.authorityHash);
  assert.equal(repo.validateLease(first, 112), false);
  assert.equal(repo.validateLease(second, 112), true);
  assert.throws(() => repo.writeVerifiedCheckpoint(run.id, first, sha("e", 40), sha("a"), 112), /stale_write/);
}));

test("merge authorization is one-time and exact-head gated", async () => withStore(async ({ db }) => {
  const repo = new ControlRepository(db); let run = autonomous(repo);
  run = repo.transition({ runId: run.id, expectedVersion: run.version, to: "pr_ready", actor: "engine", reason: "strict_readiness_passed", pullRequestUrl: "https://example/pr/1", at: 20 });
  const head = sha("c", 40); let mergeCalls = 0;
  const provider = {
    inspect: async () => ({ repository: "acme/repo", baseRef: "main", prNumber: 1, headSha: head, open: true, merged: false, readiness: readyInput() }),
    merge: async () => { mergeCalls++; return { mergeSha: sha("d", 40) }; },
    verifyMerged: async () => true,
  };
  const service = new InternalMergeService(db, repo, provider, () => 100);
  const readiness = readyInput();
  const evaluated = evaluatePrReadiness(readiness, 20);
  db.prepare(`INSERT INTO control_proposals (run_id,generation,confirmable,base_revision,brief_json,scope_json,excluded_scope_json,credential_route_digest,security_class,assumptions_json,proposal_expires_at,pr_number,pr_url,published_sha,readiness_digest,spend_usd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id,2,1,sha("a",40),"{}","[]","[]",sha("9"),"medium","[]",1000,1,"https://example/pr/1",head,evaluated.contentDigest,12,10,20);
  db.prepare(`INSERT INTO control_readiness_attestations (content_digest,run_id,generation,policy_version,ready,verified_sha,input_json,failures_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(evaluated.contentDigest,run.id,2,evaluated.policyVersion,1,head,JSON.stringify(readiness),"[]",20);
  const auth = createVerifiedMergeAuthorization({ runId: run.id, actorIdentity: "U1", conversationIdentity: "C1:T1", repository: "acme/repo", baseRef: "main", prNumber: 1, expectedHeadSha: head, publishedSha: head, readinessDigest: evaluated.contentDigest, nonce: "merge-nonce", issuedAt: 50, expiresAt: 200 });
  service.registerAuthorization(auth);
  assert.equal((await service.merge(auth.id)).status, "merged");
  assert.equal((await service.merge(auth.id)).status, "already_merged");
  assert.equal(mergeCalls, 1);
  assert.equal(repo.getRun(run.id).state, "done");
}));

test("ambiguous provider success is reconciled without a second merge side effect", async () => withStore(async ({ db }) => {
  const repo = new ControlRepository(db); let run = autonomous(repo, "merge-recovery");
  run = repo.transition({ runId: run.id, expectedVersion: run.version, to: "pr_ready", actor: "engine", reason: "strict_readiness_passed", pullRequestUrl: "https://example/pr/2", at: 20 });
  const head = sha("c", 40), mergeSha = sha("e", 40); let mergeCalls = 0, providerMerged = false;
  const readiness = readyInput(); const evaluated = evaluatePrReadiness(readiness, 20);
  db.prepare(`INSERT INTO control_proposals (run_id,generation,confirmable,base_revision,brief_json,scope_json,excluded_scope_json,credential_route_digest,security_class,assumptions_json,proposal_expires_at,pr_number,pr_url,published_sha,readiness_digest,spend_usd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id,2,1,sha("a",40),"{}","[]","[]",sha("9"),"medium","[]",1000,2,"https://example/pr/2",head,evaluated.contentDigest,12,10,20);
  db.prepare(`INSERT INTO control_readiness_attestations (content_digest,run_id,generation,policy_version,ready,verified_sha,input_json,failures_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(evaluated.contentDigest,run.id,2,evaluated.policyVersion,1,head,JSON.stringify(readiness),"[]",20);
  const provider = {
    inspect: async () => ({ repository: "acme/repo", baseRef: "main", prNumber: 2, headSha: head, open: !providerMerged, merged: providerMerged, ...(providerMerged ? { mergeSha } : {}), readiness }),
    merge: async () => { mergeCalls++; providerMerged = true; throw new Error("connection lost after provider accepted merge"); },
    verifyMerged: async ({ mergeSha: candidate }) => providerMerged && candidate === mergeSha,
  };
  const service = new InternalMergeService(db, repo, provider, () => 100);
  const auth1 = createVerifiedMergeAuthorization({ runId: run.id, actorIdentity: "U1", conversationIdentity: "C1:T1", repository: "acme/repo", baseRef: "main", prNumber: 2, expectedHeadSha: head, publishedSha: head, readinessDigest: evaluated.contentDigest, nonce: "merge-crash-1", issuedAt: 50, expiresAt: 200 });
  service.registerAuthorization(auth1);
  assert.deepEqual(await service.merge(auth1.id), { status: "merge_failed", code: "provider_failure" });
  const auth2 = createVerifiedMergeAuthorization({ runId: run.id, actorIdentity: "U1", conversationIdentity: "C1:T1", repository: "acme/repo", baseRef: "main", prNumber: 2, expectedHeadSha: head, publishedSha: head, readinessDigest: evaluated.contentDigest, nonce: "merge-crash-2", issuedAt: 60, expiresAt: 200 });
  service.registerAuthorization(auth2);
  assert.deepEqual(await service.merge(auth2.id), { status: "already_merged", mergeSha });
  assert.equal(mergeCalls, 1);
  assert.equal(repo.getRun(run.id).state, "done");
  assert.equal(db.prepare("SELECT status FROM control_engine_merge_intents WHERE change_id=?").get(run.id).status, "merged");
}));

test("recovery scans only autonomous runs and preserves the confirmed authority hash", async () => withStore(async (store) => {
  const { recoverAutonomousControlRuns } = await import("../dist/state/recovery.js");
  const repo = new ControlRepository(store.db);
  const run = autonomous(repo, "recover-me");
  const draft = repo.createRun({ id: "draft-run", authority: authority() });
  let seen;
  const result = await recoverAutonomousControlRuns(repo, store, {
    ownerId: "recovery-owner", leaseTtlMs: 1000, now: 100,
    resume: async (candidate, lease) => { seen = { candidate, lease }; },
    logger: { info() {}, warn() {} },
  });
  assert.deepEqual(result, { resumed: 1, leasedElsewhere: 0, rejected: 0 });
  assert.equal(seen.candidate.runId, run.id);
  assert.equal(seen.lease.authorityHash, seen.candidate.authorityHash);
  assert.equal(repo.getRun(draft.id).state, "draft");
}));

test("runtime handles fence writes from superseded plugin generations", async () => {
  const registry = await import("../dist/runtime-registry.js");
  const first = { state: { db: {}, isOpen: () => true } };
  const second = { state: { db: {}, isOpen: () => true } };
  registry.setCurrentRuntime(first);
  const handle = registry.getCurrentRuntimeHandle();
  assert.equal(registry.isCurrentRuntimeHandle(handle), true);
  registry.setCurrentRuntime(second);
  assert.equal(registry.isCurrentRuntimeHandle(handle), false);
  assert.throws(() => registry.assertCurrentRuntimeHandle(handle), /stale_runtime_generation/);
  registry.setCurrentRuntime(null);
});

test("worktree heal protects durable autonomous worktrees", async () => withStore(async (store) => {
  const { healOrphanedWorktrees } = await import("../dist/state/worktree-heal.js");
  const path = "/tmp/pending-123"; let releases = 0;
  const result = await healOrphanedWorktrees(store, {
    listWorktreeDirs: async () => [path],
    releaseByPath: async () => { releases++; return { ok: true, path }; },
    protectedAutonomousWorktreePaths: [path],
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(result.protected_running, 1);
  assert.equal(releases, 0);
}));
