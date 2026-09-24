import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const stateMachine = await import("../dist/control/state-machine.js");
const authority = await import("../dist/control/authority.js");
const reports = await import("../dist/control/report.js");
const { ControlRepository } = await import("../dist/control/repository.js");
const { applyStateMigrations, STATE_MIGRATIONS } = await import("../dist/state/migrations.js");
const { openStateStoreSync } = await import("../dist/state/store.js");

const sha = (character) => character.repeat(64);
const makeEnvelope = (overrides = {}) => authority.createAuthorityEnvelope({
  version: 1,
  requesterId: "U123",
  conversationId: "C1:T1",
  repository: "acme/widget",
  baseRef: "main",
  briefDigest: sha("a"),
  policyDigest: sha("b"),
  scope: { paths: ["src/control", "tests/control-foundation.test.mjs"] },
  allowedActions: ["implement", "retry", "repair", "test", "commit", "push_feature_branch", "open_pull_request", "update_pull_request"],
  limits: { budgetUsd: 20, activeTimeMs: 3_600_000, cycles: 3, retries: 2 },
  issuedAt: 1_000,
  expiresAt: 10_000,
  nonce: "nonce-1",
  ...overrides,
});
const makeRequest = (overrides = {}) => ({
  requesterId: "U123",
  conversationId: "C1:T1",
  repository: "acme/widget",
  baseRef: "main",
  briefDigest: sha("a"),
  policyDigest: sha("b"),
  nonce: "nonce-1",
  action: "repair",
  paths: ["src/control/authority.ts"],
  projectedBudgetUsd: 12,
  projectedActiveTimeMs: 100_000,
  projectedCycles: 2,
  projectedRetries: 1,
  now: 2_000,
  ...overrides,
});

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "control-foundation-"));
  const store = openStateStoreSync(join(dir, "state.db"));
  try { return fn(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("control state machine exposes only the declared strict transitions", () => {
  const valid = [
    ["draft", "awaiting_confirmation"],
    ["awaiting_confirmation", "autonomous_run"],
    ["autonomous_run", "pr_ready"],
    ["pr_ready", "awaiting_merge"],
    ["awaiting_merge", "done"],
    ["pr_ready", "autonomous_run"],
  ];
  for (const [from, to] of valid) assert.equal(stateMachine.canTransitionControlState(from, to), true, `${from} -> ${to}`);
  for (const terminal of ["done", "failed", "cancelled"]) {
    assert.equal(stateMachine.isTerminalControlState(terminal), true);
    assert.deepEqual(stateMachine.allowedControlTransitions(terminal), []);
    assert.throws(() => stateMachine.assertControlTransition(terminal, "draft"), stateMachine.InvalidControlTransitionError);
  }
  assert.equal(stateMachine.canTransitionControlState("draft", "done"), false);
  assert.equal(stateMachine.canTransitionControlState("awaiting_merge", "autonomous_run"), false);
});

test("repository creates immutable history and enforces strict CAS", () => withStore(({ db }) => {
  const repo = new ControlRepository(db);
  const created = repo.createRun({ id: "run-1", authority: makeEnvelope(), createdAt: 2_000 });
  assert.equal(created.state, "draft");
  assert.equal(created.version, 0);
  const confirmed = repo.transition({ runId: created.id, expectedVersion: 0, to: "awaiting_confirmation", actor: "U123", reason: "brief proposed", at: 2_100 });
  assert.equal(confirmed.version, 1);
  assert.throws(() => repo.transition({ runId: created.id, expectedVersion: 0, to: "cancelled", actor: "U123", reason: "stale" }), stateMachine.ControlCasConflictError);
  assert.throws(() => repo.transition({ runId: created.id, expectedVersion: 1, to: "done", actor: "system", reason: "skip" }), stateMachine.InvalidControlTransitionError);
  assert.deepEqual(repo.listStateEvents(created.id).map((e) => [e.fromState, e.toState, e.fromVersion, e.toVersion]), [
    [null, "draft", null, 0],
    ["draft", "awaiting_confirmation", 0, 1],
  ]);
}));

test("authority envelopes are deeply immutable and reject unsafe construction", () => {
  const envelope = makeEnvelope();
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.scope), true);
  assert.equal(Object.isFrozen(envelope.scope.paths), true);
  assert.equal(Object.isFrozen(envelope.allowedActions), true);
  assert.equal(Object.isFrozen(envelope.limits), true);
  assert.throws(() => makeEnvelope({ allowedActions: ["merge"] }), /unsafe action/);
  assert.throws(() => makeEnvelope({ scope: { paths: ["../secrets"] } }), /scope paths/);
});

