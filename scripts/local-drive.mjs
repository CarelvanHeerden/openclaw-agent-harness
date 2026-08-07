#!/usr/bin/env node
/**
 * Dev-only driver: run the harness locally, without OpenClaw or Slack.
 *
 * Every release from beta.99 to beta.111 was diagnosed from a prose report
 * written by an agent watching a production run. That loop costs hours and
 * about ten dollars per data point, and the reports have been wrong about
 * measurable things -- the b110 one gave three different wall-clock totals for
 * the same run and corrected itself twice mid-document. This is the same
 * harness, driven directly, with the audit log read from SQLite instead of
 * summarised.
 *
 * It boots the real plugin against a fake OpenClaw API, so the code path is
 * production's: same bootstrap, same tool registration, same OrchestratorLoop,
 * same GitAdapter, same state store.
 *
 * Config lives OUTSIDE the repo at ~/.harness-local/config.json so a real repo
 * name, a commit identity or a token can never be committed by accident.
 *
 *   node scripts/local-drive.mjs check
 *   node scripts/local-drive.mjs start <brief.json> [--budget 20] [--watch]
 *   node scripts/local-drive.mjs watch <sessionId>
 *   node scripts/local-drive.mjs answer <sessionId> "<answer>"
 *   node scripts/local-drive.mjs audit <sessionId> [--grep pat] [--tail 40] [--json]
 *   node scripts/local-drive.mjs sessions
 *   node scripts/local-drive.mjs cancel <sessionId>
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const HOME_DIR = process.env.HARNESS_LOCAL_DIR || join(homedir(), ".harness-local");
const CONFIG_PATH = join(HOME_DIR, "config.json");

const die = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    die(`no config at ${CONFIG_PATH}\n  Run: node scripts/local-drive.mjs check`);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  for (const dir of [cfg.storage?.state_db_path && dirname(cfg.storage.state_db_path), cfg.storage?.worktree_root]) {
    if (dir) mkdirSync(dir, { recursive: true });
  }
  return cfg;
}

/**
 * The harness resolves a git token from `pat_routing.auth.api_key_env`
 * (default GH_TOKEN). Locally that comes from the gh keyring rather than a
 * pasted secret, so nothing long-lived sits in a shell profile.
 */
async function ghKeyringToken(account) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const args = ["auth", "token"];
  if (account) args.push("-u", account);
  const { stdout } = await run("gh", args, { env });
  return stdout.trim();
}

const tools = new Map();

async function boot() {
  const config = loadConfig();
  if (config.github_account) {
    try {
      process.env.GH_TOKEN = await ghKeyringToken(config.github_account);
    } catch (err) {
      die(`could not read a token for "${config.github_account}" from the gh keyring: ${String(err)}`);
    }
  }

  const level = process.env.HARNESS_LOG === "quiet" ? new Set(["error"]) : new Set(["info", "warn", "error"]);
  const log = (lvl) => (m, meta) => {
    if (!level.has(lvl)) return;
    const extra = meta === undefined ? "" : ` ${typeof meta === "string" ? meta : JSON.stringify(meta)}`;
    console.error(`  [${lvl}] ${m}${extra}`);
  };

  const api = {
    registrationMode: "runtime",
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: () => {} },
    registerTool: (def) => {
      tools.set(def.name, def);
      return () => {};
    },
    on: () => () => {},
    registerHook: () => () => {},
    registerService: () => () => {},
    pluginConfig: config,
    getConfig: () => config,
    workspaceDir: HOME_DIR,
    // No Slack. The harness treats an absent channel as agent-orchestrated
    // mode and keys the thread as `agent:<sessionId>`.
    sendMessage: async () => ({ ts: `${Date.now()}` }),
    addReaction: async () => {},
    callTool: async (name) => {
      throw new Error(`no OpenClaw tool "${name}" locally (vault lookups are disabled in this config)`);
    },
  };

  // `dist/index.js` imports `openclaw/plugin-sdk/plugin-entry`, which only
  // exists inside the OpenClaw runtime. Same stub the smoke script uses.
  const { register } = await import("node:module");
  register("./smoke-stub.mjs", import.meta.url);

  const mod = await import(resolve(repoRoot, "dist", "index.js"));
  const plugin = mod.default;
  if (typeof plugin?.register !== "function") die("dist/index.js has no register(); run `npm run build`");
  plugin.register(api);
  await new Promise((r) => setTimeout(r, 600));
  return config;
}

