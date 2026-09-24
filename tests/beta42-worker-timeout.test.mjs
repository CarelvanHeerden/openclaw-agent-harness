// beta.42 restored: execution failures are bounded by the authority envelope and end terminally.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePrReadiness } from "../dist/control/readiness.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const service = readFileSync(resolve(root, "src/control/service.ts"), "utf8");
const sha = (c, n=64) => c.repeat(n);
const input = { finalVerdict: "pass", blockingFindings: 0, reviewCompleted: true, verificationProbes: { completed: 1, required: 1, indeterminate: 0 }, candidateSha: sha("c",40), publication: { sha: sha("c",40), observedAt: 1 }, pullRequest: { repository: "a/r", baseRef: "main", headSha: sha("c",40), open: true }, expectedRepository: "a/r", expectedBaseRef: "main", requiredCi: { registered: true, requiredChecks: ["test"], successfulChecks: ["test"], sha: sha("c",40), status: "success" }, runtimeEvidence: { status: "pass" }, securityEvidence: { status: "pass" }, elapsedTimeMs: 101, timeLimitMs: 100, changedPaths: ["src/x"], allowedScope: ["src"], excludedScope: [], operationsPerformed: ["test"], allowedOperations: ["test"], credentialRouteDigest: sha("d"), expectedCredentialRouteDigest: sha("d"), secretExposure: { detected: false, evidence: "pass" }, spendUsd: 1, budgetUsd: 2 };

test("beta42: elapsed execution beyond the confirmed limit fails readiness", () => {
  const out = evaluatePrReadiness(input);
  assert.equal(out.ready, false);
  assert.ok(out.failures.includes("elapsed_time_exceeded"));
});

test("beta42: engine throws become a terminal failed run and failed dispatch", () => {
  assert.match(service, /reason:"execution_failed",terminalCode:"execution_failed"/);
  assert.match(service, /SET status='failed',last_error=/);
  assert.match(service, /terminal_summary='The change did not complete\.'/);
});
