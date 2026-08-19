// Onboarding that writes BOTH halves: the secret and the route to it.
//
// WHY THIS EXISTS: the old tool stored a token under one flat per-user name.
// That cannot express the case this whole area was rebuilt for -- one person
// holding DIFFERENT tokens for different orgs -- and it wrote no routing entry
// at all, because `pat_routing` lives in read-only config. So the token landed
// in the vault under a name no session looked up, every step reported success,
// and the run died an hour later at clone.
//
// `add` now writes the vault entry AND the route, so the two cannot disagree.
// The tests that matter most here are the refusals: an org an operator already
// configured (writing there would be inert), a token that authenticates as
// somebody else (their commits would push with it), and a token that cannot
// actually reach the org (valid, and useless, and only discovered at clone).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let registerHarnessTools, Database, RouteOverlay, PatRouter, openStateStoreSync;
try {
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ RouteOverlay } = await import("../dist/auth/route-overlay.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ openStateStoreSync } = await import("../dist/state/store.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  registerHarnessTools = null;
}
const skip = registerHarnessTools === null;

const USER = "U07UT6G8LQ4";
const OTHER = "U0ATALIA000";
const LOGIN = "carelvanheerden";

/** An in-memory stand-in; the real vault has its own suite. */
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

function makeRuntime({ patRouting = {}, allowed = ["stitch-vercel/web"] } = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolvePath(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const vault = fakeVault();
  const overlay = new RouteOverlay(db);
  const config = {
    storage: { audit_retention_days: 90 },
    slack: { listener_enabled: false, channel: "C1", authorised_users: [USER, OTHER], credential_service: null },
    repos: { allowed },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c", auth: { credential_service: "anthropic-x" } },
    pat_routing: {
      overrides: {},
      commit_identity: {},
      default_service_pattern: "github-{owner}",
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
    creds: { getToken: async () => { throw new Error("no slack token in these tests"); } },
    routeOverlay: overlay,
    gitResolutionFor: () => undefined,
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
 * @param opts.login what GET /user answers with
 * @param opts.repoStatus what GET /repos/<full_name> answers with
 */
async function withFetch({ login = LOGIN, name = "Carel van Heerden", email = null, repoStatus = 200, userStatus = 200, expiry = null }, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.endsWith("/user")) {
      return {
        ok: userStatus === 200,
        status: userStatus,
        headers: { get: (h) => (h === "github-authentication-token-expiration" ? expiry : null) },
        json: async () => ({ login, name, email }),
      };
    }
    return { ok: repoStatus === 200, status: repoStatus, headers: { get: () => null }, json: async () => ({}) };
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

const add = (tools, over = {}) =>
  tools.get("harness_onboard").execute({
    requester: USER, action: "add", orgUrl: "https://github.com/stitch-vercel", token: "ghp_averylongtoken", ...over,
  });

test("add stores the secret AND the route the router reads", { skip }, async () => {
  // The two halves. Either one alone is the failure this was rebuilt to stop.
  const rt = makeRuntime();
  const tools = collectTools(rt);

  const r = await withFetch({}, () => add(tools));
  assert.equal(r.details.ok, true);
  assert.equal(r.details.org, "stitch-vercel");
  assert.equal(r.details.person, LOGIN);

  const service = r.details.vaultService;
  assert.equal(rt.vault.get(service), "ghp_averylongtoken", "the secret must be stored");

  // And the route must actually resolve, through the real router.
  const resolved = new PatRouter(rt.config.pat_routing, rt.overlay).resolve({
    slackUserId: USER, gitHubUser: "stitch-vercel", repoFullName: "stitch-vercel/web",
  });
  assert.equal(resolved.provenance, "overlay");
  assert.deepEqual(resolved.tokenPointer, { vault: service });
});

test("one person, two orgs, two different tokens", { skip }, async () => {
  // The case a flat per-user name could not express: the second onboarding
  // used to overwrite the first, and runs pushed with the wrong org's token.
  const rt = makeRuntime({ allowed: ["stitch-vercel/web", "stitch-money/api"] });
  const tools = collectTools(rt);

  await withFetch({}, () => add(tools, { token: "ghp_vercel_token" }));
  await withFetch({}, () => add(tools, { orgUrl: "https://github.com/stitch-money", token: "ghp_money_token" }));

  const router = new PatRouter(rt.config.pat_routing, rt.overlay);
  const one = router.resolve({ slackUserId: USER, gitHubUser: "stitch-vercel", repoFullName: "stitch-vercel/web" });
  const two = router.resolve({ slackUserId: USER, gitHubUser: "stitch-money", repoFullName: "stitch-money/api" });

  assert.notEqual(one.tokenPointer.vault, two.tokenPointer.vault, "each org needs its own vault entry");
  assert.equal(rt.vault.get(one.tokenPointer.vault), "ghp_vercel_token");
  assert.equal(rt.vault.get(two.tokenPointer.vault), "ghp_money_token");
});

test("adding an org that is already configured points at replace", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({}, () => add(tools));

  const r = await withFetch({}, () => add(tools, { token: "ghp_second_token" }));
  assert.equal(r.details.ok, false);
  assert.equal(r.details.alreadyConfigured, true);
  assert.match(r.content[0].text, /replace/);
  assert.equal(rt.vault.get("github:stitch-vercel:carelvanheerden"), "ghp_averylongtoken", "the first token must be untouched");
});

test("replace swaps the token, keeps the vault name, and keeps created_at", { skip }, async () => {
  // The vault name has to survive: it is what the routing entry points at, so
  // renaming it on rotation would break the very lookup this fixes.
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({}, () => add(tools));
  const first = rt.overlay.lookup("github", "stitch-vercel", USER);

  const r = await withFetch({}, () =>
    tools.get("harness_onboard").execute({
      requester: USER, action: "replace", orgUrl: "https://github.com/stitch-vercel", token: "ghp_rotated_token",
    }),
  );
  assert.equal(r.details.ok, true);
  const after = rt.overlay.lookup("github", "stitch-vercel", USER);
  assert.equal(after.vaultService, first.vaultService, "the pointer must not move");
  assert.equal(after.createdAt, first.createdAt, "a rotation must not look like a new credential");
  assert.equal(rt.vault.get(after.vaultService), "ghp_rotated_token");
  assert.match(r.content[0].text, /[Rr]evoke/, "the old token is still live at the provider");
});

test("replace refuses a token belonging to a different account", { skip }, async () => {
  // The escalation the identity check exists to stop. `requester` is an
  // argument on an agent-relayed call, so without this someone could point
  // another person's route at THEIR token and that person's commits would
  // push with it.
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({}, () => add(tools));

  const r = await withFetch({ login: "someone-else" }, () =>
    tools.get("harness_onboard").execute({
      requester: USER, action: "replace", orgUrl: "https://github.com/stitch-vercel", token: "ghp_intruder_token",
    }),
  );
  assert.equal(r.details.ok, false);
  assert.equal(r.details.identityMismatch, true);
  assert.equal(rt.vault.get("github:stitch-vercel:carelvanheerden"), "ghp_averylongtoken", "nothing may be overwritten");
  assert.ok(rt.audits.some((a) => a.event === "tool.onboard.identity_mismatch"));
});

test("a token that cannot reach the org is refused, not stored", { skip }, async () => {
  // GET /user proves a token is live, not that it can see this org. A
  // fine-grained PAT scoped elsewhere validates fine and then fails at clone.
  const rt = makeRuntime();
  const tools = collectTools(rt);

  const r = await withFetch({ repoStatus: 404 }, () => add(tools));
  assert.equal(r.details.ok, false);
  assert.equal(r.details.noReach, true);
  assert.equal(rt.vault.list().length, 0, "nothing may reach the vault");
  assert.equal(rt.overlay.listForRequester(USER).length, 0, "and no route may be written");
});

test("an org an operator configured by hand is not shadowed", { skip }, async () => {
  // Config is read first, so a row written here would never be reached.
  // Reporting success would be a lie with a green tick.
  const rt = makeRuntime({
    patRouting: {
      github: {
        "stitch-vercel": {
          Carel: { token: { vault: "operator-chosen" }, name: "Carel", email: "c@stitch.money", slack_user_id: USER },
        },
      },
    },
  });
  const tools = collectTools(rt);

  const r = await withFetch({}, () => add(tools));
  assert.equal(r.details.ok, false);
  assert.equal(r.details.configShadow, true);
  assert.equal(rt.vault.list().length, 0);
  assert.ok(rt.audits.some((a) => a.event === "tool.onboard.config_shadow"));
});

test("remove needs a confirmation, then takes both halves away", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({}, () => add(tools));

  const first = await tools.get("harness_onboard").execute({ requester: USER, action: "remove", orgUrl: "https://github.com/stitch-vercel" });
  assert.equal(first.details.needsConfirm, true);
  assert.equal(rt.vault.list().length, 1, "an unconfirmed remove must change nothing");

  const done = await tools.get("harness_onboard").execute({ requester: USER, action: "remove", orgUrl: "https://github.com/stitch-vercel", confirm: true });
  assert.equal(done.details.ok, true);
  assert.equal(rt.overlay.lookup("github", "stitch-vercel", USER), undefined);
  assert.equal(rt.vault.list().length, 0);
  assert.match(done.content[0].text, /revoke/i, "deleting here does not revoke at the provider");
});

test("list reports the orgs and never a secret", { skip }, async () => {
  const rt = makeRuntime({ allowed: ["stitch-vercel/web", "stitch-money/api"] });
  const tools = collectTools(rt);
  await withFetch({}, () => add(tools, { token: "ghp_vercel_token" }));
  await withFetch({}, () => add(tools, { orgUrl: "https://github.com/stitch-money", token: "ghp_money_token" }));

  const r = await tools.get("harness_onboard").execute({ requester: USER, action: "list" });
  assert.equal(r.details.ok, true);
  assert.equal(r.details.routes.length, 2);
  const blob = JSON.stringify(r);
  assert.equal(blob.includes("ghp_vercel_token"), false, "a listing must never carry a token");
  assert.equal(blob.includes("ghp_money_token"), false);
  assert.match(r.content[0].text, /stitch-vercel/);
  assert.match(r.content[0].text, /stitch-money/);
});

test("list shows only the caller's own credentials", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({}, () => add(tools));

  const r = await tools.get("harness_onboard").execute({ requester: OTHER, action: "list" });
  assert.deepEqual(r.details.routes, [], "one person must not be shown another's credentials");
});

test("list flags a route whose secret has gone missing", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({}, () => add(tools));
  rt.vault.store.clear(); // e.g. a vault restored from an older backup

  const r = await tools.get("harness_onboard").execute({ requester: USER, action: "list" });
  assert.equal(r.details.routes[0].secretPresent, false);
  assert.match(r.content[0].text, /missing/);
});