async function call(name, input) {
  const def = tools.get(name);
  if (!def) die(`tool ${name} was not registered (registered: ${[...tools.keys()].join(", ") || "none"})`);
  // Production passes (callId, params, context); the harness accepts both.
  return def.execute(`local-${Date.now()}`, input, {});
}

const text = (res) => {
  const t = res?.content?.find?.((c) => c.type === "text")?.text;
  return t ?? JSON.stringify(res, null, 2);
};

function db(config) {
  const path = config.storage?.state_db_path;
  if (!path || !existsSync(path)) die(`no state db at ${path}`);
  return new DatabaseSync(path, { readOnly: true });
}

const AGE = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

// --- commands ---------------------------------------------------------------

async function cmdCheck() {
  console.log(`\nconfig      ${existsSync(CONFIG_PATH) ? CONFIG_PATH : `MISSING -> ${CONFIG_PATH}`}`);
  if (!existsSync(CONFIG_PATH)) {
    console.log(`\n  Create it, then re-run. Minimum shape:\n`);
    console.log(
      JSON.stringify(
        {
          github_account: "your-gh-account",
          slack: { authorised_users: ["U_LOCAL"] },
          repos: { allowed: ["your-org/*"], default_base_branch: "main" },
          storage: { state_db_path: `${HOME_DIR}/state.db`, worktree_root: `${HOME_DIR}/worktrees` },
          budgets: { session_default_usd: 20, session_hard_ceiling_usd: 20 },
          pat_routing: { commit_identity: { U_LOCAL: { name: "You", email: "you@example.com" } } },
        },
        null,
        2,
      ),
    );
    return;
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  console.log(`repos       ${(config.repos?.allowed ?? []).join(", ")}`);
  console.log(`state db    ${config.storage?.state_db_path}`);
  console.log(`worktrees   ${config.storage?.worktree_root}`);
  console.log(`budget      $${config.budgets?.session_hard_ceiling_usd ?? "(default)"} hard ceiling`);
  console.log(`ANTHROPIC_API_KEY  ${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING -- workers cannot run"}`);
  if (config.github_account) {
    try {
      const t = await ghKeyringToken(config.github_account);
      console.log(`gh keyring  ${config.github_account}: token retrievable (${t.length} chars)`);
    } catch {
      console.log(`gh keyring  ${config.github_account}: NOT retrievable`);
    }
  }
  await boot();
  console.log(`\nbooted OK -- ${tools.size} tools registered`);
}

async function cmdStart(briefPath, opts) {
  if (!briefPath || !existsSync(briefPath)) die(`brief file not found: ${briefPath}`);
  const brief = JSON.parse(readFileSync(briefPath, "utf8"));
  const config = await boot();
  const requester = (config.slack?.authorised_users ?? ["U_LOCAL"])[0];
  const res = await call("harness_start_session", {
    requester,
    brief,
    budgetUsd: opts.budget ?? config.budgets?.session_default_usd ?? 20,
  });
  const out = text(res);
  console.log(out);
  const sessionId = res?.details?.sessionId ?? /([0-9a-f]{8}-[0-9a-f-]{27,})/.exec(out)?.[1];
  if (!sessionId) die("could not determine the session id; check the output above");
  console.log(`\nsession ${sessionId}`);
  if (opts.watch) await watch(config, sessionId);
  else console.log(`watch it: node scripts/local-drive.mjs watch ${sessionId}`);
}

const TERMINAL = new Set(["done", "shipped", "failed", "cancelled", "merged", "aborted"]);

async function watch(config, sessionId) {
  const conn = db(config);
  let lastId = 0;
  const started = Date.now();
  for (;;) {
    const rows = conn
      .prepare(`SELECT id, event, payload, created_at FROM audit_log WHERE session_id = ? AND id > ? ORDER BY id`)
      .all(sessionId, lastId);
    for (const r of rows) {
      lastId = r.id;
      let detail = "";
      try {
        const p = JSON.parse(r.payload ?? "{}");
        detail = Object.entries(p)
          .filter(([k]) => !["sessionId", "requester"].includes(k))
          .slice(0, 4)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60)}`)
          .join(" ");
      } catch {
        /* payload is not json; the event name is enough */
      }
      console.log(`  ${AGE(r.created_at - started).padStart(7)}  ${r.event.padEnd(38)} ${detail}`);
    }
    const s = conn.prepare(`SELECT status, clarification_question, cost_usd FROM sessions WHERE id = ?`).get(sessionId);
    if (!s) die(`no session ${sessionId}`);
    if (s.status === "awaiting_clarification") {
      console.log(`\n--- PAUSED, needs an answer -------------------------------------------\n`);
      console.log(s.clarification_question);
      console.log(`\n  node scripts/local-drive.mjs answer ${sessionId} "skip"\n`);
      return;
    }
    if (TERMINAL.has(s.status)) {
      console.log(`\n${s.status}  after ${AGE(Date.now() - started)}  $${Number(s.cost_usd ?? 0).toFixed(2)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function cmdWatch(sessionId) {
  const config = await boot();
  await watch(config, sessionId);
}

async function cmdAnswer(sessionId, answer) {
  const config = await boot();
  const requester = (config.slack?.authorised_users ?? ["U_LOCAL"])[0];
  console.log(text(await call("harness_answer", { sessionId, answer, invokedBy: requester })));
  await watch(config, sessionId);
}

async function cmdAudit(sessionId, opts) {
  const conn = db(loadConfig());
  let rows = conn
    .prepare(`SELECT event, payload, created_at FROM audit_log WHERE session_id = ? ORDER BY id`)
    .all(sessionId);
  if (opts.grep) rows = rows.filter((r) => new RegExp(opts.grep, "i").test(r.event));
  if (opts.tail) rows = rows.slice(-opts.tail);
  if (opts.json) {
    console.log(JSON.stringify(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload ?? "{}") })), null, 2));
    return;
  }
  const t0 = rows[0]?.created_at ?? 0;
  for (const r of rows) console.log(`${AGE(r.created_at - t0).padStart(8)}  ${r.event.padEnd(40)} ${r.payload ?? ""}`);
  console.log(`\n${rows.length} event(s)`);
}

