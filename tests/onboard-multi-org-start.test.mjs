// The DM that asks WHICH org, before it asks for a token.
//
// WHY THIS EXISTS: `start` used to compute one vault name out of
// `onboard_service_pattern` and then post "reply with your token". Both halves
// were wrong for anyone in more than one place. The name was decided before
// anything knew which provider or org the token was for, so a second
// onboarding overwrote the first; and the prompt gave the person no way to say
// which org they were pasting a token for, because it never asked.
//
// So `start` now establishes provider and org FIRST -- named up front when an
// org URL is supplied, asked for when it is not -- and the reply is stored by
// `add`, which derives the vault name from provider, org and person together.
// The tests that matter most here are the ones proving two credentials for one
// human coexist rather than clobbering each other: two orgs on one provider,
// and the same org name on two providers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let registerHarnessTools, Database, RouteOverlay, PatRouter;
try {
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ RouteOverlay } = await import("../dist/auth/route-overlay.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  registerHarnessTools = null;
}
const skip = registerHarnessTools === null ? "build not present (npm run build)" : false;

const USER = "U07UT6G8LQ4";
const LOGIN = "carelvanheerden";
const DM = "D0PRIVATE";

function fakeVault() {
  const store = new Map();
  return {
    store,
    get: (s) => store.get(s)?.value,
    set: (s, value, opts) => { store.set(s, { value, type: opts?.type ?? "token", createdAt: 1, updatedAt: 1 }); },
    delete: (s) => store.delete(s),
    list: () => [...store.entries()].map(([service, r]) => ({ service, type: r.type, createdAt: r.createdAt, updatedAt: r.updatedAt })),
  };
}

function makeRuntime({ patRouting = {}, allowed = ["stitch-vercel/web"], gitResolutionFor = () => undefined } = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolvePath(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const vault = fakeVault();
  const overlay = new RouteOverlay(db);
  const config = {
    storage: { audit_retention_days: 90 },
    // credential_service is what lets `start` open a DM at all.
    slack: { listener_enabled: false, channel: "C1", authorised_users: [USER], credential_service: "slack-bot" },
    repos: { allowed },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c", auth: { credential_service: "anthropic-x" } },
    pat_routing: {
      overrides: {},
      commit_identity: {},
      default_service_pattern: "{provider}-{owner}",
      default_provider: "github",
      provider_by_owner: {},
      providers: {
        github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" },
        gitlab: { api_base: "https://gitlab.com/api/v4", api_key_env: "GITLAB_TOKEN" },
      },
      ...patRouting,
    },
    budgets: { session_default_usd: 18 },
  };
  return {
    audits, vault, overlay, db, config,
    state: { db, isOpen: () => true, audit(e, p) { audits.push({ event: e, payload: p }); }, close() {} },
    creds: { getToken: async () => "xoxb-test" },
    routeOverlay: overlay,
    gitResolutionFor,
  };
}

function collectTools(runtime) {
  const tools = new Map();
  registerHarnessTools(
    {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      callTool: async () => ({ ok: true }),
      registerTool: (def) => {
        tools.set(def.name, { ...def, execute: (i) => def.execute("cid", i) });
        return () => tools.delete(def.name);
      },
    },
    runtime,
  );
  return tools;
}

/**
 * Stubs Slack AND the git provider, and records every DM body posted so the
 * prompt itself can be asserted on -- the wording is the feature here.
 */
async function withSlack({ login = LOGIN, repoStatus = 200 } = {}, fn) {
  const real = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("conversations.open")) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, channel: { id: DM } }) };
    }
    if (u.endsWith("chat.postMessage")) {
      posted.push(JSON.parse(init.body).text);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: "1.1" }) };
    }
    if (u.endsWith("chat.delete")) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
    }
    if (u.endsWith("/user")) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ login, name: "Carel", email: null }) };
    }
    return { ok: repoStatus === 200, status: repoStatus, headers: { get: () => null }, json: async () => ({}) };
  };
  try {
    return await fn(posted);
  } finally {
    globalThis.fetch = real;
  }
}

const onboard = (tools, input) => tools.get("harness_onboard").execute({ requester: USER, ...input });

// ---------------------------------------------------------------------------
// 1. A URL states the provider and the org, so the DM can name both
// ---------------------------------------------------------------------------

