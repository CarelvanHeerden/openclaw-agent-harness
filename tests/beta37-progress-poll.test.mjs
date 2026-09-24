// beta.37 restored: polling is retired; harness_change_result returns a safe current/final report.
import test from "node:test";
import assert from "node:assert/strict";
import { buildReadinessReport, buildTerminalReport } from "../dist/control/report.js";

const run = (state) => ({ id: "chg_abcdefghijkl", state, version: 3, requesterId: "U1", conversationId: "C1:T1", repository: "acme/repo", baseRef: "main", briefDigest: "a".repeat(64), policyDigest: "b".repeat(64), authorityEnvelope: {}, createdAt: 1, updatedAt: 2, pullRequestUrl: "https://example.test/pr/7", prompt: "SECRET", clarificationId: "SECRET", subtasks: ["SECRET"] });

test("beta37: ready result is immutable, bounded, and exact about checks", () => {
  const result = buildReadinessReport({ run: run("pr_ready"), checksPassed: 4, checksTotal: 4 });
  assert.deepEqual(result.checks, { passed: 4, total: 4 });
  assert.equal(result.message, "The pull request is ready for review.");
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.checks), true);
});

test("beta37: terminal failure result is terminal rather than resumable interaction state", () => {
  const result = buildTerminalReport({ runId: "chg_abcdefghijkl", state: "failed", code: "execution_failed" });
  assert.deepEqual(result, { kind: "terminal", runId: "chg_abcdefghijkl", state: "failed", code: "execution_failed", message: "The run ended without completing." });
});

test("beta37: result serialization cannot leak interaction internals", () => {
  const serialized = JSON.stringify([buildReadinessReport({ run: run("awaiting_merge"), checksPassed: 2, checksTotal: 3 }), buildTerminalReport({ runId: "chg_abcdefghijkl", state: "cancelled", code: "cancelled_by_requester" })]);
  assert.doesNotMatch(serialized, /SECRET|prompt|clarification|subtasks|worktree|sdk_session/i);
});
