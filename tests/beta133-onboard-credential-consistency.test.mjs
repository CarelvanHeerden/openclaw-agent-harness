/**
 * beta.133: the onboarded token nothing could read.
 *
 * Setting up a fresh OpenClaw box, the plan was to let `harness_onboard` put the
 * GitHub PAT in the vault. It would have worked, in the sense that every step
 * reported success: the token validates against GET /user, the vault stores it,
 * the bot deletes its own prompt and confirms in the DM. Then the first session
 * dies at clone with `credential 'github-stitch-vercel' not found in vault`.
 *
 * The two halves never shared a placeholder. Onboarding writes from
 * `onboard_service_pattern`, default `git-pat:{userid}` -- a raw Slack id. The
 * pat-router reads from `default_service_pattern`, default `github-{owner}`, and
 * its most user-specific placeholder, `{requester}`, is the provider *login*.
 * No setting of either pattern could make them agree for a per-user token, and
 * the doc comment on `onboard_service_pattern` had been telling operators to
 * "keep this consistent" with a pattern it had no vocabulary to match.
 *
 * Two changes. `{userid}` now exists on the reading side too, so consistency is
 * expressible. And onboarding refuses to store a token under a name no session
 * will look up, instead of discovering it an hour later at clone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let PatRouter, onboardMod, registerHarnessTools, Database;
try {
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  onboardMod = await import("../dist/slack/onboarding.js");
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  PatRouter = null;
}
const skip = PatRouter === null;

function routing(extra = {}) {
  return {
    overrides: {},
    commit_identity: {},
    default_service_pattern: "github-{owner}",
    default_provider: "github",
    provider_by_owner: {},
    providers: {
      github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" },
      gitlab: { api_base: "https://gitlab.com/api/v4", api_key_env: "GITLAB_TOKEN" },
    },
    ...extra,
  };
}

function resolveFor(pattern, slackUserId, repoFullName = "Stitch-Vercel/ProjectThanos") {
  const router = new PatRouter(routing({ default_service_pattern: pattern }));
  return router.resolve({
    slackUserId,
    gitHubUser: repoFullName.split("/")[0],
    repoFullName,
  }).credentialService;
}

// ---------------------------------------------------------------------------
// The placeholder that was missing
// ---------------------------------------------------------------------------

test("beta133: {userid} on the reading side resolves the requester's Slack id", { skip }, () => {
  assert.equal(resolveFor("git-pat:{userid}", "U07UT6G8LQ4"), "git-pat:U07UT6G8LQ4");
});

test("beta133: {userid} keeps its case while {owner} is still folded", { skip }, () => {
  // Slack ids are upper-case and onboarding substitutes them verbatim. Folding
  // case here would produce a name that misses the vault entry by exactly the
  // characters the operator can least easily see.
  assert.equal(resolveFor("{owner}/{userid}", "U07UT6G8LQ4"), "stitch-vercel/U07UT6G8LQ4");
});

test("beta133: a per-user setup can now be written consistently on both sides", { skip }, () => {
  const requester = "U07UT6G8LQ4";
  const writes = onboardMod.resolveOnboardVaultService(requester, { pattern: "git-pat:{userid}", provider: "github" });
  const reads = resolveFor("git-pat:{userid}", requester);

  assert.equal(writes, reads, "the whole point of the change: these two strings must be capable of matching");
  assert.equal(onboardMod.checkOnboardConsistency(writes, [reads]).ok, true);
});

test("beta133: the shipped defaults are still a mismatch, which is why the check exists", { skip }, () => {
  const requester = "U07UT6G8LQ4";
  const writes = onboardMod.resolveOnboardVaultService(requester); // git-pat:{userid}
  const reads = resolveFor("github-{owner}", requester); // github-stitch-vercel

  assert.notEqual(writes, reads);
  const verdict = onboardMod.checkOnboardConsistency(writes, [reads]);
  assert.equal(verdict.ok, false, "leaving both defaults alone must be caught, not tolerated");
  assert.deepEqual(verdict.expected, ["github-stitch-vercel"]);
});

// ---------------------------------------------------------------------------
// checkOnboardConsistency, in isolation
// ---------------------------------------------------------------------------

test("beta133: a name among those the router reads is accepted", { skip }, () => {
  const v = onboardMod.checkOnboardConsistency("github-acme", ["github-other", "github-acme"]);
  assert.equal(v.ok, true);
  assert.equal(v.undetermined, false);
});

test("beta133: a name nobody reads is rejected, and says what IS read", { skip }, () => {
  const v = onboardMod.checkOnboardConsistency("git-pat:U1", ["github-acme"]);
  assert.equal(v.ok, false);
  assert.equal(v.writing, "git-pat:U1");
  assert.deepEqual(v.expected, ["github-acme"]);
});

test("beta133: nothing to compare against is 'undetermined', never a refusal", { skip }, () => {
  // An empty allow-list, or routing that declined to resolve, is not evidence
  // of a mismatch. Blocking there would break onboarding for setups that are
  // configured perfectly well.
  for (const expected of [[], [""], ["   "]]) {
    const v = onboardMod.checkOnboardConsistency("git-pat:U1", expected);
    assert.equal(v.ok, true, `empty-ish input ${JSON.stringify(expected)} must not block`);
    assert.equal(v.undetermined, true);
  }
});

test("beta133: expected names are de-duplicated and trimmed before reporting", { skip }, () => {
  const v = onboardMod.checkOnboardConsistency("nope", [" github-acme ", "github-acme", "github-acme"]);
  assert.deepEqual(v.expected, ["github-acme"], "an allow-list of ten repos on one owner should not print ten times");
  assert.equal(v.ok, false);
});

test("beta133: a match is judged on the trimmed name", { skip }, () => {
  assert.equal(onboardMod.checkOnboardConsistency(" github-acme ", ["github-acme"]).ok, true);
});

// ---------------------------------------------------------------------------
// Through the real tool
// ---------------------------------------------------------------------------

function makeRuntime({ onboardPattern, resolvedService = "github-stitch-vercel", allowed = ["Stitch-Vercel/ProjectThanos"] } = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const resolutionCalls = [];
  const vaultWrites = [];
  return {
    audits,
    resolutionCalls,
    vaultWrites,
    state: {
      db,
      isOpen: () => true,
      audit(event, payload, sessionId) { audits.push({ event, payload, sessionId }); },
      close() {},
    },
    creds: { getToken: async () => "xoxb-test" },
    gitResolutionFor: (repoFullName, slackUserId) => {
      resolutionCalls.push({ repoFullName, slackUserId });
      return { credentialService: resolvedService, provider: "github", apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN" };
    },
    config: {
      storage: { audit_retention_days: 90 },
      slack: { listener_enabled: false, channel: "C1", authorised_users: ["U07UT6G8LQ4"], credential_service: "slack-bot" },
      repos: { allowed },
      models: { lead: "l", worker: "w", adversary: "a", classifier: "c", auth: { credential_service: "anthropic-x" } },
      pat_routing: { ...routing(), onboard_service_pattern: onboardPattern },
      budgets: { session_default_usd: 18 },
    },
  };
}

function collectTools(runtime) {
  const tools = new Map();
  const calls = [];
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    callTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
    registerTool: (def) => {
      tools.set(def.name, { ...def, execute: (input) => def.execute("test-call-id", input) });
      return () => tools.delete(def.name);
    },
  };
  registerHarnessTools(api, runtime);
  return { tools, calls };
}

test("beta133: onboarding refuses rather than storing a token nothing reads", { skip }, async () => {
  const runtime = makeRuntime({ onboardPattern: undefined }); // default git-pat:{userid}
  const { tools, calls } = collectTools(runtime);

  const r = await tools.get("harness_onboard").execute({ requester: "U07UT6G8LQ4", action: "submit", token: "ghp_averylongtoken" });

  assert.equal(r.details.ok, false);
  assert.equal(r.details.patternMismatch, true);
  assert.equal(r.details.writing, "git-pat:U07UT6G8LQ4");
  assert.deepEqual(r.details.expected, ["github-stitch-vercel"]);
  assert.match(r.content[0].text, /github-stitch-vercel/, "the operator must be told the name that IS read");
  assert.match(r.content[0].text, /\{userid\}/, "and how to fix it");

  assert.equal(calls.filter((c) => c.name === "credential_store").length, 0, "nothing may reach the vault");
  assert.ok(runtime.audits.some((a) => a.event === "tool.onboard.pattern_mismatch"));
});

test("beta133: the refusal happens before the DM, not after the token is pasted", { skip }, async () => {
  const runtime = makeRuntime({ onboardPattern: undefined });
  const { tools } = collectTools(runtime);

  // 'start' must fail the same way. If only 'submit' checked, the user would be
  // asked for a secret in a DM before being told it could never be used.
  //
  // legacy:true because this gate guards the FLAT flow, which is the only flow
  // that commits to a vault name before knowing the org. Plain 'start' now asks
  // which org the token is for and hands the answer to 'add', which derives the
  // name from the org and writes the route with it -- there is no pattern left
  // to disagree with. The guarantee is unchanged for the flow that needs it.
  const r = await tools.get("harness_onboard").execute({ requester: "U07UT6G8LQ4", action: "start", legacy: true });
  assert.equal(r.details.patternMismatch, true);
});

test("beta133: the per-org 'start' needs no pattern agreement, so it is not refused", { skip }, async () => {
  // Same deployment, same irreconcilable patterns. Without legacy:true nothing
  // is being stored under a pattern-derived name yet, so refusing here would
  // block an onboarding that is going to work.
  const runtime = makeRuntime({ onboardPattern: undefined });
  const { tools } = collectTools(runtime);

  const r = await tools.get("harness_onboard").execute({ requester: "U07UT6G8LQ4", action: "start" });
  assert.notEqual(r.details.patternMismatch, true, "the per-org flow must not inherit the flat flow's gate");
});

/** Keeps the suite off the network: past the gate, `submit` calls GET /user. */
async function withStubbedFetch(fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: false, status: 401, json: async () => ({}) };
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

