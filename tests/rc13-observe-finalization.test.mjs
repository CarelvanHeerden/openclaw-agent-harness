import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import {
  defaultWorker,
  makeWorld,
  mutateSubTask,
  runScenario,
  scenarioAvailable,
} from "./helpers/scenario.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-acp-agent.mjs");

const {
  OBSERVE_ACP_MAX_STEPS,
  runObserveWorkerAcp,
} = await import("../dist/adapters/acp.js");
const { buildOpenCodeConfig, openCodeConfigEnv } = await import("../dist/adapters/opencode-config.js");
const { buildAcpGuard } = await import("../dist/safety/bash-guard.js");
const { observeProtocolRetryAllowed } = await import("../dist/orchestrator/loop.js");
const { validateObserveResult } = await import("../dist/orchestrator/observe-contract.js");

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

function run(scenario, worktreePath = tmpdir()) {
  return runObserveWorkerAcp({
    initial: {
      agent: agent(scenario),
      worktreePath,
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

const emptyObserveContract = { requiredFindings: [], requireEvidence: true, bindings: [] };
const validEnvelope = '{"status":"ok","findings":[],"bindings":[],"blockers":[]}';

test("rc13 observe: OpenCode config applies an explicit finite build-agent step budget", () => {
  const bounded = buildOpenCodeConfig({ maxSteps: OBSERVE_ACP_MAX_STEPS });
  assert.equal(bounded.agent.build.steps, OBSERVE_ACP_MAX_STEPS);

  const finalizer = buildOpenCodeConfig({ toolless: true, maxSteps: 1 });
  assert.equal(finalizer.agent.build.steps, 1);
  assert.ok(Object.values(finalizer.tools).every((enabled) => enabled === false));
});

test("rc13 observe: tool-only empty end-turn is finalized once with valid structured output", async () => {
  const result = await run("observe-empty-then-final");
  assert.equal(result.observeFinalization, "recovered");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.allowedToolCalls, 1, "only the exploratory read should reach the ordinary guard");
  assert.equal(result.finalMessage, validEnvelope);
  const validation = validateObserveResult({
    finalMessage: result.finalMessage,
    contract: emptyObserveContract,
    repoFiles: [],
  });
  assert.equal(validation.ok, true, validation.reason);
  assert.match(result.logsExcerpt, /observe-finalization/);
});

test("rc13 observe: OpenCode max-step summary is replaced by the structured final envelope", async () => {
  const result = await run("observe-max-steps-then-final");
  assert.equal(result.observeFinalization, "recovered");
  assert.equal(result.finalMessage, validEnvelope);
  assert.equal(observeProtocolRetryAllowed(result), false);
});

test("rc13 observe: persistent empty finalization fails closed without another exploration", async () => {
  const result = await run("observe-empty-persistent");
  assert.equal(result.observeFinalization, "failed");
  assert.equal(result.finalMessage, "");
  assert.equal(result.allowedToolCalls, 1, "the finalizer must not receive tools or re-read the repo");
  assert.equal(observeProtocolRetryAllowed(result), false, "generic observe retry must not reopen exploration");
});

test("rc13 observe: non-empty malformed finalizer output is terminal", async () => {
  const result = await run("observe-empty-then-malformed-final");
  assert.equal(result.observeFinalization, "recovered", "the transport recovered text even though the contract did not");
  const validation = validateObserveResult({
    finalMessage: result.finalMessage,
    contract: emptyObserveContract,
    repoFiles: [],
  });
  assert.equal(validation.ok, false);
  assert.equal(observeProtocolRetryAllowed(result), false, "contract failure after finalization must not reopen exploration");
});

test("rc13 observe: a structured OBSERVE_RESULT succeeds without finalization", async () => {
  const result = await run("observe-structured-success");
  assert.equal(result.observeFinalization, undefined);
  assert.equal(result.finalMessage, validEnvelope);
  assert.doesNotMatch(result.logsExcerpt, /observe-finalization/);
});

test("rc13 observe: finalizer ACP guard denies read, write, bash, custom, and client fs cannot act", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "observe-finalizer-deny-"));
  try {
    const result = await run("observe-finalizer-tool-attempts", worktree);
    assert.equal(result.observeFinalization, "recovered");
    assert.equal(result.allowedToolCalls, 1, "only the exploratory read may be allowed");
    assert.equal(result.deniedToolCalls.length, 4);
    assert.deepEqual(result.deniedToolCalls.map((call) => call.kind), ["read", "edit", "execute", "custom_future_tool"]);
    const envelope = JSON.parse(result.finalMessage);
    assert.deepEqual(envelope.denied, [true, true, true, true]);
    assert.equal(envelope.fsRefused, true, "client-side writes remain unavailable");
    for (const marker of [
      "finalizer-read-acted",
      "finalizer-edit-acted",
      "finalizer-bash-acted",
      "finalizer-custom-acted",
      "finalizer-client-write-acted",
    ]) {
      assert.equal(existsSync(join(worktree, marker)), false, `${marker} must not be created`);
    }
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

const available = await scenarioAvailable();
const observeTask = {
  seq: 1,
  title: "Inspect repository convention",
  intent: "Return the structured observation.",
  filesLikelyTouched: [],
  successCriteria: ["Return OBSERVE_RESULT."],
  estimatedTokens: 10,
  taskMode: "observe",
  verify: [],
  observeContract: emptyObserveContract,
};
const consumerTask = mutateSubTask({
  seq: 2,
  title: "Apply observed convention",
  path: "src/result.ts",
  extra: { dependsOn: [1] },
});

function observeWorkerResult(finalMessage, observeFinalization) {
  return {
    status: "completed",
    filesChanged: [],
    commitShas: [],
    costUsd: 0.01,
    tokensIn: 1,
    tokensOut: 1,
    reason: "end_turn",
    finalMessage,
    allowedToolCalls: 1,
    unguardedReads: 0,
    observeFinalization,
  };
}

test("rc13 observe loop: recovered valid finalizer output succeeds", { skip: !available }, async () => {
  const world = await makeWorld();
  const fallback = defaultWorker({ adapter: world.adapter });
  const seen = [];
  const result = await runScenario({
    world,
    subTasks: [observeTask, consumerTask],
    worker: async (params) => {
      seen.push(params.subTask.seq);
      return params.subTask.seq === 1
        ? observeWorkerResult(validEnvelope, "recovered")
        : fallback(params);
    },
  });
  assert.equal(result.out.status, "shipped");
  assert.deepEqual(seen, [1, 2]);
});

test("rc13 observe loop: non-empty malformed finalizer output is terminal", { skip: !available }, async () => {
  const seen = [];
  const result = await runScenario({
    configOver: { loop: { worker_protocol_max_attempts: 5 } },
    subTasks: [observeTask, consumerTask],
    worker: async ({ subTask }) => {
      seen.push(subTask.seq);
      return observeWorkerResult("not an OBSERVE_RESULT", "recovered");
    },
  });
  assert.deepEqual(seen, [1], "malformed finalizer output must not reopen exploration or dispatch dependents");
  assert.equal(result.subTaskRows().find((row) => row.seq === 1).status, "failed_verification");
});

test("rc13 observe loop: persistent empty finalizer fails closed", { skip: !available }, async () => {
  const seen = [];
  const result = await runScenario({
    configOver: { loop: { worker_protocol_max_attempts: 5 } },
    subTasks: [observeTask, consumerTask],
    worker: async ({ subTask }) => {
      seen.push(subTask.seq);
      return observeWorkerResult("", "failed");
    },
  });
  assert.deepEqual(seen, [1], "empty finalization failure must not reopen exploration or dispatch dependents");
  assert.equal(result.subTaskRows().find((row) => row.seq === 1).status, "failed_verification");
});
