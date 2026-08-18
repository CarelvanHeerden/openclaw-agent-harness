/**
 * Scriptable fake ACP agent for adapter tests.
 *
 * Speaks the same newline-delimited JSON-RPC 2.0 an ACP agent speaks over
 * stdio, so `runWorkerAcp` can be exercised end-to-end -- including the
 * permission request/response pair and the child-process lifecycle -- without
 * launching a real backend or spending tokens.
 *
 * Behaviour is selected with FAKE_ACP_SCENARIO. Scenarios mirror behaviours
 * actually observed from live agents during the M2 capability probe.
 */
const scenario = process.env.FAKE_ACP_SCENARIO ?? "happy";

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyErr = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
const update = (sessionId, u) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

const SESSION = "fake-session-1";
let permissionAnswer = null;

function handle(msg) {
  // Response to a request we (the agent) made -- i.e. the permission decision.
  if (msg.id !== undefined && msg.result !== undefined && msg.method === undefined) {
    permissionAnswer = msg.result;
    return;
  }

  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: scenario !== "no-load" },
      agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
      authMethods: [],
    });
  }

  if (method === "session/load") {
    if (scenario === "no-load") return replyErr(id, "session/load not supported");
    return reply(id, {});
  }

  if (method === "session/new") return reply(id, { sessionId: SESSION });

  if (method === "session/set_model") {
    if (scenario === "no-model-select") return replyErr(id, "session/set_model not supported");
    return reply(id, {});
  }

  if (method === "session/prompt") return void runTurn(id, params?.sessionId ?? SESSION);
}

async function runTurn(id, sessionId) {
  switch (scenario) {
    // Never emits anything and never answers: exercises the stream-open watchdog.
    case "silent":
      return;

    // Opens the stream but produces no assistant output: first-token watchdog.
    case "no-first-token":
      update(sessionId, { sessionUpdate: "tool_call", kind: "execute", title: "thinking" });
      return;

    case "max-tokens":
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "partial" } });
      return reply(id, { stopReason: "max_tokens" });

    case "refusal":
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "no" } });
      return reply(id, { stopReason: "refusal" });

    case "no-cost":
      // Codex-like: reports context occupancy but never any cost.
      update(sessionId, { sessionUpdate: "usage_update", used: 1000, size: 200000 });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "done" } });
      return reply(id, { stopReason: "end_turn" });

    // Agent asks permission for a command the guard should refuse.
    case "denied-command": {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "running" } });
      const decision = await ask(sessionId, {
        kind: "execute",
        title: "sudo rm -rf /",
        rawInput: { command: "sudo rm -rf /", cwd: "/repo" },
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: `decision:${decision?.outcome?.outcome}:${decision?.outcome?.optionId ?? ""}` },
      });
      return reply(id, { stopReason: "end_turn" });
    }

    // Agent asks permission for something benign; guard should allow.
    case "allowed-command": {
      const decision = await ask(sessionId, {
        kind: "execute",
        title: "echo hi",
        rawInput: { command: "echo hi", cwd: "/repo" },
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: `decision:${decision?.outcome?.outcome}:${decision?.outcome?.optionId ?? ""}` },
      });
      return reply(id, { stopReason: "end_turn" });
    }

    // Agent offers no reject option: the adapter must still refuse.
    case "no-reject-option": {
      const decision = await ask(
        sessionId,
        { kind: "execute", title: "sudo rm -rf /", rawInput: { command: "sudo rm -rf /" } },
        [{ optionId: "yes", kind: "allow_once" }],
      );
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: `decision:${decision?.outcome?.outcome}` },
      });
      return reply(id, { stopReason: "end_turn" });
    }

    // Ignores SIGTERM: proves the adapter escalates rather than leaking a process.
    case "stubborn":
      process.on("SIGTERM", () => {});
      return;

    case "happy":
    default:
      // Cumulative cost, exactly as ACP specifies: 0.10 then 0.30 => delta 0.20.
      update(sessionId, { sessionUpdate: "usage_update", used: 500, size: 200000, cost: { amount: 0.1, currency: "USD" } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "hello " } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "world" } });
      update(sessionId, { sessionUpdate: "usage_update", used: 900, size: 200000, cost: { amount: 0.3, currency: "USD" } });
      return reply(id, { stopReason: "end_turn" });
  }
}

let askId = 1000;
function ask(sessionId, toolCall, options) {
  const id = askId++;
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall,
      options: options ?? [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject-once", kind: "reject_once" },
      ],
    },
  });
  return new Promise((resolve) => {
    permissionAnswer = null;
    const iv = setInterval(() => {
      if (permissionAnswer !== null) {
        clearInterval(iv);
        resolve(permissionAnswer);
      }
    }, 5);
  });
}
