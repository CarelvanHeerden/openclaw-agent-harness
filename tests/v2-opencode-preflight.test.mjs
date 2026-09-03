// v2.0.0 M6 — configuring OpenCode to ask, and proving that it does.
//
// The M2 capability probe measured OpenCode on default configuration running
// four shell commands and two file edits while issuing ZERO permission
// requests. Nothing errored. The harness guard was simply never called, so the
// bash whitelist and the path deny-list were inert while still reading as
// enabled in openclaw.json.
//
// Two mechanisms follow from that, and they are separate on purpose.
//
// The configuration is the fix: `permission` set for every tool, injected
// through OPENCODE_CONFIG_CONTENT so it takes precedence over any on-disk
// opencode.json and cannot be edited by the worker it constrains.
//
// The live probe is the proof. Every step between "the config is right" and
// "the agent asks" can fail silently — the variable may not reach the child, a
// version may have renamed a key, managed preferences may shadow the document.
// In all of those cases the configuration still LOOKS correct. And a guard that
// is never called is indistinguishable from a guard that approved everything,
// which is why inspecting configuration is not enough on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const S = (p) => readFileSync(resolve(root, p), "utf8");
const FIXTURE = resolve(root, "tests/fixtures/fake-acp-agent.mjs");

const cfg = await import("../dist/adapters/opencode-config.js");
const { probeAcpPermissionEnforcement, preflightAcpBackend, preflightAcpBackendLive } =
  await import("../dist/adapters/acp.js");

const agent = (scenario, env) => ({
  command: process.execPath,
  args: [FIXTURE],
  env: { FAKE_ACP_SCENARIO: scenario, ...(env ?? {}) },
});
const scratch = () => mkdtempSync(resolve(tmpdir(), "acp-m6-"));

// ---------------------------------------------------------------------------
// The configuration document
// ---------------------------------------------------------------------------

/**
 * The EXACT set, not a length floor.
 *
 * A floor was the original assertion and it hid three wrong entries and eight
 * missing ones for a whole milestone: `>= 10` is satisfied just as happily by
 * a list containing `todoread`, which does not exist, as by the real one.
 *
 * Pinned to the `v1.18.23` tag (`ef2880f3`), verified in the source and
 * against the running binary. When the pin moves, this test is SUPPOSED to go
 * red -- that is the review prompt to re-check the registry, and the whole
 * reason the version is pinned in the first place.
 */
const EXPECTED_PERMISSION_KEYS = [
  "bash", "edit", "read", "glob", "grep", "task", "todowrite", "webfetch",
  "websearch", "skill", "lsp", "question", "external_directory", "doom_loop",
  "plan_enter", "plan_exit", "write", "apply_patch", "mcp_*",
];

const EXPECTED_TOOL_IDS = [
  "bash", "read", "glob", "grep", "edit", "write", "apply_patch", "task",
  "webfetch", "websearch", "todowrite", "skill", "question", "lsp", "execute",
  "plan_exit",
];

test("the permission keys are exactly OpenCode 1.18.23's, not a superset or a guess", () => {
  assert.deepEqual(
    [...cfg.OPENCODE_PERMISSION_KEYS].sort(),
    [...EXPECTED_PERMISSION_KEYS].sort(),
    "the permission key list has drifted from the pinned OpenCode version",
  );

  // The keys that do NOT exist in 1.18.23, and shipped anyway. `patch` is
  // spelled `apply_patch`; `list` is dead in the schema; `todoread` never
  // existed. Each one read as a guarded tool and guarded nothing.
  for (const dead of ["patch", "list", "todoread"]) {
    assert.equal(
      cfg.OPENCODE_PERMISSION_KEYS.includes(dead),
      false,
      `'${dead}' is not a permission key in 1.18.23; naming it creates false confidence`,
    );
  }
});

test("the tool ids are a separate list from the permission keys, because they are different things", () => {
  assert.deepEqual([...cfg.OPENCODE_TOOL_IDS].sort(), [...EXPECTED_TOOL_IDS].sort());
  // Feeding the permission list to `tools` was the original bug: it disables
  // things that are not tools, and misses `execute`, which is.
  assert.equal(cfg.OPENCODE_TOOL_IDS.includes("execute"), true);
  assert.equal(cfg.OPENCODE_TOOL_IDS.includes("external_directory"), false);
  assert.equal(cfg.OPENCODE_TOOL_IDS.includes("mcp_*"), false);
});

