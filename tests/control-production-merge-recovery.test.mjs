import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openStateStoreSync } = await import("../dist/state/store.js");
const { ControlRepository } = await import("../dist/control/repository.js");
const { createAuthorityEnvelope } = await import("../dist/control/authority.js");
const { evaluatePrReadiness } = await import("../dist/control/readiness.js");
const { InternalMergeService, createVerifiedMergeAuthorization } = await import("../dist/control/merge.js");
const { createControlMergeProvider } = await import("../dist/control/github-merge-provider.js");

const sha = (c, n = 40) => c.repeat(n);
const repository = "acme/repo";
const readiness = (head) => ({
  finalVerdict: "pass", blockingFindings: 0, reviewCompleted: true,
  verificationProbes: { completed: 1, required: 1, indeterminate: 0 }, candidateSha: head,
  publication: { sha: head, observedAt: 20 },
  pullRequest: { repository, baseRef: "main", headSha: head, open: true, number: 9, url: "https://example/pr/9" },
  expectedRepository: repository, expectedBaseRef: "main",
  requiredCi: { registered: true, requiredChecks: ["test"], successfulChecks: ["test"], sha: head, status: "success" },
  runtimeEvidence: { status: "pass", sha: head, observedAt: 20 }, securityEvidence: { status: "pass", sha: head, observedAt: 20 },
  elapsedTimeMs: 10, timeLimitMs: 1000, changedPaths: ["src/x.ts"], allowedScope: ["src", "tests"], excludedScope: [],
  operationsPerformed: ["test"], operationReceipts: [{ operation: "test", observedAt: 20, sha: head, source: "fixture" }], allowedOperations: ["test", "commit"],
  credentialRouteDigest: sha("9", 64), expectedCredentialRouteDigest: sha("9", 64), secretExposure: { detected: false, evidence: "pass" }, spendUsd: 1, budgetUsd: 2,
});

