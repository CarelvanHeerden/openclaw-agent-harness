/**
 * ACP capability probe (throwaway, not shipped).
 *
 * Speaks raw newline-delimited JSON-RPC 2.0 to an ACP agent over stdio and
 * records every frame. We deliberately do NOT use @agentclientprotocol/sdk for
 * the transport: the whole point is to observe which OPTIONAL fields a given
 * agent actually populates on the wire, and a typed SDK can normalise or drop
 * exactly the fields we are trying to measure.
 *
 * Measures, per agent:
 *   - agentCapabilities.loadSession        -> can we resume a worker session?
 *   - usage_update, and whether .cost      -> can the budget ledger get real cost?
 *   - ToolCall.rawInput on kind=execute    -> can the bash guard see the command?
 *   - ToolCall.kind / .locations[]         -> can the guard key on category + paths?
 *   - ToolCallContent type=diff            -> can contract-verify see touched files?
 *
 * Usage: node acp-probe.mjs --agent claude|opencode|codex [--timeout 180]
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Loads probe/.env.local (gitignored) into process.env without echoing values,
 * so provider credentials stay out of git, logs and shell history. Agents are
 * spawned with the inherited environment, so this is all they need.
 */
function loadLocalEnv() {
  const loaded = [];
  try {
    const raw = readFileSync(join(HERE, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k) {
        process.env[k] = v;
        loaded.push(k);
      }
    }
  } catch {
    return [];
  }
  return loaded;
}

/**
 * How each agent is launched in ACP mode. OpenCode speaks ACP natively via a
 * subcommand; Claude Code and Codex are wrapped by Zed's adapter shims.
 */
const AGENTS = {
  claude: { cmd: "npx", args: ["-y", "@zed-industries/claude-code-acp"] },
  opencode: { cmd: "npx", args: ["-y", "opencode-ai@latest", "acp"] },
  codex: { cmd: "npx", args: ["-y", "@zed-industries/codex-acp"] },
};

/**
 * Forces one `execute` tool call and one `edit` tool call, which are the two
 * kinds the permission guard has to be able to inspect.
 */
const PROMPT =
  "Do exactly these two things, with no preamble and no extra work:\n" +
  "1. Run the shell command: echo acp-probe-marker\n" +
  "2. Create a file named probe-artifact.txt in the current directory whose entire contents are: ok\n" +
  "Then stop and reply with the single word DONE.";

/**
 * Distinguishes "never surfaces shell as a permission request" from "surfaces
 * shell only when it escapes the sandbox". Codex's safety model is sandbox +
 * escalate rather than approve-every-command, so a benign `echo` proves nothing.
 */
const PROMPT_STRUCTURED =
  "Return ONLY a single JSON object and nothing else. No prose, no markdown fence, no tool use.\n" +
  'The object must be exactly: {"ok": true, "n": 42, "note": "<one short sentence>"}';

const PROMPT_ESCAPE =
  "Run this exact shell command using your shell tool, nothing else:\n" +
  "cat /etc/hosts > /tmp/acp-probe-escape.txt && echo wrote-outside-workspace\n" +
  "Then stop and reply with the single word DONE.";

function parseArgs() {
  const out = { agent: "claude", timeout: 180, permissionAsk: false, strictApproval: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") out.agent = argv[++i];
    else if (argv[i] === "--timeout") out.timeout = Number(argv[++i]);
    else if (argv[i] === "--permission-ask") out.permissionAsk = true;
    else if (argv[i] === "--strict-approval") out.strictApproval = true;
    else if (argv[i] === "--model") out.model = argv[++i];
    else if (argv[i] === "--structured") out.structured = true;
    else if (argv[i] === "--escape") out.escape = true;
  }
  if (!AGENTS[out.agent]) {
    console.error(`unknown agent '${out.agent}'; expected one of ${Object.keys(AGENTS).join(", ")}`);
    process.exit(2);
  }
  return out;
}

/** Scratch git repo so file edits and diffs behave like a real worktree. */
async function makeWorkspace(permissionAsk, model, structured) {
  const dir = await mkdtemp(join(tmpdir(), "acp-probe-"));
  await writeFile(join(dir, "README.md"), "# acp probe workspace\n");
  if (structured) {
    // Can OpenCode do what the lead/adversary/classifier need: a single-shot,
    // TOOL-FREE turn that returns strict JSON? The SDK path gets this from
    // `tools: []`; ACP has no equivalent, so the nearest thing is denying every
    // tool in the backend's own config.
    const cfg = { $schema: "https://opencode.ai/config.json", permission: { "*": "deny" } };
    if (model) cfg.model = model;
    await writeFile(join(dir, "opencode.json"), JSON.stringify(cfg, null, 2));
    return dir;
  }
  if (permissionAsk || model) {
    // OpenCode decides whether to emit session/request_permission from ITS OWN
    // config, not from anything the ACP client sends. Without this the agent
    // runs bash and edits silently and our guard never gets a vote. The model
    // is set here too because OpenCode does not advertise model selection over
    // ACP -- session/new returns no models block.
    const cfg = { $schema: "https://opencode.ai/config.json" };
    if (permissionAsk) cfg.permission = { "*": "ask", bash: "ask", edit: "ask" };
    if (model) cfg.model = model;
    await writeFile(join(dir, "opencode.json"), JSON.stringify(cfg, null, 2));
  }
  const git = (args) =>
    new Promise((res) => spawn("git", ["-C", dir, ...args], { stdio: "ignore" }).on("close", res));
  await git(["init", "-q"]);
  await git(["add", "-A"]);
  await git(["-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qm", "seed"]);
  return dir;
}