test("beta133: a consistent pattern gets past the gate", { skip }, async () => {
  const runtime = makeRuntime({ onboardPattern: "github-stitch-vercel" });
  const { tools, calls } = collectTools(runtime);

  await withStubbedFetch(async (seen) => {
    const r = await tools.get("harness_onboard").execute({ requester: "U07UT6G8LQ4", action: "submit", token: "ghp_averylongtoken" });

    assert.notEqual(r.details.patternMismatch, true, "a name the router reads must not be blocked");
    assert.ok(seen.some((u) => u.endsWith("/user")), "getting past the gate means reaching token validation");
  });

  assert.equal(runtime.audits.some((a) => a.event === "tool.onboard.pattern_mismatch"), false);
  assert.equal(calls.filter((c) => c.name === "credential_store").length, 0, "a token that fails validation is still never stored");
});

test("beta133: an empty allow-list cannot be judged, so onboarding proceeds", { skip }, async () => {
  const runtime = makeRuntime({ onboardPattern: undefined, allowed: [] });
  const { tools } = collectTools(runtime);

  await withStubbedFetch(async (seen) => {
    const r = await tools.get("harness_onboard").execute({ requester: "U07UT6G8LQ4", action: "submit", token: "ghp_averylongtoken" });
    assert.notEqual(r.details.patternMismatch, true);
    assert.ok(seen.some((u) => u.endsWith("/user")));
  });
});

test("beta133: resolution is asked for THIS requester, not the first authorised user", { skip }, async () => {
  const runtime = makeRuntime({ onboardPattern: undefined });
  const { tools } = collectTools(runtime);

  await tools.get("harness_onboard").execute({ requester: "U07UT6G8LQ4", action: "submit", token: "ghp_averylongtoken" });

  assert.ok(runtime.resolutionCalls.length > 0, "the check must actually consult routing");
  for (const call of runtime.resolutionCalls) {
    assert.equal(call.slackUserId, "U07UT6G8LQ4", "a {userid} pattern resolves differently per user; the wrong id makes the check meaningless");
    assert.equal(call.repoFullName, "Stitch-Vercel/ProjectThanos");
  }
});