test("a token expiry is recorded and surfaced", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({ expiry: "2027-09-01 12:00:00 UTC" }, () => add(tools));

  const route = rt.overlay.lookup("github", "stitch-vercel", USER);
  assert.equal(route.tokenExpiresAt, Date.parse("2027-09-01T12:00:00Z"));
  const r = await tools.get("harness_onboard").execute({ requester: USER, action: "list" });
  assert.match(r.content[0].text, /2027-09-01/);
});

test("a bad org URL is refused before any token is touched", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  const r = await add(tools, { orgUrl: "https://bitbucket.org/acme" });
  assert.equal(r.details.ok, false);
  assert.match(r.details.badOrgUrl, /not a configured git provider/);
  assert.equal(rt.vault.list().length, 0);
});

test("an invalid token is never stored", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  const r = await withFetch({ userStatus: 401 }, () => add(tools));
  assert.equal(r.details.invalidToken, true);
  assert.equal(rt.vault.list().length, 0);
  assert.equal(rt.overlay.listForRequester(USER).length, 0);
});

test("if the route cannot be written, add leaves no orphan secret", { skip }, async () => {
  // Storing the secret and failing to record the route is precisely the state
  // that fails an hour later at clone, so `add` must not leave it behind.
  const rt = makeRuntime();
  const tools = collectTools(rt);
  rt.routeOverlay = {
    lookup: () => undefined,
    listForRequester: () => [],
    listForOrg: () => [],
    upsert: () => { throw new Error("disk full"); },
    remove: () => false,
  };

  const r = await withFetch({}, () => add(tools));
  assert.equal(r.details.ok, false);
  assert.match(r.details.routeThrew, /disk full/);
  assert.equal(rt.vault.list().length, 0, "the secret must be rolled back");
});