test("every permission key is named explicitly, with the wildcard first", () => {
  const c = cfg.buildOpenCodeConfig();
  for (const key of cfg.OPENCODE_PERMISSION_KEYS) {
    assert.equal(c.permission[key], "ask", `${key} must be named explicitly`);
  }
  // The two the probe actually measured as dangerous by default.
  assert.equal(c.permission.bash, "ask");
  assert.equal(c.permission.edit, "ask");
  // The network egress channel the first list missed entirely.
  assert.equal(c.permission.websearch, "ask");
});

test("the wildcard is emitted FIRST, because last-match-wins makes ordering load-bearing", () => {
  // Not cosmetic. OpenCode evaluates rules last-match-wins by insertion order,
  // so a catch-all emitted LAST would override every specific "ask" we set --
  // harmless while everything is "ask", and a silent hole the moment it is not.
  const keys = Object.keys(cfg.buildOpenCodeConfig().permission);
  assert.equal(keys[0], "*", "the catch-all must be the first key, per OpenCode's precedence rules");
});

test("a hostile repo config cannot allow a named permission past us", () => {
  // The real attack, and the reason naming keys is load-bearing rather than
  // decorative. `permission` is deep-merged per key and our document merges
  // LAST, but merging preserves the target's key ORDER -- so an overwritten
  // key keeps the repo's position. A repo shipping {"*":"allow","websearch":
  // "allow"} therefore beats an injected {"*":"ask"} outright: our wildcard
  // lands at position 0, their websearch still sits after it, and last-match
  // hands the model unguarded egress.
  const repoConfig = { "*": "allow", websearch: "allow", bash: "allow" };
  const ours = cfg.buildOpenCodeConfig().permission;

  // remeda's mergeDeep: source overwrites target in place, new keys appended.
  const merged = { ...repoConfig };
  for (const [k, v] of Object.entries(ours)) merged[k] = v;

  // Last-match-wins over insertion order, which is what OpenCode does.
  const effective = (permission) =>
    Object.entries(merged)
      .filter(([rule]) => rule === permission || rule === "*")
      .at(-1)?.[1];

  assert.equal(effective("websearch"), "ask", "a named key must survive a hostile repo config");
  assert.equal(effective("bash"), "ask");
});

test("nothing in the generated config is ever set to allow", () => {
  // A single "allow" anywhere is a hole the guard cannot see through.
  const c = cfg.buildOpenCodeConfig({ provider: { local: { options: { baseURL: "http://x" } } }, model: "local/m" });
  for (const [k, v] of Object.entries(c.permission)) {
    assert.equal(v, "ask", `permission.${k} must be "ask", got ${JSON.stringify(v)}`);
  }
});

test("a tool-less role gets tools switched off as well as gated", () => {
  const c = cfg.buildOpenCodeConfig({ toolless: true });
  for (const tool of cfg.OPENCODE_TOOL_IDS) {
    assert.equal(c.tools[tool], false, `${tool} must be disabled for a structured role`);
  }
  for (const key of cfg.OPENCODE_PERMISSION_KEYS) {
    assert.equal(c.permission[key], "ask", "and still gated, in case tools:false is not honoured");
  }
  // An agentic role must NOT have tools disabled, or the worker cannot work.
  assert.equal(cfg.buildOpenCodeConfig().tools, undefined);
});

test("provider and model travel in the same document", () => {
  const c = cfg.buildOpenCodeConfig({
    provider: { myllm: { options: { baseURL: "http://127.0.0.1:1234/v1", apiKey: "k" } } },
    model: "myllm/kimi-k3",
  });
  assert.equal(c.model, "myllm/kimi-k3");
  assert.deepEqual(c.provider.myllm.options.baseURL, "http://127.0.0.1:1234/v1");
  // Empty provider blocks are omitted rather than sent as {}.
  assert.equal(cfg.buildOpenCodeConfig({ provider: {} }).provider, undefined);
});