function seed(store) {
  const repo = new ControlRepository(store.db);
  const authority = createAuthorityEnvelope({ version: 1, requesterId: "U1", conversationId: "C1", repository, baseRef: "main", briefDigest: sha("a", 64), policyDigest: sha("b", 64), scope: { paths: ["src", "tests"] }, allowedActions: ["implement", "test", "commit", "push_feature_branch", "open_pull_request"], limits: { budgetUsd: 2, activeTimeMs: 1000, cycles: 1, retries: 1 }, issuedAt: 1, expiresAt: 1000, nonce: "n" });
  let run = repo.createRun({ id: "production-merge-recovery", authority, createdAt: 10 });
  run = repo.transition({ runId: run.id, expectedVersion: run.version, to: "awaiting_confirmation", actor: "U1", reason: "prepared", at: 11 });
  run = repo.transition({ runId: run.id, expectedVersion: run.version, to: "autonomous_run", actor: "host", reason: "confirmed", at: 12 });
  run = repo.transition({ runId: run.id, expectedVersion: run.version, to: "pr_ready", actor: "engine", reason: "strict_readiness_passed", pullRequestUrl: "https://example/pr/9", at: 20 });
  const head = sha("c"), input = readiness(head), evaluated = evaluatePrReadiness(input, 20);
  store.db.prepare(`INSERT INTO sessions (id,slack_thread,slack_channel,requester,requester_gh,repo,branch,worktree_path,status,crystallised_prompt,created_at,updated_at,budget_usd,cost_usd,cycles_ran,estimated_usd,hard_timeout_seconds,plan_base_sha,minimum_runtime_version,pr_number,final_pr_url,published_sha,published_at) VALUES (?,?,'',?,?,?,'','','done','{}',?,?,2,1,1,0,1000,?,?,9,?,?,?)`).run(run.id,`control:${run.id}`,"U1","U1",repository,10,20,sha("a"),"2.0.0-rc.13","https://example/pr/9",head,20);
  store.db.prepare(`INSERT INTO control_proposals (run_id,generation,confirmable,base_revision,brief_json,scope_json,excluded_scope_json,credential_route_digest,security_class,assumptions_json,proposal_expires_at,pr_number,pr_url,published_sha,readiness_digest,spend_usd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id,2,1,sha("a"),"{}","[]","[]",sha("9",64),"medium","[]",1000,9,"https://example/pr/9",head,evaluated.contentDigest,1,10,20);
  store.db.prepare(`INSERT INTO control_readiness_attestations (content_digest,run_id,generation,policy_version,ready,verified_sha,input_json,failures_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(evaluated.contentDigest,run.id,2,evaluated.policyVersion,1,head,JSON.stringify(input),"[]",20);
  const auth = createVerifiedMergeAuthorization({ runId: run.id, actorIdentity: "U1", conversationIdentity: "C1", repository, baseRef: "main", prNumber: 9, expectedHeadSha: head, publishedSha: head, readinessDigest: evaluated.contentDigest, nonce: "merge", issuedAt: 30, expiresAt: 1000 });
  return { repo, run, head, auth };
}

test("production control merge provider recovers the exact provider merge SHA after response-persistence crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-merge-recovery-")), path = join(dir, "state.db");
  const first = openStateStoreSync(path), seeded = seed(first);
  const exactMergeSha = sha("e"), unrelatedSha = sha("f");
  let providerMerged = false;
  const provider = createControlMergeProvider({
    db: first.db,
    resolveCredential: async () => ({ route: { apiBase: "https://provider.invalid" }, token: "test-token" }),
    getPullRequest: async () => ({ headSha: seeded.head, state: providerMerged ? "closed" : "open", merged: providerMerged, mergeCommitSha: providerMerged ? exactMergeSha : null, mergeable: true, baseBranch: "main", headRepoFullName: repository, headRef: "feature", draft: false, htmlUrl: "https://example/pr/9" }),
    getCiSnapshot: async () => ({ state: "success", statusReadable: true, checksReadable: true, statusState: "success", statusCount: 1, checkTotal: 1, checkIncomplete: 0, checkFailed: 0, checkPassed: 1, checkNames: ["test"], reason: "", permanentDenial: "", checksSource: "check_runs" }),
    mergePullRequest: async () => { providerMerged = true; return { merged: true, sha: exactMergeSha, message: "merged" }; },
  });
  try {
    const service = new InternalMergeService(first.db, seeded.repo, provider, () => 100);
    service.registerAuthorization(seeded.auth);
    first.db.exec("BEGIN IMMEDIATE");
    first.db.prepare("UPDATE control_engine_merge_intents SET status='merging' WHERE change_id=? AND status='authorized'").run(seeded.run.id);
    first.db.prepare("UPDATE control_merge_authorizations SET consumed_at=100 WHERE id=? AND consumed_at IS NULL").run(seeded.auth.id);
    first.db.exec("COMMIT");
    const mergeResult = await provider.merge({ runId: seeded.run.id, repository, prNumber: 9, expectedHeadSha: seeded.head, idempotencyKey: "crash-window" });
    assert.equal(mergeResult.mergeSha, exactMergeSha);
    first.close();

    const recovered = openStateStoreSync(path);
    try {
      const recoveredProvider = createControlMergeProvider({ db: recovered.db,
        resolveCredential: async () => ({ route: { apiBase: "https://provider.invalid" }, token: "test-token" }),
        getPullRequest: async () => ({ headSha: seeded.head, state: "closed", merged: true, mergeCommitSha: exactMergeSha, mergeable: true, baseBranch: "main", headRepoFullName: repository, headRef: "feature", draft: false, htmlUrl: "https://example/pr/9" }),
        getCiSnapshot: async () => ({ state: "success", statusReadable: true, checksReadable: true, statusState: "success", statusCount: 1, checkTotal: 1, checkIncomplete: 0, checkFailed: 0, checkPassed: 1, checkNames: ["test"], reason: "", permanentDenial: "", checksSource: "check_runs" }),
        mergePullRequest: async () => { throw new Error("recovery must not merge again"); },
      });
      const inspection = await recoveredProvider.inspect({ runId: seeded.run.id, repository, prNumber: 9, readinessDigest: recovered.db.prepare("SELECT readiness_digest FROM control_proposals WHERE run_id=?").get(seeded.run.id).readiness_digest });
      assert.equal(inspection.mergeSha, exactMergeSha);
      assert.notEqual(inspection.mergeSha, unrelatedSha);
      await new InternalMergeService(recovered.db, new ControlRepository(recovered.db), recoveredProvider, () => 101).recoverPending();
      const intent = recovered.db.prepare("SELECT status,provider_merge_sha FROM control_engine_merge_intents WHERE change_id=?").get(seeded.run.id);
      assert.deepEqual({ ...intent }, { status: "merged", provider_merge_sha: exactMergeSha });
    } finally { recovered.close(); }
  } finally { try { first.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

test("recovery rejects tampered persisted authorization before provider access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-auth-binding-")), path = join(dir, "state.db");
  const store = openStateStoreSync(path), seeded = seed(store); let providerCalls = 0;
  const provider = { inspect: async () => { providerCalls++; throw new Error("must not inspect"); }, merge: async () => { providerCalls++; throw new Error("must not merge"); }, verifyMerged: async () => false };
  try {
    const service = new InternalMergeService(store.db, seeded.repo, provider, () => 100);
    service.registerAuthorization(seeded.auth);
    store.db.prepare("UPDATE control_merge_authorizations SET actor_identity='attacker' WHERE id=?").run(seeded.auth.id);
    await service.recoverPending();
    assert.equal(providerCalls, 0);
    assert.equal(store.db.prepare("SELECT status FROM control_engine_merge_intents WHERE change_id=?").get(seeded.run.id).status, "verification_failed");
    assert.equal(seeded.repo.getRun(seeded.run.id).state, "failed");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("recovery rejects a readiness payload whose bytes no longer match its digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-readiness-binding-")), path = join(dir, "state.db");
  const store = openStateStoreSync(path), seeded = seed(store); let providerCalls = 0;
  const provider = { inspect: async () => { providerCalls++; throw new Error("must not inspect"); }, merge: async () => { providerCalls++; throw new Error("must not merge"); }, verifyMerged: async () => false };
  try {
    const service = new InternalMergeService(store.db, seeded.repo, provider, () => 100);
    service.registerAuthorization(seeded.auth);
    const row = store.db.prepare("SELECT input_json FROM control_readiness_attestations WHERE run_id=?").get(seeded.run.id);
    const input = JSON.parse(row.input_json); input.budgetUsd = 999;
    store.db.prepare("UPDATE control_readiness_attestations SET input_json=? WHERE run_id=?").run(JSON.stringify(input), seeded.run.id);
    await service.recoverPending();
    assert.equal(providerCalls, 0);
    assert.equal(store.db.prepare("SELECT status FROM control_engine_merge_intents WHERE change_id=?").get(seeded.run.id).status, "verification_failed");
    assert.equal(seeded.repo.getRun(seeded.run.id).state, "failed");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