/**
 * Codex takes its approval policy from CODEX_HOME/config.toml, not from
 * anything the ACP client can send. Build a throwaway home that inherits the
 * real auth but forces every command to be approved, so we can measure whether
 * a strict policy actually surfaces shell commands as permission requests.
 */
async function makeStrictCodexHome() {
  const real = join(process.env.HOME, ".codex");
  const home = await mkdtemp(join(tmpdir(), "acp-codex-home-"));
  await writeFile(join(home, "config.toml"), 'approval_policy = "untrusted"\nsandbox_mode = "read-only"\n');
  try {
    await symlink(join(real, "auth.json"), join(home, "auth.json"));
  } catch {}
  return home;
}

async function main() {
  const { agent, timeout, permissionAsk, strictApproval, escape, model, structured } = parseArgs();
  const loadedEnv = loadLocalEnv();
  if (loadedEnv.length > 0) console.error(`[probe] loaded .env.local keys: ${loadedEnv.join(", ")}`);
  const spec = AGENTS[agent];
  const workspace = await makeWorkspace(permissionAsk, model, structured);
  const extraEnv = {};
  if (strictApproval && agent === "codex") {
    extraEnv.CODEX_HOME = await makeStrictCodexHome();
    console.error(`[probe] strict approval via CODEX_HOME=${extraEnv.CODEX_HOME}`);
  }
  const runsDir = join(HERE, "runs");
  await mkdir(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tracePath = join(runsDir, `${agent}-${stamp}.jsonl`);

  const trace = async (dir, payload) =>
    appendFile(tracePath, JSON.stringify({ t: Date.now(), dir, payload }) + "\n");

  console.error(`[probe] agent=${agent} workspace=${workspace}`);
  console.error(`[probe] trace=${tracePath}`);

  const child = spawn(spec.cmd, spec.args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
  });

  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));

  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const permissionRequests = [];
  let sawExit = null;

  child.on("exit", (code, signal) => {
    sawExit = { code, signal };
    for (const [, p] of pending) p.reject(new Error(`agent exited (code=${code} signal=${signal})`));
    pending.clear();
  });

  const send = async (obj) => {
    await trace("out", obj);
    child.stdin.write(JSON.stringify(obj) + "\n");
  };

  const request = (method, params) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    void send({ jsonrpc: "2.0", id, method, params });
    return p;
  };

  const respond = (id, result) => send({ jsonrpc: "2.0", id, result });

  // ---- inbound frame handling (ndjson) ----
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        void trace("in-unparsed", line);
        continue;
      }
      void trace("in", msg);
      handle(msg);
    }
  });

  function handle(msg) {
    // response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || "rpc error"), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    // request FROM the agent -> we must answer
    if (msg.method && msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        // THE load-bearing measurement: the guard runs here, so whatever this
        // payload carries is all the guard will ever get to make a decision on.
        const tc = msg.params?.toolCall ?? {};
        permissionRequests.push({
          kind: tc.kind ?? null,
          title: tc.title ?? null,
          hasRawInput: tc.rawInput != null,
          rawInputKeys: tc.rawInput && typeof tc.rawInput === "object" ? Object.keys(tc.rawInput) : null,
          rawInput: tc.rawInput ?? null,
          locations: tc.locations ?? null,
          optionKinds: (msg.params?.options ?? []).map((o) => o.kind),
        });
        // Allow everything: the probe measures what we are TOLD, not policy.
        const opts = msg.params?.options ?? [];
        const allow =
          opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => o.kind === "allow_always") ?? opts[0];
        void respond(msg.id, { outcome: { outcome: "selected", optionId: allow?.optionId } });
      } else if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
        // We advertise fs:false, so this should not happen. Answer to avoid a hang.
        void respond(msg.id, msg.method === "fs/read_text_file" ? { content: "" } : {});
      } else {
        void respond(msg.id, {});
      }
      return;
    }
    // notification
    if (msg.method) notifications.push(msg);
  }

  // ---- drive the session ----
  const deadline = setTimeout(() => {
    console.error(`[probe] timeout after ${timeout}s; killing agent`);
    child.kill("SIGKILL");
  }, timeout * 1000);

  const result = { agent, workspace, tracePath, launch: `${spec.cmd} ${spec.args.join(" ")}` };

  try {
    result.initialize = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    // ACP flow is initialize -> authenticate (if advertised) -> session/new.
    // Claude Code accepts session/new unauthenticated and only refuses at
    // session/prompt, so authenticate proactively rather than on refusal.
    const methods = result.initialize?.authMethods ?? [];
    if (methods.length > 0) {
      const methodId = methods[0].id ?? methods[0];
      result.authenticateAttempted = methodId;
      try {
        await request("authenticate", { methodId });
        result.authenticated = true;
        console.error(`[probe] authenticated via ${methodId}`);
      } catch (err) {
        result.authenticated = false;
        result.authenticateError = String(err?.message ?? err);
        console.error(`[probe] authenticate(${methodId}) failed: ${result.authenticateError}`);
      }
    }

    const session = await request("session/new", { cwd: workspace, mcpServers: [] });
    result.sessionId = session?.sessionId;
    result.sessionModels = session?.models ?? null;
    result.sessionModes = session?.modes ?? null;

    result.promptResponse = await request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: structured ? PROMPT_STRUCTURED : escape ? PROMPT_ESCAPE : PROMPT }],
    });
  } catch (err) {
    result.error = String(err?.message ?? err);
    if (err?.rpc) result.rpcError = err.rpc;
  } finally {
    clearTimeout(deadline);
    try {
      child.kill("SIGTERM");
    } catch {}
  }

  result.exit = sawExit;
  result.stderrTail = stderrChunks.join("").slice(-4000);
  result.notificationCount = notifications.length;
  result.permissionRequests = permissionRequests;

  const analysisPath = join(runsDir, `${agent}-${stamp}.analysis.json`);
  const analysis = analyse(notifications, result);
  await writeFile(analysisPath, JSON.stringify({ result, analysis }, null, 2));

  console.log(JSON.stringify(analysis, null, 2));
  console.error(`[probe] analysis=${analysisPath}`);
  process.exit(result.error ? 1 : 0);
}