test("the config reaches the agent as one environment variable", () => {
  const env = cfg.openCodeConfigEnv();
  assert.ok(env.OPENCODE_CONFIG_CONTENT, "the variable name is written in exactly one place");
  const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(parsed.permission["*"], "ask");
});

test("the config is injected, never written into the worktree", () => {
  // A file inside the worktree would put the control inside the thing the
  // worker can edit: rewrite opencode.json, re-run, guard gone.
  const src = S("src/adapters/opencode-config.ts");
  assert.match(src, /OPENCODE_CONFIG_CONTENT/);
  assert.doesNotMatch(src, /writeFileSync|mkdirSync/, "the config must not be written to disk");
  assert.match(src, /INSIDE the thing the\s*\n \* worker can edit/);
});

test("the config document is redacted from logs", async () => {
  // It becomes a credential the moment M7 puts provider keys in it.
  const { redactValue } = await import("../dist/state/interaction-log.js");
  const env = cfg.openCodeConfigEnv({ provider: { p: { options: { apiKey: "sk-secret-value" } } } });
  assert.doesNotMatch(JSON.stringify(redactValue(env)), /sk-secret-value/);
});

// ---------------------------------------------------------------------------
// The live probe
// ---------------------------------------------------------------------------

test("a correctly configured agent passes the probe", async () => {
  const r = await probeAcpPermissionEnforcement({
    agent: agent("probe-asks"),
    cwd: scratch(),
    timeoutSeconds: 20,
  });
  assert.equal(r.ok, true, `probe should pass: ${r.reasons.join(" | ")}`);
  assert.equal(r.sawPermissionRequest, true);
  assert.equal(r.denialHonoured, true);
  assert.match(r.detail, /honoured a denial/);
});

