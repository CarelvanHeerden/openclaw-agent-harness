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
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: scenario !== "no-load" },
      agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
      authMethods: [],
    });
    // A crash in the window between `initialize` resolving and the next
    // request being sent. The ordinary shape of a backend that starts, fails
    // to reach its provider, and gives up -- and the case where a request
    // issued after close used to wait forever for a reply nobody would send.
    if (scenario === "exit-after-initialize") process.exit(3);
    return;
  }

  if (method === "session/load") {
    if (scenario === "no-load") return replyErr(id, "session/load not supported");
    // Die mid-resume, without answering.
    //
    // This is the reachable route to the post-close hang: the adapter awaits
    // session/load, the exit handler rejects it, and the CATCH treats that as
    // "this agent does not support resume" and falls through to session/new --
    // on a connection that is now closed.
    if (scenario === "exit-on-session-load") process.exit(4);
    return reply(id, {});
  }

  if (method === "session/new") return reply(id, { sessionId: SESSION });

  if (method === "session/set_model") {
    if (scenario === "no-model-select") return replyErr(id, "session/set_model not supported");
    return reply(id, {});
  }

  if (method === "session/prompt") {
    params_last = params;
    return void runTurn(id, params?.sessionId ?? SESSION);
  }
}

/** The most recent session/prompt params, so a scenario can vary on what it was asked. */
let params_last = null;

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

    // v2.0.0: leaks its whole environment back as the assistant message, so a
    // test can assert what the child actually inherited rather than asserting
    // on the spawn options. This is the shape the P0 env leak had: nothing
    // errors, the secret simply arrives.
    case "echo-env":
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: JSON.stringify(process.env) },
      });
      return reply(id, { stopReason: "end_turn" });

    // v2.0.0: spawns a grandchild that outlives a SIGTERM to the wrapper, and
    // reports its pid. This is what `opencode` looks like -- a node wrapper
    // around a provider client -- so killing only the direct child orphans the
    // process that is still talking to the model and still spending.
    case "spawns-grandchild": {
      const { spawn } = await import("node:child_process");
      const kid = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
        stdio: "ignore",
      });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: `grandchild:${kid.pid}` } });
      process.on("SIGTERM", () => {});
      return; // never answers: the caller must time out and reap the GROUP
    }

    // v2.0.0: the token split, on the session/prompt RESULT where it actually
    // lives. Shape copied from probe/runs/opencode-2026-08-03T11-05-30-800Z.
    case "token-split":
      update(sessionId, { sessionUpdate: "usage_update", used: 10, size: 1000000, cost: { amount: 0.05, currency: "USD" } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "done" } });
      return reply(id, {
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 132, totalTokens: 2137, cachedWriteTokens: 1995 },
      });

    // v2.0.0: a local provider -- real tokens, no cost at all. costUsd 0 is
    // TRUE here rather than unknown, and the two must be distinguishable.
    case "tokens-no-cost":
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "done" } });
      return reply(id, { stopReason: "end_turn", usage: { inputTokens: 40, outputTokens: 7 } });

    // v2.0.0 structured path: valid JSON in one turn.
    case "structured-ok":
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: '{"verdict":"revise","findings":[],"summary":"ok"}' },
      });
      return reply(id, { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 9 } });

    // v2.0.0 structured path: prose first, then JSON once corrected. Proves the
    // ladder retries over ACP and that the correction reaches the agent.
    case "structured-prose-then-json": {
      const asked = String(params_last?.prompt?.[0]?.text ?? "");
      const corrected = /could not be parsed/.test(asked);
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: corrected ? '{"verdict":"pass","findings":[],"summary":"fine"}' : "I think it looks fine!" },
      });
      return reply(id, { stopReason: "end_turn" });
    }

    // v2.0.0 structured path: a role with no tools that asks for one anyway.
    // The deny-all guard must refuse it.
    //
    // Echoes the chosen optionId, NOT just the outcome: an allow and a deny are
    // BOTH `outcome:"selected"`, differing only in which option was picked, so
    // asserting on the outcome alone cannot tell them apart.
    case "structured-asks-for-tool": {
      const decision = await ask(sessionId, {
        kind: "execute",
        title: "cat /etc/passwd",
        rawInput: { command: "cat /etc/passwd" },
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          text: `{"verdict":"pass","findings":[],"summary":"${decision?.outcome?.outcome}:${decision?.outcome?.optionId ?? "none"}"}`,
        },
      });
      return reply(id, { stopReason: "end_turn" });
    }

    // v2.0.0: sends the `usage` field but with nothing in it -- an agent that
    // implements the shape and not the substance. It must not be counted as a
    // measured zero.
    case "empty-usage":
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "done" } });
      return reply(id, { stopReason: "end_turn", usage: { totalTokens: 0 } });

    // The measured OpenCode 1.18.23 read: asks, names no file.
    case "pathless-read": {
      await ask(sessionId, { kind: "read", title: "read", locations: [], rawInput: {} });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "the file says hello" } });
      return reply(id, { stopReason: "end_turn" });
    }

    // ---- v2.0.0 M6: capability-probe scenarios ----

    // A correctly configured agent: asks before writing, honours the refusal.
    case "probe-asks": {
      const marker = /named (\S+?)\.txt/.exec(String(params_last?.prompt?.[0]?.text ?? ""))?.[1] ?? "x";
      const decision = await ask(sessionId, {
        kind: "edit",
        title: `${marker}.txt`,
        rawInput: { filepath: `${marker}.txt`, content: "ok" },
        locations: [{ path: `${marker}.txt` }],
      });
      const refused = decision?.outcome?.outcome !== "selected" || /reject/.test(decision?.outcome?.optionId ?? "");
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: refused ? "I was not permitted to do that." : `Created ${marker}.txt` },
      });
      return reply(id, { stopReason: "end_turn" });
    }

    // The measured default: does the work and never asks. This is the exact
    // shape of the hole the probe exists to find.
    case "probe-never-asks": {
      const marker = /named (\S+?)\.txt/.exec(String(params_last?.prompt?.[0]?.text ?? ""))?.[1] ?? "x";
      update(sessionId, { sessionUpdate: "tool_call", kind: "edit", title: `${marker}.txt` });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: `Created ${marker}.txt with the word ok.` },
      });
      return reply(id, { stopReason: "end_turn" });
    }

    // Asks, is refused, writes anyway, and says nothing about it.
    //
    // The narration check cannot see this one: the final message is a plain
    // compliance claim, and only the file on disk gives it away. Strictly
    // worse than `probe-asks-then-ignores`, because a backend that bypasses
    // the guard silently is more dangerous than one that brags about it.
    case "probe-asks-then-writes-silently": {
      const marker = /named (\S+?)\.txt/.exec(String(params_last?.prompt?.[0]?.text ?? ""))?.[1] ?? "x";
      await ask(sessionId, {
        kind: "edit",
        title: `${marker}.txt`,
        rawInput: { filepath: `${marker}.txt` },
        locations: [{ path: `${marker}.txt` }],
      });
      writeFileSync(join(process.cwd(), `${marker}.txt`), "ok");
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: "I was not permitted to do that." },
      });
      return reply(id, { stopReason: "end_turn" });
    }

    // Asks, is refused, and does it anyway. Politeness without obedience.
    case "probe-asks-then-ignores": {
      const marker = /named (\S+?)\.txt/.exec(String(params_last?.prompt?.[0]?.text ?? ""))?.[1] ?? "x";
      await ask(sessionId, {
        kind: "edit",
        title: `${marker}.txt`,
        rawInput: { filepath: `${marker}.txt` },
        locations: [{ path: `${marker}.txt` }],
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { text: `Created ${marker}.txt anyway.` },
      });
      return reply(id, { stopReason: "end_turn" });
    }

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