test("authority approves in-envelope implementation, retries, repairs, and declared deployments", () => {
  for (const action of ["implement", "retry", "repair"]) {
    assert.deepEqual(authority.evaluateAuthority(makeEnvelope(), makeRequest({ action })), { outcome: "approve", reason: "in_envelope" });
  }
  const deploymentEnvelope = makeEnvelope({ allowedActions: ["deploy"] });
  assert.deepEqual(authority.evaluateAuthority(deploymentEnvelope, makeRequest({ action: "deploy", deploymentDeclared: true })), { outcome: "approve", reason: "in_envelope" });
});

test("authority terminates deterministic binding, expansion, and prohibited-action failures", () => {
  const cases = [
    [{ requesterId: "U999" }, "identity_mismatch"],
    [{ conversationId: "other" }, "conversation_mismatch"],
    [{ repository: "acme/other" }, "repository_mismatch"],
    [{ baseRef: "release" }, "base_ref_mismatch"],
    [{ briefDigest: sha("c") }, "brief_digest_mismatch"],
    [{ policyDigest: sha("d") }, "policy_digest_mismatch"],
    [{ paths: ["src/index.ts"] }, "path_out_of_scope"],
    [{ projectedBudgetUsd: 21 }, "budget_expansion"],
    [{ projectedActiveTimeMs: 3_600_001 }, "time_expansion"],
    [{ projectedCycles: 4 }, "cycle_expansion"],
    [{ projectedRetries: 3 }, "retry_expansion"],
    [{ securityBypass: true }, "security_expansion"],
    [{ credentialChange: true }, "credential_change"],
    [{ irreversibleSideEffect: true }, "irreversible_side_effect"],
    [{ action: "merge_pull_request" }, "action_not_allowed"],
    [{ action: "push_feature_branch", targetRef: "main" }, "default_branch_push"],
    [{ action: "deploy", deploymentDeclared: false }, "undeclared_deployment"],
    [{ now: 10_001 }, "expired"],
  ];
  for (const [change, reason] of cases) {
    assert.deepEqual(authority.evaluateAuthority(makeEnvelope(), makeRequest(change)), { outcome: "terminate", reason }, reason);
  }
});

