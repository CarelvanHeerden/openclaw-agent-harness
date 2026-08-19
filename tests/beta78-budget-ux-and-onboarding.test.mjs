// beta.78 — budget UX (recommend + soft session-budget warn), budget coherence
// validation, per-user daily ledger hard-stop, and per-user credential
// onboarding (/harness-onboard DM flow).
//
// Carel's four feature requests (2026-07-28):
//  1. On a new prompt, recommend a budget (soft default; warn to Slack).
//  2. At the session budget: WARN + keep going. HARD stop only at the user's
//     daily_max. Daily ledger is persistent (survives restarts, resets on the
//     UTC day rollover) + the soft warning is daily-aware (80% used -> nudge).
//  3. Incoherent budgets (daily_max > monthly) raise a loud startup warning.
//  4. /harness-onboard DMs the authorised user, validates + vaults their git
//     token as a per-user service, deletes the bot's own prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

const configMod = await import("../dist/config.js");
const onboardMod = await import("../dist/slack/onboarding.js");
const { BudgetEnforcer } = await import("../dist/budgets/enforcer.js");
const { DatabaseSync: Database } = await import("node:sqlite");
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeState() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return {
    db,
    audit() {},
  };
}

// ===========================================================================
// Feature 3: budget coherence
// ===========================================================================
test("beta78/F3: assessBudgetCoherence flags daily_max > monthly (Carel's example)", () => {
  const w = configMod.assessBudgetCoherence({
    monthly_per_user_usd: 100,
    session_default_usd: 10,
    session_hard_ceiling_usd: 50,
    daily_warn_usd: 25,
    daily_max_usd: 200,
    monthly_warn_ratio: 0.8,
  });
  assert.ok(w.length >= 1, "should produce at least one warning");
  assert.ok(w.some((x) => /daily_max_usd \(\$200\) exceeds monthly_per_user_usd \(\$100\)/.test(x)));
});

test("beta78/F3: coherent budgets produce NO warnings", () => {
  const w = configMod.assessBudgetCoherence({
    monthly_per_user_usd: 1000,
    session_default_usd: 10,
    session_hard_ceiling_usd: 50,
    daily_warn_usd: 100,
    daily_max_usd: 200,
    monthly_warn_ratio: 0.8,
  });
  assert.deepEqual(w, []);
});

test("beta78/F3: flags session_hard_ceiling > daily_max and > monthly, and warn > max", () => {
  const w = configMod.assessBudgetCoherence({
    monthly_per_user_usd: 40,
    session_default_usd: 10,
    session_hard_ceiling_usd: 60,
    daily_warn_usd: 55,
    daily_max_usd: 50,
    monthly_warn_ratio: 0.8,
  });
  assert.ok(w.some((x) => /session_hard_ceiling_usd \(\$60\) exceeds daily_max_usd \(\$50\)/.test(x)));
  assert.ok(w.some((x) => /session_hard_ceiling_usd \(\$60\) exceeds monthly_per_user_usd \(\$40\)/.test(x)));
  assert.ok(w.some((x) => /daily_warn_usd \(\$55\) exceeds daily_max_usd \(\$50\)/.test(x)));
});

test("beta78/F3: coherence warnings wired into bootstrapHarnessAsync (loud + audited)", () => {
  const src = S("src/index.ts");
  assert.match(src, /assessBudgetCoherence\(config\.budgets\)/);
  assert.match(src, /budget config INCOHERENT/);
  assert.match(src, /harness\.budget_incoherent/);
});

// ===========================================================================
// Feature 2: per-user daily ledger (persistent, UTC, restart-safe)
// ===========================================================================
test("beta78/F2: getDailySpend reads the persistent budgets_daily ledger (UTC day)", async () => {
  const state = makeState();
  const cfg = { monthly_per_user_usd: 1000, session_default_usd: 10, session_hard_ceiling_usd: 50, daily_warn_usd: 100, daily_max_usd: 200, monthly_warn_ratio: 0.8 };
  const enf = new BudgetEnforcer(cfg, state);
  assert.equal(enf.getDailySpend("U1"), 0, "fresh user starts at 0");
  await enf.recordSpend("U1", 3.5, "s1");
  await enf.recordSpend("U1", 1.25, "s1");
  assert.equal(Math.round(enf.getDailySpend("U1") * 100) / 100, 4.75, "accumulates across recordSpend calls");
  // Different user isolated.
  assert.equal(enf.getDailySpend("U2"), 0);
});

