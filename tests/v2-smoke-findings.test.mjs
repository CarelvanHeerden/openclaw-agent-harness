// Defects found by running v2.0.0-beta.1 against a real repository with the
// worker on OpenCode, rather than by reading it.
//
// The session itself passed — brief to merged-ready PR, the live probe honoured
// a real denial, the guard held, no orphaned process. Everything below is a
// thing that was WRONG while the run was GREEN, which is the only reason a
// smoke is worth the money: none of it could have been caught by a test written
// from the same understanding that produced the code.
//
//   1. The sub-task ledger recorded `config.models.worker` unconditionally, so
//      a turn served by OpenCode was filed under the Claude Code model name.
//      The A/B matrix in docs/V2_SMOKE.md reads that exact column to decide
//      whether a cheaper worker is worth adopting, so the failure is not a
//      cosmetic label — it attributes one backend's spend to the other.
//
//   2. `vault.mjs` opened (and therefore CREATED) a vault before validating the
//      command, so a typo left a fresh key file in the default directory.
//
//   3. The CLI could not be pointed at a harness config that is not the
//      gateway's openclaw.json, so the dev driver's vault and the runtime's
//      vault were different directories — the rc.2 failure, resurfacing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const S = (p) => readFileSync(resolve(root, p), "utf8");
const VAULT_CLI = resolve(root, "scripts/vault.mjs");

// Importing the CLI must not run it: the entry-point guard is what makes the
// path resolution testable at all, so this import is also a check on it.
const { runtimeVaultDir, harnessDefaults } = await import("../scripts/vault.mjs");

const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
const { BudgetEnforcer } = await import("../dist/budgets/enforcer.js");
const { PatRouter } = await import("../dist/auth/pat-router.js");
const { DatabaseSync } = await import("node:sqlite");
const SCHEMA = resolve(root, "dist/state/schema.sql");

const loopConfig = () => ({
  slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
  budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
  repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
  models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
  loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600 },
  storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
  pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
  safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git", "echo"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
});

function makeStore() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));
  return {
    db,
    audit(event, payload, sessionId) {
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
  };
}

