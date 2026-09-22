import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runWorkerAcp } = await import("../dist/adapters/acp.js");

function fakeAgent() {
  const dir = mkdtempSync(join(tmpdir(), "rc13-acp-resume-"));
  const script = join(dir, "agent.mjs");
  writeFileSync(script, `
import readline from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = value => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: value } });
const foreignUpdate = value => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "foreign-session", update: value } });
readline.createInterface({ input: process.stdin }).on("line", line => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fixture", version: "1" }, authMethods: [] });
  if (method === "session/load") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD TURN NARRATION" } });
    if (process.env.LOAD_BASELINE === "yes") update({ sessionUpdate: "usage_update", cost: { amount: 6.7562388, currency: "USD" } });
    return reply(id, {});
  }
  if (method === "session/new") return reply(id, { sessionId: "fixture-session" });
  if (method === "session/prompt") {
    if (process.env.SILENT_PROMPT === "yes") return reply(id, { stopReason: "end_turn" });
    foreignUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FOREIGN TURN" } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "{\\"status\\":\\"blocked\\",\\"findings\\":[],\\"bindings\\":[],\\"blockers\\":[\\"Missing authority\\"]}" } });
    update({ sessionUpdate: "usage_update", cost: { amount: Number(process.env.FINAL_COST || "7.2962708"), currency: process.env.COST_CURRENCY || "USD" } });
    return reply(id, { stopReason: "end_turn" });
  }
  if (id !== undefined) reply(id, {});
});
`);
  return script;
}

async function run({ loadBaseline = false, persistedBaseline, finalCost, currency, silentPrompt = false } = {}) {
  return runWorkerAcp({
    agent: {
      command: process.execPath,
      args: [fakeAgent()],
      env: {
        LOAD_BASELINE: loadBaseline ? "yes" : "no",
        ...(finalCost !== undefined ? { FINAL_COST: String(finalCost) } : {}),
        ...(currency ? { COST_CURRENCY: currency } : {}),
        ...(silentPrompt ? { SILENT_PROMPT: "yes" } : {}),
      },
    },
    resumeSessionId: "fixture-session",
    resumeCumulativeCostUsd: persistedBaseline,
    worktreePath: tmpdir(),
    systemPrompt: "offline",
    userMessage: "return current result",
    model: "",
    timeoutSeconds: 10,
    streamOpenTimeoutSeconds: 3,
    firstTokenTimeoutSeconds: 3,
    acpGuard: async () => ({ allow: false, reason: "offline" }),
  });
}

test("rc13 smoke: session/load replay is excluded from the current turn", async () => {
  const result = await run({ loadBaseline: true });
  assert.equal(
    result.finalMessage,
    '{"status":"blocked","findings":[],"bindings":[],"blockers":["Missing authority"]}',
  );
  assert.ok(result.msToFirstToken >= 0);
});

test("rc13 smoke: replay cannot masquerade as current stream activity", async () => {
  const result = await run({ loadBaseline: true, silentPrompt: true });
  assert.equal(result.finalMessage, "");
  assert.equal(result.streamOpened, false);
  assert.equal(result.msToFirstToken, undefined);
});

test("rc13 smoke: resumed cost uses either load-time or durable cumulative baseline", async () => {
  const fromLoad = await run({ loadBaseline: true });
  assert.equal(fromLoad.usageSource, "acp-delta");
  assert.ok(Math.abs(fromLoad.costUsd - 0.540032) < 1e-9);
  assert.equal(fromLoad.cumulativeCostUsd, 7.2962708);

  const fromStore = await run({ persistedBaseline: 6.7562388 });
  assert.equal(fromStore.usageSource, "acp-delta");
  assert.ok(Math.abs(fromStore.costUsd - 0.540032) < 1e-9);
  assert.equal(fromStore.cumulativeCostUsd, 7.2962708);
});

test("rc13 smoke: a resumed turn without a baseline is accounting-indeterminate", async () => {
  const result = await run();
  assert.equal(result.usageSource, "unavailable");
  assert.equal(result.costUsd, 0);
  assert.equal(result.cumulativeCostUsd, undefined);
});

test("rc13 smoke: mismatched, decreasing, or non-USD cumulative usage is indeterminate", async () => {
  for (const params of [
    { loadBaseline: true, persistedBaseline: 6, finalCost: 7.2962708 },
    { persistedBaseline: 6.7562388, finalCost: 6 },
    { persistedBaseline: 6.7562388, finalCost: 7.2962708, currency: "EUR" },
  ]) {
    const result = await run(params);
    assert.equal(result.usageSource, "unavailable", JSON.stringify(params));
    assert.equal(result.cumulativeCostUsd, undefined, JSON.stringify(params));
  }
});
