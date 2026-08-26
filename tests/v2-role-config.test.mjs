/**
 * M7: per-role backend/model resolution, provider validation, and the path a
 * provider key takes from the vault to the agent.
 *
 * The cases that matter here are the partial ones. A role that sets `model` and
 * nothing else, a provider declared without a key, a `default` tier that is
 * fine for the worker and disqualifying for the adversary — these are the
 * configurations that produce a process which starts, runs, and returns
 * something shaped like an answer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BACKEND_IDS,
  DEFAULT_BACKEND,
  buildProviderBlock,
  localProviders,
  resolveAllRoles,
  resolveRoleBackend,
  splitModelId,
  validateRoleConfig,
} from "../dist/adapters/role-config.js";
import { ROLE_MIN_TIER, ROLE_NAMES } from "../dist/adapters/backend.js";

const root = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("an empty config leaves every role on claude-code", () => {
  // The upgrade property: a v1 operator who changes nothing sees no change.
  const all = resolveAllRoles({});
  for (const role of ROLE_NAMES) {
    assert.equal(all[role].backend, "claude-code", `${role} moved off the default backend`);
    assert.equal(all[role].model, undefined, `${role} acquired a model nobody set`);
  }
  assert.equal(DEFAULT_BACKEND, "claude-code");
});

test("a role inherits the default block field by field, not wholesale", () => {
  // The trap: merging whole blocks would make a role that sets only `tier`
  // silently lose the default's backend and model.
  const cfg = {
    default: { backend: "opencode", model: "local/qwen", tier: "strong" },
    roles: { worker: { tier: "basic" } },
  };
  const worker = resolveRoleBackend("worker", cfg);
  assert.equal(worker.backend, "opencode", "setting tier dropped the inherited backend");
  assert.equal(worker.model, "local/qwen", "setting tier dropped the inherited model");
  assert.equal(worker.tier, "basic", "the role's own tier did not win");
});

test("a role's own values beat the default", () => {
  const cfg = {
    default: { backend: "opencode", model: "local/qwen" },
    roles: { adversary: { backend: "claude-code", model: "claude-fable-5" } },
  };
  const adv = resolveRoleBackend("adversary", cfg);
  assert.equal(adv.backend, "claude-code");
  assert.equal(adv.model, "claude-fable-5");
  assert.equal(adv.inherited, false);

  // ...and a sibling still gets the default.
  assert.equal(resolveRoleBackend("worker", cfg).backend, "opencode");
  assert.equal(resolveRoleBackend("worker", cfg).inherited, true);
});

test("provider/model splits on the FIRST slash", () => {
  // Model ids legitimately contain slashes. Splitting on the last one would
  // address a provider that does not exist, and the error would name a
  // provider the operator never wrote.
  assert.deepEqual(splitModelId("openrouter/anthropic/claude-3"), {
    provider: "openrouter",
    model: "anthropic/claude-3",
  });
  assert.deepEqual(splitModelId("local/qwen-coder"), { provider: "local", model: "qwen-coder" });

  // Bare ids stay bare: that is what v1 configs hold.
  assert.deepEqual(splitModelId("claude-fable-5"), { model: "claude-fable-5" });

  // Degenerate forms are not treated as qualified.
  assert.deepEqual(splitModelId("/leading"), { model: "/leading" });
  assert.deepEqual(splitModelId("trailing/"), { model: "trailing/" });
});

test("the provider is surfaced from a qualified model id", () => {
  const r = resolveRoleBackend("worker", { roles: { worker: { model: "local/qwen-coder" } } });
  assert.equal(r.provider, "local");
});

// ---------------------------------------------------------------------------
// The capability floor
// ---------------------------------------------------------------------------

test("the judgement roles refuse a basic model, the others accept one", () => {
  const problems = validateRoleConfig({ default: { backend: "opencode", model: "local/q", tier: "basic" } });
  const blocked = new Set(problems.filter((p) => /requires at least/.test(p.message)).map((p) => p.role));

  for (const role of ROLE_NAMES) {
    const needsStrong = ROLE_MIN_TIER[role] !== "basic";
    assert.equal(blocked.has(role), needsStrong,
      `${role} floor=${ROLE_MIN_TIER[role]} was ${blocked.has(role) ? "" : "not "}blocked`);
  }
  // Specifically the three the design names.
  for (const role of ["lead", "adversary", "crystalliser"]) assert.ok(blocked.has(role), `${role} not gated`);
});

test("the floor message says WHY, not just that it failed", () => {
  const [p] = validateRoleConfig({ roles: { adversary: { tier: "basic" } } })
    .filter((x) => x.role === "adversary" && /requires at least/.test(x.message));
  assert.ok(p, "no floor problem reported for a basic adversary");
  assert.match(p.message, /well-formed, wrong/,
    "the message does not explain that the failure mode is a confident wrong answer");
});

test("a role above its floor passes", () => {
  const problems = validateRoleConfig({ default: { tier: "frontier" } });
  assert.deepEqual(problems.filter((p) => /requires at least/.test(p.message)), []);
});

// ---------------------------------------------------------------------------
// Provider validation
// ---------------------------------------------------------------------------

test("a base_url that does not end in /v1 is rejected", () => {
  // The shim appends /chat/completions, so this is a 404 on the first call and
  // silence before it.
  const problems = validateRoleConfig({ providers: { local: { base_url: "http://localhost:1234" } } });
  assert.ok(problems.some((p) => p.provider === "local" && /end in \/v1/.test(p.message)));

  // Trailing slashes are tolerated.
  assert.deepEqual(
    validateRoleConfig({ providers: { local: { base_url: "http://localhost:1234/v1/" } } })
      .filter((p) => p.provider === "local"),
    [],
  );
});

test("a provider with no base_url, or a non-http one, is rejected", () => {
  assert.ok(validateRoleConfig({ providers: { local: {} } })
    .some((p) => /no base_url/.test(p.message)));
  assert.ok(validateRoleConfig({ providers: { local: { base_url: "localhost:1234/v1" } } })
    .some((p) => /http\(s\) URL/.test(p.message)));
});

test("an unsupported npm package is rejected by name", () => {
  const problems = validateRoleConfig({
    providers: { x: { npm: "@ai-sdk/anthropic", base_url: "http://h/v1" } },
  });
  assert.ok(problems.some((p) => p.provider === "x" && /@ai-sdk\/openai-compatible/.test(p.message)));
});

test("a role pointing at an undeclared provider is flagged, but only when custom providers exist", () => {
  // With providers declared, an unknown one is probably a typo.
  const typo = validateRoleConfig({
    providers: { local: { base_url: "http://h/v1" } },
    roles: { worker: { backend: "opencode", model: "lcoal/qwen" } },
  });
  assert.ok(typo.some((p) => p.role === "worker" && /not declared/.test(p.message)));

  // With none declared, `anthropic/claude-x` is a built-in and must not be
  // rejected — a false rejection here is worse than a missed typo.
  const builtin = validateRoleConfig({
    roles: { worker: { backend: "opencode", model: "anthropic/claude-x" } },
  });
  assert.deepEqual(builtin.filter((p) => /not declared/.test(p.message)), []);
});

test("an opencode structured role with no model is rejected", () => {
  const problems = validateRoleConfig({ roles: { classifier: { backend: "opencode" } } });
  assert.ok(problems.some((p) => p.role === "classifier" && /no default the harness can assume/.test(p.message)));
});

test("validation reports every problem, not just the first", () => {
  const problems = validateRoleConfig({
    providers: { a: { base_url: "nope" }, b: {} },
    roles: { lead: { tier: "basic" }, adversary: { tier: "basic" } },
  });
  // Two provider faults and two floor faults, in one pass.
  assert.ok(problems.length >= 4, `expected >=4 problems, got ${problems.length}`);
  assert.ok(problems.some((p) => p.provider === "a"));
  assert.ok(problems.some((p) => p.provider === "b"));
  assert.ok(problems.some((p) => p.role === "lead"));
  assert.ok(problems.some((p) => p.role === "adversary"));
});

test("a clean configuration produces no problems at all", () => {
  const problems = validateRoleConfig({
    providers: { local: { base_url: "http://localhost:1234/v1", api_key_service: "local-llm", local: true } },
    default: { backend: "claude-code", tier: "strong" },
    roles: { worker: { backend: "opencode", model: "local/qwen-coder", tier: "basic" } },
  });
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// The key path
// ---------------------------------------------------------------------------

test("a provider key is resolved from the vault into the config document", () => {
  const { block, dropped } = buildProviderBlock(
    { local: { base_url: "http://localhost:1234/v1", api_key_service: "local-llm" } },
    (service) => (service === "local-llm" ? "sk-secret-value" : undefined),
  );
  assert.deepEqual(dropped, []);
  assert.equal(block.local.npm, "@ai-sdk/openai-compatible");
  assert.equal(block.local.options.baseURL, "http://localhost:1234/v1");
  assert.equal(block.local.options.apiKey, "sk-secret-value");
});

test("the key is literal, never an {env:...} reference", () => {
  // The env form would require the secret in the child's environment, which is
  // precisely what the M5 deny-list exists to prevent. The config document is
  // the one carrier.
  const { block } = buildProviderBlock(
    { local: { base_url: "http://h/v1", api_key_service: "svc" } },
    () => "sk-real",
  );
  assert.equal(block.local.options.apiKey, "sk-real");
  assert.doesNotMatch(JSON.stringify(block), /\{env:/, "a key was emitted as an env reference");
});

test("a provider whose key is missing is DROPPED, not emitted with an empty key", () => {
  // An absent provider fails as "unknown provider". An empty key fails as a
  // 401, which reads like the key is wrong rather than missing — and sends the
  // operator to rotate a credential that was never there.
  const { block, dropped } = buildProviderBlock(
    { local: { base_url: "http://h/v1", api_key_service: "absent" } },
    () => undefined,
  );
  assert.deepEqual(Object.keys(block), []);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].provider, "local");
  assert.match(dropped[0].reason, /absent/);
});

test("a provider that needs no key is kept", () => {
  // A local server with auth disabled is a legitimate configuration.
  const { block, dropped } = buildProviderBlock(
    { local: { base_url: "http://localhost:1234/v1" } },
    () => undefined,
  );
  assert.deepEqual(dropped, []);
  assert.equal(block.local.options.baseURL, "http://localhost:1234/v1");
  assert.equal(block.local.options.apiKey, undefined);
});

test("name and models pass through, and nothing else does", () => {
  const { block } = buildProviderBlock(
    { local: { base_url: "http://h/v1", name: "Local", models: { q: { name: "Qwen" } }, local: true } },
    () => undefined,
  );
  assert.equal(block.local.name, "Local");
  assert.deepEqual(block.local.models, { q: { name: "Qwen" } });
  // `local` is a harness-side accounting flag; OpenCode has no such key and
  // would be receiving a field it does not understand.
  assert.equal(block.local.local, undefined, "the harness-only 'local' flag leaked into the agent config");
});

test("local providers are identified for token-only accounting", () => {
  const set = localProviders({
    lmstudio: { local: true, base_url: "http://h/v1" },
    openai: { base_url: "https://api.openai.com/v1" },
  });
  assert.ok(set.has("lmstudio"));
  assert.ok(!set.has("openai"));
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the config surface is declared in both the manifest and the schema", () => {
  // The M7 documentation check owns the general rule; this pins the two blocks
  // this milestone adds, so a later edit that drops one is a named failure.
  const manifest = JSON.parse(readFileSync(resolve(root, "openclaw.plugin.json"), "utf8"));
  const schema = JSON.parse(readFileSync(resolve(root, "src/config.schema.json"), "utf8"));

  for (const [label, doc] of [["manifest", manifest.configSchema], ["schema", schema]]) {
    assert.ok(doc.properties.backends, `${label} does not declare 'backends'`);
    assert.ok(doc.properties.providers, `${label} does not declare 'providers'`);
    for (const role of [...ROLE_NAMES, "default"]) {
      assert.ok(doc.properties.backends.properties[role], `${label} 'backends' is missing role '${role}'`);
    }
    const entry = doc.properties.backends.properties.worker.properties;
    assert.deepEqual(entry.backend.enum, [...BACKEND_IDS], `${label} backend enum drifted from BACKEND_IDS`);
  }
});

test("role-config knows nothing about any specific backend implementation", () => {
  // It names backend IDS, which is the point; it must not import one.
  const src = readFileSync(resolve(root, "src/adapters/role-config.ts"), "utf8");
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(!/claude-code|acp|@anthropic/.test(spec), `role-config imports a backend: ${spec}`);
  }
});
