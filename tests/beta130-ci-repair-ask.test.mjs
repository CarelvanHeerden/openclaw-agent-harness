// Restored beta.130 coverage, translated to the canonical autonomous control plane.
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorityEnvelope, evaluateAuthority } from "../dist/control/authority.js";
import { decideEngineAuthority } from "../dist/control/engine.js";

const sha = (c) => c.repeat(64);
const envelope = createAuthorityEnvelope({
  version: 1, requesterId: "U1", conversationId: "C1:T1", repository: "acme/repo", baseRef: "main",
  briefDigest: sha("a"), policyDigest: sha("b"), scope: { paths: ["src", "tests"] },
  allowedActions: ["implement", "retry", "repair", "test", "commit", "push_feature_branch", "open_pull_request", "update_pull_request"],
  limits: { budgetUsd: 40, activeTimeMs: 3_600_000, cycles: 3, retries: 2 }, issuedAt: 1, expiresAt: 9_999, nonce: "n1",
});
const request = (over = {}) => ({
  requesterId: "U1", conversationId: "C1:T1", repository: "acme/repo", baseRef: "main",
  briefDigest: sha("a"), policyDigest: sha("b"), nonce: "n1", action: "repair", paths: ["src/sidebar.ts"],
  projectedBudgetUsd: 12, projectedActiveTimeMs: 1_000_000, projectedCycles: 2, projectedRetries: 1, now: 100, ...over,
});

test("beta130: an in-envelope CI repair continues autonomously without an interaction ask", () => {
  assert.deepEqual(evaluateAuthority(envelope, request()), { outcome: "approve", reason: "in_envelope" });
  const run = { state: "autonomous_run", authorityEnvelope: envelope };
  assert.deepEqual(decideEngineAuthority(run, { kind: "repair", request: request() }), {
    outcome: "continue", kind: "repair", auditCode: "autonomous_in_envelope",
  });
});

test("beta130: time or budget expansion is a terminal authority failure", () => {
  assert.deepEqual(evaluateAuthority(envelope, request({ projectedActiveTimeMs: 3_600_001 })), { outcome: "terminate", reason: "time_expansion" });
  assert.deepEqual(evaluateAuthority(envelope, request({ projectedBudgetUsd: 40.01 })), { outcome: "terminate", reason: "budget_expansion" });
});
