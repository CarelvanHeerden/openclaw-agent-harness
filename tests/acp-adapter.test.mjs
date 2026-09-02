/**
 * ACP worker-adapter tests.
 *
 * Driven against tests/fixtures/fake-acp-agent.mjs, a real child process
 * speaking real newline-delimited JSON-RPC, so the transport, the permission
 * request/response pair and the process lifecycle are all genuinely exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-acp-agent.mjs");

let runWorkerAcp, preflightAcpBackend, buildAcpGuard;
try {
  ({ runWorkerAcp, preflightAcpBackend } = await import("../dist/adapters/acp.js"));
  ({ buildAcpGuard } = await import("../dist/safety/bash-guard.js"));
} catch {
  runWorkerAcp = null;
}
const skip = { skip: runWorkerAcp === null };

const guard = () =>
  buildAcpGuard({
    bash_whitelist: ["git", "npm", "node", "ls", "cat", "echo"],
    bash_denylist_tokens: ["sudo", "rm"],
    path_denylist: [".env", "*.pem"],
    allow_git_push: false,
    allow_network_commands: false,
  });

function run(scenario, over = {}) {
  return runWorkerAcp({
    agent: { command: process.execPath, args: [FAKE], env: { FAKE_ACP_SCENARIO: scenario } },
    worktreePath: tmpdir(),
    systemPrompt: "sys",
    userMessage: "do the thing",
    model: "",
    timeoutSeconds: 10,
    streamOpenTimeoutSeconds: 2,
    firstTokenTimeoutSeconds: 2,
    acpGuard: guard(),
    ...over,
  });
}

// --- happy path and usage accounting ---

test("acp-adapter: completes a turn and maps end_turn", skip, async () => {
  const r = await run("happy");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.sdkSessionId, "fake-session-1");
  assert.equal(r.finalMessage, "hello world");
  assert.equal(r.streamOpened, true);
  assert.ok(typeof r.msToFirstToken === "number");
});

test("acp-adapter: cost is the agent's cumulative figure for a session we opened", skip, async () => {
  // Agent reports 0.10 then 0.30 cumulative DURING this prompt, so the turn
  // cost 0.30. This assertion used to read 0.20, on the assumption that the
  // first figure was an opening balance -- but `runWorkerAcp` creates the
  // session it prompts, so there is no earlier spend to subtract, and every
  // real turn reported its own cost as its baseline and billed zero.
  const r = await run("happy");
  assert.ok(Math.abs(r.costUsd - 0.3) < 1e-9, `expected 0.30, got ${r.costUsd}`);
  assert.equal(r.usageSource, "acp-delta");
});

test("acp-adapter: a single end-of-turn cost is the whole cost, not zero", skip, async () => {
  // The shape OpenCode actually sends against the built-in OpenAI provider:
  // one usage_update carrying the turn's total. Subtracting it from itself
  // reported $0.00 for an entire session while claiming the figure was
  // measured -- a ledger a budget ceiling cannot trip on.
  const r = await run("token-split");
  assert.ok(Math.abs(r.costUsd - 0.05) < 1e-9, `expected 0.05, got ${r.costUsd}`);
  assert.equal(r.usageSource, "acp-delta");
});

test("acp-adapter: token counts are zero but explicitly flagged, never a silent zero", skip, async () => {
  const r = await run("happy");
  assert.equal(r.tokensIn, 0);
  assert.equal(r.tokensOut, 0);
  // The flag is what stops the ledger reading 0 tokens as "measured, free".
  assert.equal(r.usageSource, "acp-delta");
  assert.equal(r.contextUsed, 900);
  assert.equal(r.contextSize, 200000);
});

test("acp-adapter: an agent that reports no cost is marked unavailable", skip, async () => {
  const r = await run("no-cost");
  assert.equal(r.usageSource, "unavailable");
  assert.equal(r.costUsd, 0);
  assert.equal(r.contextUsed, 1000);
});

// --- stop reason mapping ---

test("acp-adapter: max_tokens maps straight through", skip, async () => {
  assert.equal((await run("max-tokens")).stopReason, "max_tokens");
});

test("acp-adapter: refusal maps to tool_error and records the raw reason", skip, async () => {
  const r = await run("refusal");
  assert.equal(r.stopReason, "tool_error");
  assert.match(r.logsExcerpt, /raw stopReason=refusal/);
});

// --- the safety-critical path ---

test("acp-adapter: a denied command is refused via the reject option", skip, async () => {
  const r = await run("denied-command");
  assert.equal(r.deniedToolCalls.length, 1);
  assert.equal(r.deniedToolCalls[0].kind, "execute");
  // The agent echoes back what we answered, proving the refusal reached it.
  assert.match(r.finalMessage, /decision:selected:reject-once/);
  assert.match(r.logsExcerpt, /\[guard\] DENIED execute/);
});

test("acp-adapter: a benign command is allowed through", skip, async () => {
  const r = await run("allowed-command");
  assert.equal(r.deniedToolCalls.length, 0);
  assert.match(r.finalMessage, /decision:selected:allow-once/);
});

test("acp-adapter: a denial with no reject option falls back to cancelled", skip, async () => {
  // An agent that offers only "allow" must not thereby win the argument.
  const r = await run("no-reject-option");
  assert.equal(r.deniedToolCalls.length, 1);
  assert.match(r.finalMessage, /decision:cancelled/);
});

// --- watchdogs and lifecycle ---

test("acp-adapter: an agent that never streams trips the stream-open watchdog", skip, async () => {
  const r = await run("silent");
  assert.equal(r.stopReason, "first_token_timeout");
  assert.equal(r.streamOpened, false);
  assert.match(r.logsExcerpt, /stream-open watchdog/);
});

test("acp-adapter: a stream that opens but yields no tokens trips the first-token watchdog", skip, async () => {
  const r = await run("no-first-token");
  assert.equal(r.stopReason, "first_token_timeout");
  // Distinguishing these two is the whole point of the split-phase watchdog.
  assert.equal(r.streamOpened, true);
  assert.equal(r.msToFirstToken, undefined);
  assert.match(r.logsExcerpt, /first-token watchdog/);
});

test("acp-adapter: the overall turn timeout is enforced", skip, async () => {
  const r = await run("silent", { streamOpenTimeoutSeconds: 30, timeoutSeconds: 1 });
  assert.equal(r.stopReason, "timeout");
  assert.match(r.logsExcerpt, /turn timeout/);
});

test("acp-adapter: an agent ignoring SIGTERM is escalated and does not hang the turn", skip, async () => {
  const started = Date.now();
  const r = await run("stubborn", { streamOpenTimeoutSeconds: 1, timeoutSeconds: 20 });
  assert.equal(r.stopReason, "first_token_timeout");
  assert.ok(Date.now() - started < 15_000, "must not wait out the full turn budget");
});

// --- resume and model selection degrade gracefully ---

test("acp-adapter: unsupported session/load falls back to a fresh session", skip, async () => {
  const r = await run("no-load", { resumeSessionId: "old-session" });
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.sdkSessionId, "fake-session-1", "should have started a new session");
  assert.match(r.logsExcerpt, /session\/load failed, starting fresh/);
});

test("acp-adapter: unsupported session/set_model is non-fatal", skip, async () => {
  const r = await run("no-model-select", { model: "some-model" });
  assert.equal(r.stopReason, "end_turn");
  assert.match(r.logsExcerpt, /set_model unsupported/);
});

// --- preflight: the failure mode that is invisible at runtime ---

test("acp-preflight: opencode with no permission block fails closed", skip, () => {
  const r = preflightAcpBackend({ agentId: "opencode", backendConfig: {} });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /no `permission` block/);
});

test("acp-preflight: opencode with bash set to allow fails closed", skip, () => {
  const r = preflightAcpBackend({
    agentId: "opencode",
    backendConfig: { permission: { bash: "allow", edit: "ask" } },
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /permission\.bash is "allow"/);
});

test("acp-preflight: opencode configured to ask passes", skip, () => {
  const r = preflightAcpBackend({
    agentId: "opencode",
    backendConfig: { permission: { bash: "ask", edit: "ask" } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test("acp-preflight: codex is rejected for the in-workspace denylist gap", skip, () => {
  const r = preflightAcpBackend({ agentId: "codex", backendConfig: {} });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /sandbox-and-escalate/);
});

test("acp-preflight: claude over ACP is rejected in favour of the SDK backend", skip, () => {
  // Measured: no Claude Code ACP session mode asks for every tool call, while
  // the SDK path does. Allowing this would regress safety for no gain.
  const r = preflightAcpBackend({ agentId: "claude", backendConfig: {} });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /strictly weaker/);
});