test("beta78/F2: daily ledger survives a 'restart' (new enforcer on the SAME db)", async () => {
  const state = makeState();
  const cfg = { monthly_per_user_usd: 1000, session_default_usd: 10, session_hard_ceiling_usd: 50, daily_warn_usd: 100, daily_max_usd: 200, monthly_warn_ratio: 0.8 };
  const enf1 = new BudgetEnforcer(cfg, state);
  await enf1.recordSpend("U1", 7.0, "s1");
  // Simulate a restart: a brand-new enforcer instance over the same on-disk db.
  const enf2 = new BudgetEnforcer(cfg, state);
  assert.equal(enf2.getDailySpend("U1"), 7.0, "spend persists across enforcer re-instantiation (restart)");
});

test("beta78/F2: loop session budget is SOFT (warn+continue); daily_max is the HARD stop", () => {
  const src = S("src/orchestrator/loop.ts");
  // Soft session warning (once, non-aborting).
  assert.match(src, /loop\.session_budget_warn/);
  assert.match(src, /sessionBudgetWarned = true/);
  assert.match(src, /this\.warnSessionBudgetSoft\(/);
  // Hard daily abort with reserve + audit.
  assert.match(src, /if \(dailyProjected \+ reserve > dailyMax\)/);
  assert.match(src, /loop\.daily_max_abort/);
  assert.match(src, /failed\.err = "daily_max_exhausted"/);
  // The old hard session-budget abort in the pre-subtask gate is gone.
  assert.doesNotMatch(src, /if \(totalCost > row\.budget_usd && !reactions\.budgetBump\) \{\s*failed\.err = "budget_exhausted"/);
});

test("beta78/F2: dailyMaxUsd()/safeDailySpend() are defensive (missing budgets / no getDailySpend)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /private dailyMaxUsd\(\): number/);
  assert.match(src, /this\.deps\.config\.budgets\?\.daily_max_usd/);
  assert.match(src, /private safeDailySpend\(user: string\): number/);
  assert.match(src, /typeof fn === "function"/);
});

// ===========================================================================
// Feature 1: budget recommendation + daily-aware soft warning
// ===========================================================================
test("beta78/F1: recommendBudget + daily-aware note wired into startSessionFromBrief", () => {
  const src = S("src/tools/registration.ts");
  assert.match(src, /function recommendBudget\(/);
  assert.match(src, /getDailySpend\(user\)/);
  assert.match(src, /tool\.run\.budget_recommendation/);
  // harness_run surfaces the note so the agent relays it.
  assert.match(src, /const budgetLine = res\.budgetNote/);
});

test("beta78/F1: warnSessionBudgetSoft factors REMAINING daily headroom", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /You've used \$\{pct\}% of today's budget/);
  assert.match(src, /remaining < totalCost/);
  assert.match(src, /reply with a higher budget or drop :moneybag:/);
});

test("beta78/F1+F2: postWarning is an independent direct-post channel (gated on real binding)", () => {
  const loopSrc = S("src/orchestrator/loop.ts");
  assert.match(loopSrc, /postWarning\?: \(sessionId: string, text: string\) => void/);
  const idxSrc = S("src/index.ts");
  assert.match(idxSrc, /postWarning: \(sessionId, text\) =>/);
  assert.match(idxSrc, /if \(!hasRealSlackBinding\(channel, thread\)\) return;/);
});

// ===========================================================================
// Feature 4: per-user onboarding
// ===========================================================================
test("beta78/F4: resolveOnboardVaultService default + pattern", () => {
  assert.equal(onboardMod.resolveOnboardVaultService("U123"), "git-pat:U123");
  assert.equal(
    onboardMod.resolveOnboardVaultService("U123", { pattern: "github-{provider}-{userid}", provider: "github" }),
    "github-github-U123",
  );
});