test("the org is stored case-folded, however the URL was typed", { skip }, async () => {
  // A URL preserves whatever was pasted. Store "Stitch-Vercel" verbatim and
  // the lookup for "stitch-vercel" misses -- a token nothing reads, by nothing
  // but capitalisation.
  const rt = makeRuntime();
  const tools = collectTools(rt);
  const r = await withFetch({}, () => add(tools, { orgUrl: "https://GitHub.com/Stitch-Vercel" }));

  // Reported back and audited in canonical form, so the name in a log matches
  // the key a later lookup uses.
  assert.equal(r.details.org, "stitch-vercel");
  assert.equal(rt.audits.find((a) => a.event === "tool.onboard.route_added").payload.org, "stitch-vercel");
  assert.ok(rt.overlay.lookup("github", "stitch-vercel", USER));
  const resolved = new PatRouter(rt.config.pat_routing, rt.overlay).resolve({
    slackUserId: USER, gitHubUser: "Stitch-Vercel", repoFullName: "Stitch-Vercel/web",
  });
  assert.equal(resolved.provenance, "overlay");
});

test("commit identity falls back to the provider account, then to noreply", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({ name: "Carel van Heerden", email: null }, () => add(tools));

  const route = rt.overlay.lookup("github", "stitch-vercel", USER);
  assert.equal(route.commitName, "Carel van Heerden");
  assert.equal(route.commitEmail, `${LOGIN}@users.noreply.github.com`, "a private email must not become empty");
});

test("an explicit commit identity wins over the provider's", { skip }, async () => {
  const rt = makeRuntime();
  const tools = collectTools(rt);
  await withFetch({}, () => add(tools, { commitName: "Carel", commitEmail: "carel@stitch.money" }));

  const route = rt.overlay.lookup("github", "stitch-vercel", USER);
  assert.equal(route.commitName, "Carel");
  assert.equal(route.commitEmail, "carel@stitch.money");
});

test("with nothing concrete to check, reach is undetermined rather than refused", { skip }, async () => {
  // A wildcard allow-list gives nothing to test against. An undetermined
  // answer must not become a refusal, or onboarding breaks on setups that are
  // configured perfectly well.
  const rt = makeRuntime({ allowed: ["stitch-vercel/*"] });
  const tools = collectTools(rt);

  const r = await withFetch({ repoStatus: 404 }, (seen) => add(tools).then((res) => {
    assert.equal(seen.some((u) => u.includes("/repos/")), false, "there was nothing concrete to probe");
    return res;
  }));
  assert.equal(r.details.ok, true);
});