/** Reduce the raw session/update stream to the capability answers we need. */
export function analyse(notifications, result = {}) {
  const updates = notifications
    .filter((n) => n.method === "session/update")
    .map((n) => n.params?.update)
    .filter(Boolean);

  const byKind = (k) => updates.filter((u) => u.sessionUpdate === k);
  const usage = byKind("usage_update");
  // v1 emits tool_call + tool_call_update; v2 folds creation into tool_call_update.
  const toolCalls = [...byKind("tool_call"), ...byKind("tool_call_update")];

  const kinds = [...new Set(toolCalls.map((t) => t.kind).filter(Boolean))];
  const execCalls = toolCalls.filter((t) => t.kind === "execute");
  const editCalls = toolCalls.filter((t) => t.kind === "edit");
  const withDiff = toolCalls.filter((t) =>
    (t.content ?? []).some((c) => c?.type === "diff"),
  );

  const caps = result?.initialize?.agentCapabilities ?? {};

  return {
    agent: result.agent,
    reachedPrompt: result.promptResponse !== undefined,
    error: result.error ?? null,
    stopReason: result.promptResponse?.stopReason ?? null,
    protocolVersion: result.initialize?.protocolVersion ?? null,
    authMethods: (result.initialize?.authMethods ?? []).map((a) => a.id ?? a),

    agentInfo: result.initialize?.agentInfo ?? null,

    // Can we resume a worker session after a harness restart?
    loadSession: caps.loadSession ?? false,
    sessionCapabilities: caps.sessionCapabilities ?? null,

    // Can our layer pick the model per role, as the plan's Option 1 requires?
    modelSelection: {
      advertised: result.sessionModels != null,
      currentModelId: result.sessionModels?.currentModelId ?? null,
      availableModelIds: (result.sessionModels?.availableModels ?? []).map((m) => m.modelId),
    },

    // Can the budget ledger get real money out of this backend?
    usage: {
      emitted: usage.length > 0,
      count: usage.length,
      hasCost: usage.some((u) => u.cost != null),
      lastCost: usage.at(-1)?.cost ?? null,
      lastUsed: usage.at(-1)?.used ?? null,
      lastSize: usage.at(-1)?.size ?? null,
    },

    // Can the permission guard actually see what it is authorising?
    toolCalls: {
      total: toolCalls.length,
      kinds,
      kindPresent: toolCalls.some((t) => t.kind != null),
      rawInputPresent: toolCalls.some((t) => t.rawInput != null),
      execCount: execCalls.length,
      execWithRawInput: execCalls.filter((t) => t.rawInput != null).length,
      editCount: editCalls.length,
      locationsPresent: toolCalls.some((t) => Array.isArray(t.locations) && t.locations.length > 0),
    },

    // Can contract-verify see the touched-file set?
    diffContent: { present: withDiff.length > 0, count: withDiff.length },

    // What the guard would actually have to work with at decision time.
    permission: {
      count: (result.permissionRequests ?? []).length,
      anyWithRawInput: (result.permissionRequests ?? []).some((p) => p.hasRawInput),
      kinds: [...new Set((result.permissionRequests ?? []).map((p) => p.kind).filter(Boolean))],
      samples: (result.permissionRequests ?? []).slice(0, 4),
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith("acp-probe.mjs")) {
  main().catch((e) => {
    console.error("[probe] fatal", e);
    process.exit(1);
  });
}