test("authority nonce consumption is single-use and replay safe", () => withStore(({ db }) => {
  const repo = new ControlRepository(db);
  const envelope = makeEnvelope();
  assert.equal(authority.evaluateAuthority(envelope, makeRequest(), repo).outcome, "approve");
  assert.deepEqual(authority.evaluateAuthority(envelope, makeRequest(), repo), { outcome: "terminate", reason: "replay" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM automation_decisions").get().n, 1);
}));

test("readiness and terminal reports whitelist user-safe fields and freeze output", () => {
  const run = {
    id: "run-report", state: "pr_ready", version: 3, requesterId: "U123", conversationId: "C1:T1",
    repository: "acme/widget", baseRef: "main", briefDigest: sha("a"), policyDigest: sha("b"),
    authorityEnvelope: makeEnvelope(), createdAt: 1, updatedAt: 2, pullRequestUrl: "https://example.test/pr/1",
    prompt: "SECRET PROMPT", clarificationId: "secret", subtasks: ["secret"], retries: ["secret"], harnessCommand: "secret",
  };
  const ready = reports.buildReadinessReport({ run, checksPassed: 4, checksTotal: 4, prompt: "leak" });
  const terminal = reports.buildTerminalReport({ runId: run.id, state: "failed", code: "verification_failed", prompt: "leak", clarificationId: "leak" });
  const serialized = JSON.stringify([ready, terminal]);
  for (const forbidden of ["SECRET PROMPT", "clarificationId", "subtasks", "retries", "harnessCommand", "prompt"]) assert.equal(serialized.includes(forbidden), false);
  assert.equal(Object.isFrozen(ready), true);
  assert.equal(Object.isFrozen(ready.checks), true);
  assert.equal(Object.isFrozen(terminal), true);
});

test("migration ledger applies control schema transactionally and idempotently", () => {
  const db = new DatabaseSync(":memory:");
  applyStateMigrations(db);
  applyStateMigrations(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM migration_ledger").get().n, STATE_MIGRATIONS.length);
  for (const table of ["control_runs", "control_state_events", "automation_decisions", "run_leases"]) {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table).n, 1);
  }
  assert.throws(() => applyStateMigrations(db, [{ id: "broken", sql: "CREATE TABLE should_rollback(id); THIS IS NOT SQL;" }]));
  assert.equal(db.prepare("SELECT count(*) AS n FROM migration_ledger WHERE id='broken'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='should_rollback'").get().n, 0);
  db.close();
});

test("merge-intent recovery migration preserves existing one-use intents atomically", () => {
  const db = new DatabaseSync(":memory:");
  applyStateMigrations(db, STATE_MIGRATIONS.slice(0, 3));
  const repo = new ControlRepository(db);
  let run = repo.createRun({ id: "migration-intent", authority: makeEnvelope(), createdAt: 1 });
  run = repo.transition({ runId: run.id, expectedVersion: run.version, to: "awaiting_confirmation", actor: "test", reason: "prepared", at: 2 });
  run = repo.transition({ runId: run.id, expectedVersion: run.version, to: "autonomous_run", actor: "test", reason: "confirmed", at: 3 });
  run = repo.transition({ runId: run.id, expectedVersion: run.version, to: "pr_ready", actor: "test", reason: "ready", at: 4 });
  const migrationHead = sha("c",40), migrationReadiness = "readiness-migration";
  db.prepare(`INSERT INTO control_proposals (run_id,generation,confirmable,base_revision,brief_json,scope_json,excluded_scope_json,credential_route_digest,security_class,assumptions_json,proposal_expires_at,pr_number,published_sha,readiness_digest,created_at,updated_at) VALUES (?,1,1,?,'{}','[]','[]',?,'medium','[]',500,1,?,?,1,4)`).run(run.id,sha("a",40),sha("9",64),migrationHead,migrationReadiness);
  db.prepare(`INSERT INTO control_readiness_attestations (content_digest,run_id,generation,policy_version,ready,verified_sha,input_json,failures_json,created_at) VALUES (?,?,1,'control-readiness/v2',1,?,'{}','[]',4)`).run(migrationReadiness,run.id,migrationHead);
  db.prepare(`INSERT INTO control_merge_authorizations (id,run_id,actor_identity,conversation_identity,repository_identity,base_ref,pr_number,expected_head_sha,binding_digest,nonce,issued_at,expires_at,consumed_at) VALUES ('auth-migration',?,'U123','C1:T1','acme/widget','main',1,?,'digest','nonce',5,500,NULL)`).run(run.id, sha("c",40));
  db.prepare(`INSERT INTO control_engine_merge_intents (id,change_id,authorization_id,expected_head_sha,merge_provider_idempotency,status,created_at,updated_at) VALUES ('intent-migration',?,'auth-migration',?,'key-migration','authorized',5,5)`).run(run.id, sha("c",40));
  applyStateMigrations(db);
  assert.deepEqual({ ...db.prepare(`SELECT id,authorization_id,status FROM control_engine_merge_intents WHERE id='intent-migration'`).get() }, { id: "intent-migration", authorization_id: "auth-migration", status: "authorized" });
  assert.equal(db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='control_security_receipts'`).get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM migration_ledger").get().n, STATE_MIGRATIONS.length);
  db.close();
});

test("store migration is backward-compatible with legacy session columns", () => withStore(({ db }) => {
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
  for (const legacy of ["crystallised_prompt", "lead_plan_json", "clarification_id", "published_sha"]) assert.ok(sessionColumns.includes(legacy));
  assert.equal(db.prepare("SELECT count(*) AS n FROM migration_ledger").get().n, STATE_MIGRATIONS.length);
}));

test("run leases use monotonically increasing fences and reject stale owners", () => withStore(({ db }) => {
  const repo = new ControlRepository(db);
  repo.createRun({ id: "leased", authority: makeEnvelope() });
  const first = repo.acquireLease("leased", "worker-a", 100, 1_000);
  assert.equal(first.fence, 1);
  assert.equal(repo.acquireLease("leased", "worker-b", 100, 1_050), null);
  assert.equal(repo.renewLease("leased", "worker-a", first.fence, 100, 1_050), true);
  const second = repo.acquireLease("leased", "worker-b", 100, 1_151);
  assert.equal(second.fence, 2);
  assert.equal(repo.renewLease("leased", "worker-a", first.fence, 100, 1_152), false);
  assert.equal(repo.releaseLease("leased", "worker-a", first.fence, 1_153), false);
  assert.equal(repo.releaseLease("leased", "worker-b", second.fence, 1_154), true);
  const third = repo.acquireLease("leased", "worker-a", 100, 1_155);
  assert.equal(third.fence, 3);
}));

test("merge storage rejects cross-run PR collisions while allowing equal readiness digests per run", () => {
  const db = new DatabaseSync(":memory:");
  applyStateMigrations(db);
  const repo = new ControlRepository(db);
  const create = (id, requester) => {
    const base = makeEnvelope();
    const authority = { ...base, requesterId: requester, nonce: `nonce-${id}` };
    let run = repo.createRun({ id, authority, createdAt: 10 });
    run = repo.transition({ runId: id, expectedVersion: run.version, to: "awaiting_confirmation", actor: requester, reason: "prepared", at: 11 });
    run = repo.transition({ runId: id, expectedVersion: run.version, to: "autonomous_run", actor: requester, reason: "confirmed", at: 12 });
    run = repo.transition({ runId: id, expectedVersion: run.version, to: "pr_ready", actor: requester, reason: "ready", at: 13 });
    const head=sha("d",40), digest="shared-readiness";
    db.prepare(`INSERT INTO control_proposals (run_id,generation,confirmable,base_revision,brief_json,scope_json,excluded_scope_json,credential_route_digest,security_class,assumptions_json,proposal_expires_at,pr_number,published_sha,readiness_digest,created_at,updated_at) VALUES (?,1,1,?,'{}','[]','[]',?,'medium','[]',500,7,?,?,10,13)`).run(id,sha("a",40),sha("9",64),head,digest);
    db.prepare(`INSERT INTO control_readiness_attestations (content_digest,run_id,generation,policy_version,ready,verified_sha,input_json,failures_json,created_at) VALUES (?,?,1,'control-readiness/v2',1,?,'{}','[]',13)`).run(digest,id,head);
    return { run, head, digest };
  };
  const a=create("collision-a","U-A"), b=create("collision-b","U-B");
  assert.equal(db.prepare(`SELECT count(*) n FROM control_readiness_attestations WHERE content_digest='shared-readiness'`).get().n,2);
  db.prepare(`INSERT INTO control_merge_authorizations (id,run_id,actor_identity,conversation_identity,repository_identity,base_ref,pr_number,expected_head_sha,readiness_digest,binding_digest,nonce,issued_at,expires_at) VALUES ('auth-a',?,'U-A','C','acme/widget','main',7,?,?,'binding-a','merge-a',20,500)`).run(a.run.id,a.head,a.digest);
  assert.throws(()=>db.prepare(`INSERT INTO control_merge_authorizations (id,run_id,actor_identity,conversation_identity,repository_identity,base_ref,pr_number,expected_head_sha,readiness_digest,binding_digest,nonce,issued_at,expires_at) VALUES ('auth-b',?,'U-B','C','acme/widget','main',7,?,?,'binding-b','merge-b',20,500)`).run(b.run.id,b.head,b.digest),/UNIQUE constraint/i);
  assert.throws(()=>db.prepare(`INSERT INTO control_engine_merge_intents (id,change_id,authorization_id,expected_head_sha,merge_provider_idempotency,status,created_at,updated_at) VALUES ('bad-intent',?,'auth-a',?,'bad-key','authorized',20,20)`).run(b.run.id,a.head),/FOREIGN KEY constraint/i);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  db.close();
});
