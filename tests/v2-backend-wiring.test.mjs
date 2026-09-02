/**
 * The v2 backend modules are reachable from the running plugin.
 *
 * Every other v2 test drives a module directly, which is exactly how the
 * milestones came to be complete and inert at the same time: acp.ts,
 * role-config.ts, opencode-config.ts and model-catalogue.ts were all green,
 * fully tested, and referenced from nothing the plugin actually ran. A
 * `backends` block validated against the manifest and then did nothing.
 *
 * So these tests assert the WIRE, not the modules. Two kinds:
 *
 *   - a static check that the dispatch path imports the router at all, which
 *     is what actually regressed;
 *   - behavioural checks that the router routes, refuses and prices, driven
 *     through its public surface with a fake agent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { BackendRouter, buildBackendRouter, BackendConfigError } from "../dist/adapters/backend-router.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const baseInput = () => ({
  resolveKey: (service) => (service === "kimi-key" ? "sk-test-value" : undefined),
  scratchDir: "/tmp",
  logger: { info: () => {}, warn: () => {} },
  audit: () => {},
});

// ---------------------------------------------------------------------------
// The wire itself
// ---------------------------------------------------------------------------

test("the plugin entry point actually imports the backend router", () => {
  const src = readFileSync(join(root, "src", "index.ts"), "utf8");
  assert.match(
    src,
    /from "\.\/adapters\/backend-router\.js"/,
    "src/index.ts does not import the backend router, so no config can select a backend",
  );
});

test("every one of the eight roles is routed from the dispatch path", () => {
  const src = readFileSync(join(root, "src", "index.ts"), "utf8");

  // The six tool-less roles swap only their executor.
  for (const role of ["classifier", "crystalliser", "lead", "adversary", "revise_spec", "worker_context"]) {
    assert.match(
      src,
      new RegExp(`execute: executorFor\\("${role}"\\)`),
      `role '${role}' is not routed: its SDK call has no injected executor`,
    );
  }

  // The two agentic roles switch entry point entirely.
  for (const role of ["worker", "scout"]) {
    assert.match(
      src,
      new RegExp(`backendFor\\("${role}"\\)`),
      `role '${role}' never consults the router, so it always runs on claude-code`,
    );
  }
});

test("the agentic roles pass an ACP-shaped guard, not the SDK one", () => {
  const src = readFileSync(join(root, "src", "index.ts"), "utf8");
  const acpCalls = src.split("runWorkerAcp({").slice(1);
  assert.equal(acpCalls.length, 2, "expected exactly the worker and scout ACP call sites");
  for (const call of acpCalls) {
    const body = call.slice(0, 3500);
    assert.ok(
      /acpGuard: buildAcpGuard\(/.test(body) ||
        (/acpGuard: async \(call\)/.test(body) && /return workerGuard\(call\)/.test(body)),
      "an ACP call site is not passing through an ACP-shaped buildAcpGuard",
    );
    assert.doesNotMatch(
      body,
      /acpGuard: params\.canUseTool/,
      "the SDK guard keys on Claude Code tool names and allows every ACP call",
    );
  }
});

test("pricing is refreshed from the state DB, so the catalogue is not dead code", () => {
  const src = readFileSync(join(root, "src", "index.ts"), "utf8");
  assert.match(src, /refreshPricing\(catalogueStore\(state\.db\)\)/);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test("no backends block means no router, so a v1 install is untouched", () => {
  assert.equal(buildBackendRouter({ ...baseInput() }), undefined);
  assert.equal(buildBackendRouter({ ...baseInput(), backends: {} }), undefined);
});

test("a backends block that selects only claude-code still yields no router", () => {
  // Configuring the default backend explicitly must not switch on the OpenCode
  // machinery, spawn a probe, or make a network call for pricing.
  const r = buildBackendRouter({
    ...baseInput(),
    backends: { worker: { backend: "claude-code" } },
  });
  assert.equal(r, undefined);
});

test("only the roles the operator moved get an executor", () => {
  const router = buildBackendRouter({
    ...baseInput(),
    backends: { classifier: { backend: "opencode", model: "kimi/k2", tier: "basic" } },
  });
  assert.ok(router, "a moved role must produce a router");
  assert.equal(typeof router.executorFor("classifier"), "function");
  // undefined, not a pass-through wrapper: a role nobody moved should not
  // acquire a new layer between it and the SDK.
  assert.equal(router.executorFor("lead"), undefined);
  assert.equal(router.executorFor("worker"), undefined);
});

test("the judgement roles refuse a model the operator called basic", () => {
  // The floor exists because a weak model in these seats returns a well-formed
  // wrong answer rather than an obvious failure.
  for (const role of ["lead", "adversary", "crystalliser"]) {
    assert.throws(
      () =>
        buildBackendRouter({
          ...baseInput(),
          backends: { [role]: { backend: "opencode", model: "tiny/model", tier: "basic" } },
        }),
      BackendConfigError,
      `role '${role}' accepted a basic-tier model`,
    );
  }
});

test("a rejected configuration is rejected, not quietly downgraded", () => {
  let audited = null;
  assert.throws(
    () =>
      new BackendRouter({
        ...baseInput(),
        audit: (event, payload) => { if (event === "backend.config_rejected") audited = payload; },
        backends: { lead: { backend: "opencode", model: "tiny/model", tier: "basic" } },
      }),
    BackendConfigError,
  );
  assert.ok(audited, "a rejected configuration must reach the audit log");
  assert.ok(audited.problems.length > 0);
});

// ---------------------------------------------------------------------------
// Provider keys
// ---------------------------------------------------------------------------

test("a provider whose key is missing from the vault is dropped, not sent an empty key", () => {
  const dropped = [];
  const router = buildBackendRouter({
    ...baseInput(),
    audit: (event, payload) => { if (event === "backend.provider_dropped") dropped.push(payload); },
    backends: { classifier: { backend: "opencode", model: "kimi/k2", tier: "basic" } },
    providers: {
      kimi: { base_url: "https://api.example.com/v1", api_key_service: "kimi-key", models: { k2: {} } },
      ghost: { base_url: "https://gone.example.com/v1", api_key_service: "absent-key", models: { m: {} } },
    },
  });
  assert.ok(router);
  assert.deepEqual(dropped.map((d) => d.provider), ["ghost"]);
});

test("the resolved key reaches the generated config and nothing else does", () => {
  const router = buildBackendRouter({
    ...baseInput(),
    backends: { classifier: { backend: "opencode", model: "kimi/k2", tier: "basic" } },
    providers: {
      kimi: { base_url: "https://api.example.com/v1", api_key_service: "kimi-key", models: { k2: {} } },
    },
  });
  const spec = router.agentSpecFor("classifier");
  const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(JSON.stringify(cfg).includes("sk-test-value"), true, "the vault key never reached the config");
  // The service NAME is an audit-safe identifier; the vault is not a second
  // place secrets are stored, so the name must not travel as if it were one.
  assert.equal(JSON.stringify(cfg).includes("absent-key"), false);
});

test("a tool-less role is configured tool-less", () => {
  const router = buildBackendRouter({
    ...baseInput(),
    backends: {
      classifier: { backend: "opencode", model: "kimi/k2", tier: "basic" },
      worker: { backend: "opencode", model: "kimi/k2", tier: "basic" },
    },
  });
  const structured = JSON.parse(router.agentSpecFor("classifier").env.OPENCODE_CONFIG_CONTENT);
  const agentic = JSON.parse(router.agentSpecFor("worker").env.OPENCODE_CONFIG_CONTENT);

  // `permission` is deliberately identical for both -- everything is "ask",
  // so every call reaches the harness guard. The difference is `tools`, which
  // turns them off outright for a role that has no business calling any.
  assert.ok(structured.tools, "a structured role was not given a tools block");
  assert.equal(
    Object.values(structured.tools).every((v) => v === false),
    true,
    "a structured role has a tool left enabled",
  );
  assert.equal(agentic.tools, undefined, "the worker was configured tool-less and cannot do its job");
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test("tokens without a cost are priced, not recorded as a free turn", () => {
  const router = buildBackendRouter({
    ...baseInput(),
    backends: { classifier: { backend: "opencode", model: "anthropic/claude-sonnet-4-20250514", tier: "strong" } },
  });
  const priced = router.priceTurn("classifier", {
    usageSource: "tokens-only",
    costUsd: 0,
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
  });
  assert.ok(priced.costUsd > 0, "a billable provider reporting tokens-only was recorded as free");
});

test("a local provider bills nothing, and that is a real zero", () => {
  const router = buildBackendRouter({
    ...baseInput(),
    backends: { classifier: { backend: "opencode", model: "lmstudio/qwen", tier: "strong" } },
    providers: {
      lmstudio: { base_url: "http://localhost:1234/v1", local: true, models: { qwen: {} } },
    },
  });
  const priced = router.priceTurn("classifier", {
    usageSource: "tokens-only",
    costUsd: 0,
    tokensIn: 5_000_000,
    tokensOut: 5_000_000,
  });
  assert.equal(priced.costUsd, 0);
  assert.equal(priced.priceSource, "local");
});

test("an unmeasured turn reports no cost rather than a measured zero", () => {
  const router = buildBackendRouter({
    ...baseInput(),
    backends: { classifier: { backend: "opencode", model: "kimi/k2", tier: "strong" } },
  });
  const priced = router.priceTurn("classifier", {
    usageSource: "unavailable",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });
  assert.equal(priced.costUsd, undefined, "an unmeasured turn must not be indistinguishable from a free one");
  assert.equal(priced.priceSource, "unmeasured");
});

test("an agent that priced its own turn is believed", () => {
  const router = buildBackendRouter({
    ...baseInput(),
    backends: { classifier: { backend: "opencode", model: "kimi/k2", tier: "strong" } },
  });
  const priced = router.priceTurn("classifier", {
    usageSource: "acp-delta",
    costUsd: 0.42,
    tokensIn: 10,
    tokensOut: 10,
  });
  assert.equal(priced.costUsd, 0.42);
  assert.equal(priced.priceSource, "agent");
});

// ---------------------------------------------------------------------------
// The probe gate
// ---------------------------------------------------------------------------

test("a backend that fails the live probe refuses to run, rather than running unguarded", async () => {
  const router = buildBackendRouter({
    ...baseInput(),
    backends: { worker: { backend: "opencode", model: "kimi/k2", tier: "strong" } },
    // An agent that cannot launch at all is the clearest possible probe
    // failure, and must not read as "no permission problem found".
    openCodeCommand: { command: "definitely-not-a-real-binary-xyz", args: [] },
  });
  await assert.rejects(() => router.preflight(), /capability probe/i);
});

// ---------------------------------------------------------------------------
// The probe memo: success is cached, failure is not
// ---------------------------------------------------------------------------

const { memoiseSuccess } = await import("../dist/adapters/shared/once.js");

test("a transient probe failure does NOT wedge the backend until a restart", async () => {
  // The bug this replaced: `probe ??= doTheThing()`. A promise memo caches the
  // SETTLED value, and a rejection is a settled value -- so the first failure
  // was cached permanently. `preflight()` sets its own flag only on success and
  // would happily retry, but nothing ever asked it to, because every later
  // session awaited the same dead promise. One container hiccup and every
  // OpenCode role stayed down until someone restarted the gateway.
  let attempts = 0;
  const run = memoiseSuccess(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("spawn timed out");
    return "ready";
  });

  await assert.rejects(() => run(), /spawn timed out/);
  assert.equal(run.settled, false);

  // The retry is the whole point: a failure must not be terminal.
  assert.equal(await run(), "ready", "the second attempt must actually run");
  assert.equal(attempts, 2);
});

test("a success is memoised, so the probe does not re-run on every session", async () => {
  let attempts = 0;
  const run = memoiseSuccess(async () => {
    attempts += 1;
    return attempts;
  });

  assert.equal(await run(), 1);
  assert.equal(await run(), 1, "a settled success must be reused, not recomputed");
  assert.equal(attempts, 1, "the probe spawns a process; running it per session is not free");
  assert.equal(run.settled, true);
});

test("concurrent callers share one attempt rather than each spawning a probe", async () => {
  let attempts = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = memoiseSuccess(async () => {
    attempts += 1;
    await gate;
    return "ok";
  });

  const all = Promise.all([run(), run(), run()]);
  release();
  assert.deepEqual(await all, ["ok", "ok", "ok"]);
  assert.equal(attempts, 1, "three sessions arriving together must not spawn three probes");
});

test("a stale rejection does not clear a newer attempt's memo", async () => {
  // The identity check. Without it, a slow first failure landing after a second
  // attempt has started would clear the second attempt's memo, and a third
  // caller would spawn a redundant probe alongside one already in flight.
  let attempts = 0;
  let failFirst;
  const first = new Promise((_, reject) => { failFirst = reject; });
  const run = memoiseSuccess(async () => {
    attempts += 1;
    if (attempts === 1) return first;
    return "second";
  });

  const p1 = run().catch((e) => `rejected: ${e.message}`);
  failFirst(new Error("slow failure"));
  assert.equal(await p1, "rejected: slow failure");

  const p2 = run();
  // The stale rejection has already settled; it must not disturb this attempt.
  assert.equal(await p2, "second");
  assert.equal(await run(), "second", "the successful attempt stays memoised");
  assert.equal(attempts, 2);
});

test("the plugin uses the success-only memo for its probe, not a promise memo", () => {
  const src = readFileSync(join(root, "src", "index.ts"), "utf8");
  assert.match(src, /memoiseSuccess\(/, "the probe must not be memoised with a plain promise cache");
  assert.doesNotMatch(
    src,
    /backendProbe \?\?=/,
    "`??=` on a promise caches rejections forever, wedging the backend until a restart",
  );
});