test("beta78/F4: validateGitToken hits GET /user; rejects 401/403; accepts 200 with login", async () => {
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    return { ok: true, status: 200, json: async () => ({ login: "octocat" }) };
  };
  const good = await onboardMod.validateGitToken("ghp_x", "https://api.github.com", okFetch);
  assert.equal(good.ok, true);
  assert.equal(good.login, "octocat");
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].auth, "Bearer ghp_x");

  const authFail = await onboardMod.validateGitToken("bad", "https://api.github.com", async () => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.equal(authFail.ok, false);
  assert.equal(authFail.error, "auth_401");

  // never throws
  const threw = await onboardMod.validateGitToken("x", "https://api.github.com", async () => { throw new Error("net"); });
  assert.equal(threw.ok, false);
});

test("beta78/F4: OnboardingSlack.openDm / postDm / deleteOwnMessage are best-effort via injected fetch", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body });
    if (url.endsWith("conversations.open")) return { ok: true, status: 200, json: async () => ({ ok: true, channel: { id: "D999" } }) };
    if (url.endsWith("chat.postMessage")) return { ok: true, status: 200, json: async () => ({ ok: true, ts: "111.222" }) };
    if (url.endsWith("chat.delete")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: false, status: 500, json: async () => ({ ok: false }) };
  };
  const ob = new onboardMod.OnboardingSlack({ slackToken: "xoxb-1", fetchImpl, logger: { info() {}, warn() {} } });
  const dm = await ob.openDm("U1");
  assert.equal(dm.ok, true);
  assert.equal(dm.value, "D999");
  assert.equal(seen[0].body.users, "U1");
  const post = await ob.postDm("D999", "paste your token");
  assert.equal(post.ok, true);
  assert.equal(post.value, "111.222");
  const del = await ob.deleteOwnMessage("D999", "111.222");
  assert.equal(del.ok, true);
});

test("beta78/F4: OnboardingSlack never throws on a thrown fetch", async () => {
  const ob = new onboardMod.OnboardingSlack({ slackToken: "x", fetchImpl: async () => { throw new Error("net"); }, logger: { info() {}, warn() {} } });
  const r = await ob.openDm("U1");
  assert.equal(r.ok, false);
});

test("beta78/F4: harness_onboard tool registered, authorised-gated, DM-flow, per-user vault store", () => {
  const src = S("src/tools/registration.ts");
  assert.match(src, /name: "harness_onboard"/);
  // authorised-user gate
  assert.match(src, /slack\.authorised_users\.includes\(requester\)[\s\S]*?onboarding refused/);
  // DM flow + vault store + validate + delete own prompt
  assert.match(src, /onboard\.openDm\(requester\)/);
  assert.match(src, /validateGitToken\(token\.trim\(\), apiBase\)/);
  // beta.110: the store went from memory-hybrid's credential_store tool to the
  // harness-owned vault (a library call nothing else can address).
  assert.match(src, /liveRuntime\(\)\.vault\.set\(vaultService/);
  assert.match(src, /deleteOwnMessage\(dmChannel, promptTs\)/);
  assert.match(src, /can't delete your messages, only my own/);
  // registered in manifest + expected-tools lists
  const man = JSON.parse(S("openclaw.plugin.json"));
  assert.ok(man.contracts.tools.includes("harness_onboard"));
});

test("beta78/F4: onboard_service_pattern declared in the config schema (additionalProperties:false)", () => {
  const schema = JSON.parse(S("src/config.schema.json"));
  assert.ok(schema.properties.pat_routing.properties.onboard_service_pattern, "must be declared or the whole config rejects");
});

// ===========================================================================
// version floor
// ===========================================================================
test("beta78 version is >= beta.78 (range floor)", () => {
  const pkg = JSON.parse(S("package.json"));
  const m = /^0\.1\.0-beta\.(\d+)$/.exec(pkg.version);
  assert.ok(m, `version should be 0.1.0-beta.N, got ${pkg.version}`);
  assert.ok(Number(m[1]) >= 78, `version floor beta.78, got ${pkg.version}`);
});