/** Escape hatch: invoke any registered harness tool with a JSON payload. */
async function cmdTool(name, jsonArg) {
  const config = await boot();
  const requester = (config.slack?.authorised_users ?? ["U_LOCAL"])[0];
  const input = { requester, invokedBy: requester, ...JSON.parse(jsonArg || "{}") };
  const res = await call(name, input);
  console.log(text(res));
  if (res?.details) console.log(`\ndetails: ${JSON.stringify(res.details, null, 2)}`);
}

async function cmdSessions() {
  const conn = db(loadConfig());
  const rows = conn
    .prepare(`SELECT id, status, repo, branch, cost_usd, created_at FROM sessions ORDER BY created_at DESC LIMIT 20`)
    .all();
  if (rows.length === 0) return console.log("no sessions yet");
  for (const r of rows) {
    console.log(
      `${r.id}  ${String(r.status).padEnd(22)} $${Number(r.cost_usd ?? 0).toFixed(2).padStart(6)}  ${r.repo ?? ""}  ${r.branch ?? ""}`,
    );
  }
}

async function cmdCancel(sessionId) {
  const config = await boot();
  const requester = (config.slack?.authorised_users ?? ["U_LOCAL"])[0];
  console.log(text(await call("harness_cancel", { sessionId, invokedBy: requester, reason: "local driver" })));
}

// --- arg parsing ------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

try {
  switch (cmd) {
    case "check":
      await cmdCheck();
      break;
    case "start":
      await cmdStart(positional[0], { budget: flag("budget") ? Number(flag("budget")) : undefined, watch: has("watch") });
      break;
    case "watch":
      await cmdWatch(positional[0]);
      break;
    case "answer":
      await cmdAnswer(positional[0], positional.slice(1).join(" "));
      break;
    case "audit":
      await cmdAudit(positional[0], { grep: flag("grep"), tail: flag("tail") ? Number(flag("tail")) : undefined, json: has("json") });
      break;
    case "tool":
      await cmdTool(positional[0], argv.slice(2).find((a) => a.trim().startsWith("{")));
      break;
    case "sessions":
      await cmdSessions();
      break;
    case "cancel":
      await cmdCancel(positional[0]);
      break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 27).join("\n").replace(/^ \* ?/gm, ""));
  }
} catch (err) {
  die(String(err?.stack ?? err));
}
process.exit(0);
