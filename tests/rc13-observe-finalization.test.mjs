import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-acp-agent.mjs");

const {
  OBSERVE_ACP_MAX_STEPS,
  runObserveWorkerAcp,
} = await import("../dist/adapters/acp.js");
const { buildOpenCodeConfig, openCodeConfigEnv } = await import("../dist/adapters/opencode-config.js");
const { buildAcpGuard } = await import("../dist/safety/bash-guard.js");
const { observeProtocolRetryAllowed } = await import("../dist/orchestrator/loop.js");

const guard = buildAcpGuard({
  bash_whitelist: ["git", "cat"],
  bash_denylist_tokens: ["sudo", "rm"],
  path_denylist: [".env"],
  allow_git_push: false,
  allow_network_commands: false,
});

function agent(scenario, { toolless = false, maxSteps = OBSERVE_ACP_MAX_STEPS } = {}) {
  return {
    command: process.execPath,
    args: [FAKE],
    env: {
      FAKE_ACP_SCENARIO: scenario,
      ...openCodeConfigEnv({ toolless, maxSteps }),
    },
  };
}

function run(scenario) {
  return runObserveWorkerAcp({
    initial: {
      agent: agent(scenario),
      worktreePath: tmpdir(),
      systemPrompt: "Return OBSERVE_RESULT after inspecting the repository.",
      userMessage: "Inspect the repository.",
      model: "",
      timeoutSeconds: 10,
      streamOpenTimeoutSeconds: 2,
      firstTokenTimeoutSeconds: 2,
      acpGuard: guard,
    },
    finalizerAgent: agent(scenario, { toolless: true, maxSteps: 1 }),
    finalizerTimeoutSeconds: 5,
  });
}

test("rc13 observe: OpenCode config applies an explicit finite build-agent step budget", () => {
  const bounded = buildOpenCodeConfig({ maxSteps: OBSERVE_ACP_MAX_STEPS });
  assert.equal(bounded.agent.build.steps, OBSERVE_ACP_MAX_STEPS);

  const finalizer = buildOpenCodeConfig({ toolless: true, maxSteps: 1 });
  assert.equal(finalizer.agent.build.steps, 1);
  assert.ok(Object.values(finalizer.tools).every((enabled) => enabled === false));
});

test("rc13 observe: tool-only empty end-turn is finalized once with tools disabled", async () => {
  const result = await run("observe-empty-then-final");
  assert.equal(result.observeFinalization, "recovered");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.allowedToolCalls, 1, "only the exploratory read should reach the guard");
  assert.equal(
    result.finalMessage,
    '{"status":"pass","findings":[],"bindings":[],"blockers":[]}',
  );
  assert.match(result.logsExcerpt, /observe-finalization/);
});

test("rc13 observe: OpenCode max-step summary is replaced by the structured final envelope", async () => {
  const result = await run("observe-max-steps-then-final");
  assert.equal(result.observeFinalization, "recovered");
  assert.equal(
    result.finalMessage,
    '{"status":"pass","findings":[],"bindings":[],"blockers":[]}',
  );
  assert.equal(observeProtocolRetryAllowed(result), false);
});

test("rc13 observe: persistent empty finalization fails closed without another exploration", async () => {
  const result = await run("observe-empty-persistent");
  assert.equal(result.observeFinalization, "failed");
  assert.equal(result.finalMessage, "");
  assert.equal(result.allowedToolCalls, 1, "the finalizer must not receive tools or re-read the repo");
  assert.equal(observeProtocolRetryAllowed(result), false, "generic observe retry must not reopen exploration");
});

test("rc13 observe: a structured OBSERVE_RESULT succeeds without finalization", async () => {
  const result = await run("observe-structured-success");
  assert.equal(result.observeFinalization, undefined);
  assert.equal(
    result.finalMessage,
    '{"status":"pass","findings":[],"bindings":[],"blockers":[]}',
  );
  assert.doesNotMatch(result.logsExcerpt, /observe-finalization/);
});
