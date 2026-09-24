// Restored beta.135 safety regressions on the canonical readiness/result boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { proposeDirectoryRescue, rescueMatchesContractPath } from "../dist/orchestrator/basename-rescue.js";
import { evaluatePrReadiness } from "../dist/control/readiness.js";
import { buildTerminalReport } from "../dist/control/report.js";
const sha = (c, n = 64) => c.repeat(n);
const ready = (over = {}) => ({ finalVerdict: "pass", blockingFindings: 0, reviewCompleted: true, verificationProbes: { completed: 2, required: 2, indeterminate: 0 }, candidateSha: sha("c",40), publication: { sha: sha("c",40), observedAt: 5 }, pullRequest: { repository: "acme/repo", baseRef: "main", headSha: sha("c",40), open: true }, expectedRepository: "acme/repo", expectedBaseRef: "main", requiredCi: { registered: true, requiredChecks: ["test"], successfulChecks: ["test"], sha: sha("c",40), status: "success" }, runtimeEvidence: { status: "pass" }, securityEvidence: { status: "pass" }, elapsedTimeMs: 10, timeLimitMs: 100, changedPaths: ["prisma/migrations/x/migration.sql"], allowedScope: ["prisma/migrations"], excludedScope: [], operationsPerformed: ["test"], allowedOperations: ["test"], credentialRouteDigest: sha("d"), expectedCredentialRouteDigest: sha("d"), secretExposure: { detected: false, evidence: "pass" }, spendUsd: 1, budgetUsd: 2, ...over });

test("beta135: trailing slash still matches a normalized directory rescue", () => {
  const r = proposeDirectoryRescue({ expected: ["prisma/migrations/"], actual: ["prisma/schema.prisma", "prisma/migrations/20260902_drive/migration.sql"] });
  assert.ok(r); assert.equal(r.from, "prisma/migrations"); assert.equal(rescueMatchesContractPath("prisma/migrations/", r), true);
});

test("beta135: exact-head readiness accepts the safe migration and rejects unrelated scope", () => {
  assert.equal(evaluatePrReadiness(ready()).ready, true);
  const bad = evaluatePrReadiness(ready({ changedPaths: ["src/unrelated.ts"] }));
  assert.equal(bad.ready, false); assert.ok(bad.failures.includes("scope_exceeded"));
});

test("beta135: terminal results expose only a safe stable envelope", () => {
  const result = buildTerminalReport({ runId: "chg_safe", state: "failed", code: "verification_failed", prompt: "secret", clarificationId: "secret" });
  assert.deepEqual(Object.keys(result).sort(), ["code", "kind", "message", "runId", "state"]);
  assert.doesNotMatch(JSON.stringify(result), /secret|prompt|clarification/i);
  assert.equal(Object.isFrozen(result), true);
});