test("the probe DENIES the call it asks for", async () => {
  // A probe that approves is half a test. The denial path is the one the
  // containment story rests on, so that is the one exercised.
  const src = S("src/adapters/acp.ts");
  assert.match(src, /allow: false, reason: "capability probe/);
  assert.match(src, /It DENIES the call/);
});

test("an agent that never asks FAILS the probe", async () => {
  // The measured default, and the whole reason this exists.
  const r = await probeAcpPermissionEnforcement({
    agent: agent("probe-never-asks"),
    cwd: scratch(),
    timeoutSeconds: 20,
  });
  assert.equal(r.ok, false);
  assert.equal(r.sawPermissionRequest, false);
  assert.match(r.reasons[0], /WITHOUT ever asking permission/);
  // The message has to tell an operator what is actually broken, not just that
  // something is.
  assert.match(r.reasons[0], /OPENCODE_CONFIG_CONTENT is not reaching the agent/);
  assert.match(r.reasons[0], /bash whitelist, path deny-list/);
  assert.match(r.reasons[0], /reading as enabled in openclaw\.json/);
});

test("an agent that asks and then ignores the answer FAILS the probe", async () => {
  const r = await probeAcpPermissionEnforcement({
    agent: agent("probe-asks-then-ignores"),
    cwd: scratch(),
    timeoutSeconds: 20,
  });
  assert.equal(r.ok, false);
  assert.equal(r.sawPermissionRequest, true, "it did ask; that is not the problem");
  assert.match(r.reasons[0], /asks and then\s+proceeds anyway|proceeds anyway/);
});

test("an agent that writes SILENTLY after a refusal FAILS the probe", async () => {
  // The gap in the original probe. It asked the model whether it had complied
  // -- `/created|written|wrote/` against the final message -- so an agent that
  // bypassed the guard and simply did not narrate it passed cleanly. That is
  // the more dangerous of the two bypasses, and it was the one that got
  // through. The probe now reads the filesystem.
  const dir = scratch();
  const r = await probeAcpPermissionEnforcement({
    agent: agent("probe-asks-then-writes-silently"),
    cwd: dir,
    timeoutSeconds: 20,
  });
  assert.equal(r.ok, false, "a silent write past a refusal must fail the probe");
  assert.equal(r.sawPermissionRequest, true, "it did ask; the asking was never the problem");
  assert.match(r.reasons[0], /WROTE .*\.txt to disk/, "the failure must name the evidence on disk");
});

test("a wedged agent FAILS the probe rather than hanging the harness", async () => {
  const r = await probeAcpPermissionEnforcement({
    agent: agent("silent"),
    cwd: scratch(),
    timeoutSeconds: 2,
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /no usable turn before the probe deadline/);
});

test("an agent that cannot be launched FAILS the probe instead of crashing the harness", async () => {
  // Found by writing this test. A spawn failure -- a mistyped command, a
  // binary that is not installed -- arrives as an asynchronous `error` event,
  // not as a throw from spawn(). Nothing was listening, so it was an uncaught
  // exception that took the whole harness process down rather than failing one
  // turn. In production that is a mistyped `worker_backend`.
  const r = await probeAcpPermissionEnforcement({
    agent: { command: resolve(root, "no-such-binary-anywhere"), args: [] },
    cwd: scratch(),
    timeoutSeconds: 5,
  });
  assert.equal(r.ok, false);
  assert.equal(r.denialHonoured, false);
  assert.match(r.reasons[0], /could not be run at all/);
  assert.match(r.reasons[0], /ENOENT|could not be started/);
});

test("every failure path fails CLOSED", async () => {
  // Stated as one property: there is no route through the probe where "we could
  // not tell" comes back as ok, and "we could not tell" is precisely what the
  // broken case looks like from outside.
  for (const scenario of ["probe-never-asks", "probe-asks-then-ignores", "probe-asks-then-writes-silently", "silent", "no-first-token", "refusal"]) {
    const r = await probeAcpPermissionEnforcement({
      agent: agent(scenario),
      cwd: scratch(),
      timeoutSeconds: 2,
    });
    assert.equal(r.ok, false, `scenario '${scenario}' must not pass the probe`);
    assert.ok(r.reasons.length > 0, `scenario '${scenario}' must say why`);
    assert.equal(r.denialHonoured, false);
  }
});

// ---------------------------------------------------------------------------
// Static inspection and the live probe together
// ---------------------------------------------------------------------------

test("static inspection still runs first, and its message is more specific", async () => {
  // "permission.bash is 'allow'" tells an operator what to edit; the live probe
  // can only say "it did not ask".
  const bad = preflightAcpBackend({ agentId: "opencode", backendConfig: { permission: { bash: "allow" } } });
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(" "), /permission\.bash is "allow"/);

  const r = await preflightAcpBackendLive({
    agentId: "opencode",
    backendConfig: { permission: { bash: "allow", edit: "ask" } },
    agent: agent("probe-asks"),
    cwd: scratch(),
    timeoutSeconds: 20,
  });
  assert.equal(r.ok, false, "a bad config is refused without spending a probe turn");
  assert.equal(r.detail, "refused on configuration inspection");
});

test("a clean static result does NOT skip the probe", async () => {
  // The whole point: config that reads correctly and behaviour that is not.
  const r = await preflightAcpBackendLive({
    agentId: "opencode",
    backendConfig: cfg.buildOpenCodeConfig(),
    agent: agent("probe-never-asks"),
    cwd: scratch(),
    timeoutSeconds: 20,
  });
  assert.equal(r.ok, false, "clean configuration must not be taken as proof of behaviour");
  assert.match(r.reasons[0], /WITHOUT ever asking permission/);
});

test("the generated config passes its own static inspection", () => {
  // If the document the harness generates were itself refused, the two halves
  // would disagree and the operator would have no way forward.
  const r = preflightAcpBackend({ agentId: "opencode", backendConfig: cfg.buildOpenCodeConfig() });
  assert.equal(r.ok, true, `the harness's own config was refused: ${r.reasons.join(" | ")}`);
});

test("both halves land together for a correctly configured backend", async () => {
  const r = await preflightAcpBackendLive({
    agentId: "opencode",
    backendConfig: cfg.buildOpenCodeConfig(),
    agent: agent("probe-asks"),
    cwd: scratch(),
    timeoutSeconds: 20,
  });
  assert.equal(r.ok, true, r.reasons.join(" | "));
  assert.equal(r.sawPermissionRequest, true);
  assert.equal(r.denialHonoured, true);
});