test("start with an org URL names the provider, the org and the vault key", { skip }, async () => {
  const tools = collectTools(makeRuntime());
  const [r, posted] = await withSlack({}, async (posted) => [
    await onboard(tools, { action: "start", orgUrl: "https://github.com/stitch-vercel" }),
    posted,
  ]);

  assert.equal(r.details.ok, true);
  assert.equal(r.details.provider, "github");
  assert.equal(r.details.org, "stitch-vercel");

  const dm = posted.at(-1);
  assert.match(dm, /github/, "the DM must say which provider");
  assert.match(dm, /stitch-vercel/, "the DM must say which org");
  assert.match(dm, /github:stitch-vercel:/, "the DM must show the vault key the token lands under");
  assert.match(dm, /will not disturb any other org/i, "it must say why the key is shaped that way");
});

test("start names GitLab when the URL is a GitLab one", { skip }, async () => {
  // The old prompt could only ever have said "github", because the provider was
  // a default rather than an answer.
  const tools = collectTools(makeRuntime());
  const [r, posted] = await withSlack({}, async (posted) => [
    await onboard(tools, { action: "start", orgUrl: "https://gitlab.com/stitch-vercel" }),
    posted,
  ]);

  assert.equal(r.details.provider, "gitlab");
  assert.match(posted.at(-1), /gitlab:stitch-vercel:/);
});

test("a URL naming an unconfigured host is refused BEFORE the DM opens", { skip }, async () => {
  // Asking for a token and only then rejecting the org it was for burns a live
  // secret in a chat log.
  const tools = collectTools(makeRuntime());
  const [r, posted] = await withSlack({}, async (posted) => [
    await onboard(tools, { action: "start", orgUrl: "https://bitbucket.org/acme" }),
    posted,
  ]);

  assert.equal(r.details.ok, false);
  assert.ok(r.details.badOrgUrl, "the parse failure must be reported");
  assert.equal(posted.length, 0, "no DM may be posted for an org we cannot route");
});

test("start on an org already configured says it will REPLACE, and names the live key", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withSlack({}, () => onboard(tools, { action: "add", orgUrl: "https://github.com/stitch-vercel", token: "ghp_averylongtoken" }));

  const [, posted] = await withSlack({}, async (posted) => [
    await onboard(tools, { action: "start", orgUrl: "https://github.com/stitch-vercel" }),
    posted,
  ]);

  const dm = posted.at(-1);
  assert.match(dm, /REPLACE/, "someone re-onboarding an org must be told the old token stops being used");
  assert.match(dm, new RegExp(`github:stitch-vercel:${LOGIN}`), "and the key named must be the real one, not the placeholder");
});

// ---------------------------------------------------------------------------
// 2. No URL: ASK, rather than assume github + default_service_pattern
// ---------------------------------------------------------------------------

test("start without an org URL asks which provider and which org", { skip }, async () => {
  const tools = collectTools(makeRuntime());
  const [r, posted] = await withSlack({}, async (posted) => [
    await onboard(tools, { action: "start" }),
    posted,
  ]);

  assert.equal(r.details.ok, true);
  assert.equal(r.details.provider, null, "nothing may be assumed about the provider yet");
  assert.equal(r.details.org, null);

  const dm = posted.at(-1);
  assert.match(dm, /which org this token is for/i, "it has to ASK");
  assert.match(dm, /`github`/, "and offer the providers this deployment has");
  assert.match(dm, /`gitlab`/);
  assert.match(dm, /separate token is needed for EACH org/i, "and say tokens are per org");
  assert.doesNotMatch(dm, /saved in the vault as/i, "it must not name a vault key it cannot know yet");
});

