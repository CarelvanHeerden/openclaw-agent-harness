// b133's gate, taught the difference between a label and a lookup key.
//
// WHY THIS EXISTS: b133 fixed a real failure -- onboarding stored a token under
// a name no session read, reported success, and the run died an hour later at
// clone. Its gate compares the name onboarding is about to write against what
// routing resolves to.
//
// The gap is which name it compares against. `PatRouter.resolve()` returns
// `credentialService`, and on the flat legacy path that IS the vault key. On the
// hierarchy path -- and now the onboarded-route path -- it is SYNTHETIC: the
// router builds `github-acme-carel` for logs and looks the token up by
// `tokenPointer.vault` instead. Nothing is ever read by the synthetic name.
//
// So on a hierarchical setup the gate compares against a string that is never
// used, which fails in the worse of the two directions. A correct setup is
// refused; and the refusal tells the operator to align their patterns, which
// makes the gate pass while the token goes into the vault under a name still
// nothing reads. That is b133's own bug, restored one level down and now
// carrying a green check.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let registerHarnessTools, Database;
try {
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  registerHarnessTools = null;
}
const skip = registerHarnessTools === null;

const USER = "U07UT6G8LQ4";
/** What the router BUILDS for logs on a hierarchy hit. Never a lookup key. */
const SYNTHETIC = "github-stitch-vercel-carel";
/** What the router actually READS the token by. */
const POINTER = "github:stitch-vercel:carel";

/**
 * @param resolution what `gitResolutionFor` hands back -- the whole point of
 *   these tests is that its shape decides which name the gate compares against.
 */
function makeRuntime({ onboardPattern, resolution, allowed = ["Stitch-Vercel/ProjectThanos"] }) {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolvePath(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const vaultWrites = [];
  return {
    audits,
    vaultWrites,
    state: {
      db,
      isOpen: () => true,
      audit(event, payload, sessionId) { audits.push({ event, payload, sessionId }); },
      close() {},
    },
    creds: { getToken: async () => "xoxb-test" },
    vault: { set: async (service, value) => { vaultWrites.push({ service, value }); } },
    gitResolutionFor: () => resolution,
    config: {
      storage: { audit_retention_days: 90 },
      slack: { listener_enabled: false, channel: "C1", authorised_users: [USER], credential_service: "slack-bot" },
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
        onboard_service_pattern: onboardPattern,
      },
      budgets: { session_default_usd: 18 },
    },
  };
}

function collectTools(runtime) {
  const tools = new Map();
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    callTool: async () => ({ ok: true }),
    registerTool: (def) => {
      tools.set(def.name, { ...def, execute: (input) => def.execute("test-call-id", input) });
      return () => tools.delete(def.name);
    },
  };
  registerHarnessTools(api, runtime);
  return tools;
}

/** Past the gate, `submit` calls GET /user. A 401 stops the test at the network edge. */
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

const hierarchyResolution = {
  credentialService: SYNTHETIC,
  provider: "github",
  apiBase: "https://api.github.com",
  apiKeyEnv: "GH_TOKEN",
  tokenSource: "vault",
  vaultPointer: POINTER,
};

const submit = (tools) =>
  tools.get("harness_onboard").execute({ requester: USER, action: "submit", token: "ghp_averylongtoken" });

test("a name matching the POINTER gets past the gate on a hierarchical setup", { skip }, async () => {
  // The false refusal. Under the old check `expected` was the synthetic label,
  // so this correct setup was blocked from onboarding at all.
  const runtime = makeRuntime({ onboardPattern: POINTER, resolution: hierarchyResolution });
  const tools = collectTools(runtime);

  await withStubbedFetch(async (seen) => {
    const r = await submit(tools);
    assert.notEqual(r.details.patternMismatch, true, "the name the router READS must not be refused");
    assert.ok(seen.some((u) => u.endsWith("/user")), "past the gate means reaching token validation");
  });
  assert.equal(runtime.audits.some((a) => a.event === "tool.onboard.pattern_mismatch"), false);
});

test("a name matching the SYNTHETIC label is refused, because nothing reads it", { skip }, async () => {
  // The trap the old refusal walked operators into: align the patterns until
  // the gate goes green, and the token lands under a name still never read.
  const runtime = makeRuntime({ onboardPattern: SYNTHETIC, resolution: hierarchyResolution });
  const tools = collectTools(runtime);

  const r = await submit(tools);
  assert.equal(r.details.patternMismatch, true);
  assert.deepEqual(r.details.expected, [POINTER], "the operator must be shown the pointer, not the label");
  assert.equal(runtime.vaultWrites.length, 0, "nothing may reach the vault");
});

test("an unrelated name is still refused on a hierarchical setup", { skip }, async () => {
  // The gate must keep doing its original job; teaching it about pointers is
  // not licence to wave everything through.
  const runtime = makeRuntime({ onboardPattern: undefined, resolution: hierarchyResolution });
  const tools = collectTools(runtime);

  const r = await submit(tools);
  assert.equal(r.details.patternMismatch, true);
  assert.equal(r.details.writing, `git-pat:${USER}`);
  assert.deepEqual(r.details.expected, [POINTER]);
});

test("the flat legacy path still compares against credentialService", { skip }, async () => {
  // No tokenSource means no pointer, so `credentialService` IS the vault key and
  // b133's behaviour must be untouched.
  const flat = {
    credentialService: "github-stitch-vercel",
    provider: "github",
    apiBase: "https://api.github.com",
    apiKeyEnv: "GH_TOKEN",
  };
  const refused = makeRuntime({ onboardPattern: undefined, resolution: flat });
  const r = await submit(collectTools(refused));
  assert.equal(r.details.patternMismatch, true);
  assert.deepEqual(r.details.expected, ["github-stitch-vercel"]);

  const allowed = makeRuntime({ onboardPattern: "github-stitch-vercel", resolution: flat });
  await withStubbedFetch(async () => {
    const ok = await submit(collectTools(allowed));
    assert.notEqual(ok.details.patternMismatch, true);
  });
});

test("a pointer at an env var reads no vault name, so the verdict is undetermined", { skip }, async () => {
  // An env-backed route never looks a vault entry up. That is an ABSENCE of an
  // expected name, not a mismatch with one -- refusing here would block
  // onboarding on a setup that is configured perfectly well.
  const runtime = makeRuntime({
    onboardPattern: undefined,
    resolution: {
      credentialService: SYNTHETIC,
      provider: "github",
      apiBase: "https://api.github.com",
      apiKeyEnv: "GH_TOKEN",
      tokenSource: "env",
    },
  });
  const tools = collectTools(runtime);

  await withStubbedFetch(async (seen) => {
    const r = await submit(tools);
    assert.notEqual(r.details.patternMismatch, true);
    assert.ok(seen.some((u) => u.endsWith("/user")));
  });
});

test("one resolvable repo among unresolvable ones still decides the verdict", { skip }, async () => {
  // A mixed allow-list must not be diluted into "undetermined" by entries that
  // resolve to nothing; the one repo that does resolve is real evidence.
  let call = 0;
  const runtime = makeRuntime({
    onboardPattern: SYNTHETIC,
    resolution: hierarchyResolution,
    allowed: ["Stitch-Vercel/ProjectThanos", "Other/Repo"],
  });
  runtime.gitResolutionFor = () => (call++ === 0 ? undefined : hierarchyResolution);
  const tools = collectTools(runtime);

  const r = await submit(tools);
  assert.equal(r.details.patternMismatch, true);
  assert.deepEqual(r.details.expected, [POINTER]);
});