/** Drives a whole session and hands back what the ledger recorded. */
async function ledgerModelFor(sessionId, describeWorkerModel) {
  const state = makeStore();
  state.db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, ?, 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, 50, 0, 0)`,
  ).run(sessionId, `T-${sessionId}`, Date.now(), Date.now());

  const cfg = loopConfig();
  const loop = new OrchestratorLoop({
    config: cfg,
    state,
    budget: new BudgetEnforcer(cfg.budgets, state),
    pat: new PatRouter(cfg.pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    describeWorkerModel,
    runLead: async () => ({
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s",
      subTasks: [{ seq: 1, title: "t1", intent: "do a thing", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 100 }],
      reviewChecklist: [],
      riskLevel: "low",
      approxCostUsd: 0,
    }),
    runWorker: async () => ({ status: "completed", filesChanged: [], commitSha: null, sdkSessionId: "ses_x", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    releaseWorktree: async () => ({ ok: true }),
  });

  const outcome = await loop.run(sessionId, {
    title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low",
  });
  assert.equal(outcome.status, "shipped");
  return state.db.prepare(`SELECT worker_model FROM sub_tasks WHERE session_id = ?`).get(sessionId).worker_model;
}
const scratch = (p) => mkdtempSync(resolve(tmpdir(), p));

const runVault = (args, env) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [VAULT_CLI, ...args], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(env ?? {}) },
      }),
    };
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout ?? ""), err: String(err.stderr ?? "") };
  }
};

// ---------------------------------------------------------------------------
// 1. The ledger says which engine ran, not which one was configured.
// ---------------------------------------------------------------------------

test("the sub-task ledger is told what actually ran, not config.models.worker", () => {
  const src = S("src/orchestrator/loop.ts");

  // The INSERT must not reach past the seam to the raw config value. That is
  // the whole defect: it ignored both the per-sub-task override and the route.
  const insert = src.slice(src.indexOf("INSERT OR REPLACE INTO sub_tasks"));
  const runCall = insert.slice(0, insert.indexOf(";"));
  assert.ok(
    !/this\.deps\.config\.models\.worker/.test(runCall),
    "the sub_tasks insert must not hard-code the configured worker model",
  );
  assert.match(runCall, /ledgerModel/);

  // And the value must come from the override first, then the routing seam.
  assert.match(src, /const plannedModel = selectWorkerModel\(st, this\.deps\.config\.models\)/);
  assert.match(src, /describeWorkerModel\?\.\(plannedModel\) \?\? plannedModel/);
});

test("a real session records the ENGINE that served the turn, not the configured model", async () => {
  // Behavioural on purpose. The first version of this test read loop.ts and
  // passed against a compiled loop that still hard-coded config.models.worker,
  // which is the same shape of mistake as the defect: checking the description
  // of a mechanism instead of the mechanism.
  const routed = await ledgerModelFor(
    "S_OPENCODE",
    (planned) => `opencode:anthropic-compat/claude-sonnet-4-5`.replace("$PLANNED", planned),
  );
  assert.equal(routed, "opencode:anthropic-compat/claude-sonnet-4-5");
});

test("a v1 install, with no routing seam, records exactly what it always did", async () => {
  // The other half of the guarantee. If this row ever changes shape, every
  // historical cost comparison silently shifts underneath the matrix.
  const bare = await ledgerModelFor("S_CLAUDE", undefined);
  assert.equal(bare, "claude-sonnet-5");
});

test("index.ts actually supplies the seam, so the loop is not left with the fallback", () => {
  const src = S("src/index.ts");
  assert.match(src, /describeWorkerModel: \(plannedModel\) =>/);
  assert.match(src, /return `opencode:\$\{route\.model \?\? plannedModel\}`/);
});

// ---------------------------------------------------------------------------
// 2 & 3. The vault CLI touches nothing until it understands the command, and
//        can be pointed at the config the runtime actually uses.
// ---------------------------------------------------------------------------

test("an unrecognised command creates NO vault", () => {
  const dir = scratch("vault-typo-");
  const target = join(dir, "harness-vault");

  const r = runVault(["--help", "--dir", target]);

  assert.equal(r.code, 2, "a bad command must exit 2");
  assert.match(r.err, /unknown command '--help'/);
  assert.ok(
    !existsSync(join(target, "vault.key")),
    "a typo must not generate a key file as a side effect",
  );
  assert.ok(!existsSync(target), "a typo must not create the vault directory at all");
});

test("a missing command still prints usage and writes nothing", () => {
  const dir = scratch("vault-bare-");
  const r = runVault([], { OAH_VAULT_DIR: join(dir, "harness-vault") });
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: vault\.mjs/);
  assert.equal(readdirSync(dir).length, 0);
});

test("the CLI resolves the same vault the runtime opens, given a bare harness config", () => {
  // The local dev driver hands the plugin its config directly, so the file IS
  // the harness config rather than a gateway openclaw.json with the harness
  // nested under plugins.entries. Reading only the nested shape silently
  // resolved the DEFAULT directory, which presents as an empty vault rather
  // than as the wrong one.
  const home = scratch("vault-cfg-");
  const stateDb = join(home, "state.db");
  const cfgPath = join(home, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ storage: { state_db_path: stateDb } }));

  const dir = runtimeVaultDir({ home, configPath: cfgPath, defaults: harnessDefaults() });

  assert.equal(
    dir,
    resolve(home, harnessDefaults().credentials.dir),
    "the vault must sit beside the state DB named by THIS config",
  );
});

test("the nested gateway shape still resolves, so existing installs do not move", () => {
  const home = scratch("vault-nested-");
  const stateDb = join(home, "state.db");
  const cfgPath = join(home, "openclaw.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      plugins: { entries: { "openclaw-agent-harness": { config: { storage: { state_db_path: stateDb } } } } },
    }),
  );

  assert.equal(
    runtimeVaultDir({ home, configPath: cfgPath, defaults: harnessDefaults() }),
    resolve(home, harnessDefaults().credentials.dir),
  );
});

test("--config is a real flag, not a documented intention", () => {
  const src = S("scripts/vault.mjs");
  assert.match(src, /a === "--config"/);
  assert.match(src, /runtimeVaultDir\(\{ configPath: args\.config/);
});

// ---------------------------------------------------------------------------
// 4. A provider key stored the documented way is a key the router can find.
// ---------------------------------------------------------------------------

test("the router reads api_key AND token, because the CLI stores token by default", () => {
  // `vault.mjs set <service>` defaults to type `token`. The router looked up
  // only `api_key`, so the documented way to seed a provider key produced a
  // vault entry the router reported as absent -- with a message that reads as
  // "you never stored it".
  const src = S("src/index.ts");
  const block = src.slice(src.indexOf("resolveKey: (service)"));
  const body = block.slice(0, block.indexOf("},"));
  assert.match(body, /get\(service, "api_key"\) \?\? v\.get\(service, "token"\)/);
});