test("the providers offered are the ones configured, not a hard-coded pair", { skip }, async () => {
  // Inviting a GitLab token on a deployment with no GitLab provider produces a
  // token that cannot be routed anywhere.
  const tools = collectTools(makeRuntime({
    patRouting: { providers: { github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" } } },
  }));
  const [, posted] = await withSlack({}, async (posted) => [await onboard(tools, { action: "start" }), posted]);

  assert.match(posted.at(-1), /`github`/);
  assert.doesNotMatch(posted.at(-1), /`gitlab`/, "a provider nobody configured must not be offered");
});

// ---------------------------------------------------------------------------
// 3. The point of all of it: two credentials for one human, neither clobbered
// ---------------------------------------------------------------------------

test("two orgs on one provider produce two distinct keys, neither overwriting the other", { skip }, async () => {
  const rt = makeRuntime({ allowed: ["stitch-vercel/web", "stitch-money/api"] });
  const tools = collectTools(rt);

  await withSlack({}, () => onboard(tools, { action: "add", orgUrl: "https://github.com/stitch-vercel", token: "ghp_vercel" }));
  await withSlack({}, () => onboard(tools, { action: "add", orgUrl: "https://github.com/stitch-money", token: "ghp_money" }));

  const router = new PatRouter(rt.config.pat_routing, rt.overlay);
  const vercel = router.resolve({ slackUserId: USER, gitHubUser: "stitch-vercel", repoFullName: "stitch-vercel/web" });
  const money = router.resolve({ slackUserId: USER, gitHubUser: "stitch-money", repoFullName: "stitch-money/api" });

  assert.notEqual(vercel.tokenPointer.vault, money.tokenPointer.vault);
  assert.equal(rt.vault.get(vercel.tokenPointer.vault), "ghp_vercel");
  assert.equal(rt.vault.get(money.tokenPointer.vault), "ghp_money", "the second onboarding must not have overwritten the first");
  assert.equal(rt.vault.list().length, 2, "two orgs means two stored secrets, not one survivor");
});

test("github and gitlab for the same person and the same org name stay separate", { skip }, async () => {
  // The sharpest version: identical org, identical person, different provider.
  // Under the old `github-{owner}` default both collapsed onto one name, so
  // onboarding the GitLab token silently destroyed the GitHub one.
  const rt = makeRuntime({ allowed: ["stitch-vercel/web"] });
  const tools = collectTools(rt);

  await withSlack({}, () => onboard(tools, { action: "add", orgUrl: "https://github.com/stitch-vercel", token: "ghp_github_token" }));
  await withSlack({}, () => onboard(tools, { action: "add", orgUrl: "https://gitlab.com/stitch-vercel", token: "glpat_gitlab_token" }));

  const routes = rt.overlay.listForRequester(USER);
  assert.equal(routes.length, 2, "one route per provider");
  const keys = routes.map((r) => r.vaultService);
  assert.equal(new Set(keys).size, 2, "the two providers must not share a vault key");

  const byProvider = Object.fromEntries(routes.map((r) => [r.provider, r.vaultService]));
  assert.equal(rt.vault.get(byProvider.github), "ghp_github_token");
  assert.equal(rt.vault.get(byProvider.gitlab), "glpat_gitlab_token", "the GitLab token must not have landed on the GitHub key");
  assert.equal(rt.vault.list().length, 2);
});

// ---------------------------------------------------------------------------
// 4. The flat flow is now something you ask for
// ---------------------------------------------------------------------------

test("flat submit is refused once per-org credentials exist, and allowed with legacy:true", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withSlack({}, () => onboard(tools, { action: "add", orgUrl: "https://github.com/stitch-vercel", token: "ghp_averylongtoken" }));

  const refused = await withSlack({}, () => onboard(tools, { action: "submit", token: "ghp_flat_token" }));
  assert.equal(refused.details.ok, false);
  assert.equal(refused.details.flatRefused, true, "a flat token alongside per-org ones is an ambiguity, not a convenience");

  // Explicit opt-in still works, which is what makes it a fallback rather than
  // a removal.
  const forced = await withSlack({}, () => onboard(tools, { action: "submit", token: "ghp_flat_token", legacy: true }));
  assert.notEqual(forced.details.flatRefused, true);
});

// ---------------------------------------------------------------------------
// 5. The consistency gate only compares against the provider being onboarded
// ---------------------------------------------------------------------------

test("a GitLab token is not judged against the names GitHub repos resolve to", { skip }, async () => {
  // Every allow-listed repo is GitHub. Comparing a GitLab onboarding against
  // those names is guaranteed to look like a mismatch, and the refusal then
  // advises aligning the patterns -- which would break the GitHub side to
  // satisfy a comparison that was never valid.
  const tools = collectTools(makeRuntime({
    allowed: ["stitch-vercel/web"],
    patRouting: { onboard_service_pattern: "git-pat:{userid}" },
    gitResolutionFor: (repo) => (repo ? { credentialService: "github-stitch-vercel", provider: "github", apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN" } : undefined),
  }));

  const r = await withSlack({}, () => onboard(tools, { action: "start", provider: "gitlab", legacy: true }));
  assert.notEqual(r.details.patternMismatch, true, "no GitLab repo is allow-listed, so there is nothing to disagree with");
});

test("the gate still fires for the provider actually being onboarded", { skip }, async () => {
  // The other half: scoping must not become a way to never check anything.
  const tools = collectTools(makeRuntime({
    allowed: ["stitch-vercel/web"],
    patRouting: { onboard_service_pattern: "git-pat:{userid}" },
    gitResolutionFor: (repo) => (repo ? { credentialService: "github-stitch-vercel", provider: "github", apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN" } : undefined),
  }));

  const r = await withSlack({}, () => onboard(tools, { action: "start", provider: "github", legacy: true }));
  assert.equal(r.details.patternMismatch, true, "a GitHub onboarding IS comparable against a GitHub repo");
});
