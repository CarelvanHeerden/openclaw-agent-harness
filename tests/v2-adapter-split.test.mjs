// v2.0.0 — the adapter split, and the gate that keeps it split.
//
// `claude-code.ts` had grown to 2,481 lines holding two unrelated things: the
// Claude Agent SDK integration, and a pile of code that only lived there
// because that is where it was first needed — JSON extraction, cost
// arithmetic, diff chunking, stream-liveness, env filtering. None of it
// imports the SDK or knows what a model is.
//
// v2 adds a second backend, so that pile had to become shared rather than
// copied. A second copy would drift, and the specific drift that matters is
// security: the env deny-list is the only thing keeping the vault key out of an
// agent subprocess, and the ACP branch already spawns OpenCode with the full
// `process.env` precisely because it grew its own spawn path.
//
// The gate below is therefore not tidiness. It is what stops a future backend
// from reaching around `shared/` and re-implementing a control.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const S = (p) => readFileSync(resolve(root, p), "utf8");

/** Every .ts file under src/, recursively. */
function srcFiles(dir = "src") {
  const out = [];
  for (const e of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("only claude-code.ts imports the Claude Agent SDK", () => {
  // Deliberately an IMPORT check, not a mention check. `config.ts` documents
  // the `models.anthropic` auth block and names the SDK in prose, correctly —
  // that key IS about the Claude backend. Rewording a true comment to satisfy a
  // grep would make the gate weaker, not stronger. What must stay singular is
  // the dependency: exactly one file may reach the SDK.
  const importRe = /(?:from\s*|import\s*\(\s*)["']@anthropic-ai\/claude-agent-sdk["']/;
  const importers = srcFiles().filter((f) => importRe.test(S(f)));
  assert.deepEqual(importers, ["src/adapters/claude-code.ts"],
    `exactly one file may import the SDK; got ${JSON.stringify(importers)}`);
});

test("nothing in shared/ depends on any backend", () => {
  // shared/ is the code both backends run. A dependency pointing the other way
  // -- shared importing claude-code, or the SDK -- would mean the ACP backend
  // pulls in the Claude adapter to do arithmetic.
  for (const f of srcFiles("src/adapters/shared")) {
    const s = S(f);
    assert.ok(!/claude-agent-sdk/.test(s), `${f} must not reference the SDK`);
    assert.ok(!/from "\.\.\/claude-code\.js"/.test(s), `${f} must not import the Claude adapter`);
    assert.ok(!/from "\.\.\/acp\.js"/.test(s), `${f} must not import the ACP adapter`);
  }
});

test("the shared modules exist and are non-trivial", () => {
  for (const f of ["json.ts", "pricing.ts", "diff.ts", "stream.ts", "env.ts"]) {
    const p = `src/adapters/shared/${f}`;
    assert.ok(existsSync(resolve(root, p)), `${p} must exist`);
    assert.ok(S(p).length > 400, `${p} looks like a stub`);
  }
});

test("the old adapter filename is gone", () => {
  // The old name is assembled rather than written out. This test was itself
  // caught by the bulk `claude-sdk -> claude-code` rewrite that performed the
  // rename: a literal would have been rewritten to the NEW name, leaving the
  // assertion quietly checking that the file we just created does not exist.
  const oldName = ["claude", "sdk"].join("-") + ".ts";
  assert.equal(existsSync(resolve(root, `src/adapters/${oldName}`)), false,
    `${oldName} was renamed; a leftover would be a second SDK entry point`);
});

// ---------------------------------------------------------------------------
// The move was a move, not a rewrite
// ---------------------------------------------------------------------------

test("the moved behaviour is unchanged", async () => {
  const json = await import("../dist/adapters/shared/json.js");
  const pricing = await import("../dist/adapters/shared/pricing.js");
  const diff = await import("../dist/adapters/shared/diff.js");
  const stream = await import("../dist/adapters/shared/stream.js");

  // JSON: prose-wrapped, fenced, and truncated all behave as before.
  assert.equal(json.extractJson('here you go:\n```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(json.repairTruncatedJson('{"xs":[{"a":1},{"b":'), '{"xs":[{"a":1}]}');
  assert.equal(json.repairTruncatedJson("no json here"), null);

  // Pricing: an unknown model still fails SAFE, at the most expensive tier.
  const known = pricing.estimateSubTaskCost("claude-sonnet-5", 1_000_000);
  const unknown = pricing.estimateSubTaskCost("some-local-model", 1_000_000);
  assert.ok(unknown >= known, "an unpriced model must over-reserve, never under-reserve");
  assert.equal(pricing.isUnknownModel("some-local-model"), true);
  assert.equal(pricing.isUnknownModel("some-local-model", { "some-local-model": { input: 0, output: 0 } }), false);
  assert.equal(pricing.checkPriceDrift("some-local-model", 1, 100, 100).unknownModel, true);

  // Diff: splits on file boundaries.
  const d = "diff --git a/x b/x\n+one\ndiff --git a/y b/y\n+two\n";
  assert.equal(diff.splitDiffOnFileBoundaries(d, 20).length, 2);

  // Stream: idle arithmetic.
  assert.equal(stream.evaluateStreamSlowTick({ marker: 5, lastMarker: 4, nowMs: 1000, lastActivityAtMs: 0, idleWarnMs: 100 }).fire, false);
  assert.equal(stream.evaluateStreamSlowTick({ marker: 4, lastMarker: 4, nowMs: 1000, lastActivityAtMs: 0, idleWarnMs: 100 }).fire, true);
  assert.equal(stream.evaluateStreamSlowTick({ marker: 4, lastMarker: 4, nowMs: 1000, lastActivityAtMs: 0, idleWarnMs: 0 }).fire, false);
});

test("the adapter still re-exports what its importers use", async () => {
  // index.ts, loop.ts and registration.ts import these from the adapter. The
  // re-export is a compatibility surface so the split did not become a
  // 60-file rename; the definitions live in shared/.
  const cc = await import("../dist/adapters/claude-code.js");
  for (const name of [
    "extractJson", "extractAndValidateJson", "repairTruncatedJson", "describeJsonSyntaxFault",
    "estimateSubTaskCost", "checkPriceDrift", "assessModelPricingHealth", "PRICES",
    "splitDiffOnFileBoundaries", "evaluateStreamSlowTick",
  ]) {
    assert.ok(cc[name] !== undefined, `claude-code.ts must still export ${name}`);
  }
  const shared = await import("../dist/adapters/shared/pricing.js");
  assert.equal(cc.PRICES, shared.PRICES, "the re-export must be the same object, not a copy");
});

// ---------------------------------------------------------------------------
// The env filter, which is the reason the split is load-bearing
// ---------------------------------------------------------------------------

test("the env filter withholds secrets from any agent subprocess", async () => {
  const { buildAgentEnv, isDeniedEnvVar, registerDeniedEnvVar } = await import("../dist/adapters/shared/env.js");

  // beta.110's specific catch: a bare `_KEY` suffix is NOT in the deny regex,
  // so the vault key has to be listed by name. Losing that is silent.
  assert.equal(isDeniedEnvVar("OAH_VAULT_KEY"), true);
  assert.equal(isDeniedEnvVar("OAH_VAULT_KEY_FILE"), true);
  assert.equal(isDeniedEnvVar("GH_TOKEN"), true);
  assert.equal(isDeniedEnvVar("VERCEL_TOKEN"), true);
  assert.equal(isDeniedEnvVar("MY_SECRET"), true);
  assert.equal(isDeniedEnvVar("PATH"), false);
  // Ends in TOKENS, not TOKEN -- must survive, or the SDK loses its ceiling.
  assert.equal(isDeniedEnvVar("CLAUDE_CODE_MAX_OUTPUT_TOKENS"), false);

  const prev = { ...process.env };
  try {
    process.env.OAH_VAULT_KEY = "super-secret";
    process.env.GH_TOKEN = "ghp_x";
    process.env.HARMLESS_VAR = "fine";
    const env = buildAgentEnv();
    assert.equal(env.OAH_VAULT_KEY, undefined, "the vault key must never reach a child");
    assert.equal(env.GH_TOKEN, undefined, "the PAT must never reach a child");
    assert.equal(env.HARMLESS_VAR, "fine");

    // `extra` is applied AFTER the filter: that is the only way a secret gets
    // in, and it has to be named at the call site.
    const withExtra = buildAgentEnv({ ANTHROPIC_API_KEY: "sk-test", SKIPPED: undefined });
    assert.equal(withExtra.ANTHROPIC_API_KEY, "sk-test");
    assert.equal(withExtra.SKIPPED, undefined, "an undefined extra is not set");
    assert.equal(withExtra.OAH_VAULT_KEY, undefined, "extra must not reopen the filter");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }

  // beta.110's widening seam: an operator-renamed key env var can be added.
  assert.equal(isDeniedEnvVar("MY_CUSTOM_VAULT_VAR"), false);
  registerDeniedEnvVar("MY_CUSTOM_VAULT_VAR");
  assert.equal(isDeniedEnvVar("MY_CUSTOM_VAULT_VAR"), true);
});

test("buildSdkEnv routes through the shared filter", async () => {
  const { buildSdkEnv } = await import("../dist/adapters/claude-code.js");
  const prev = process.env.OAH_VAULT_KEY;
  try {
    process.env.OAH_VAULT_KEY = "super-secret";
    const env = buildSdkEnv("sk-test");
    assert.equal(env.OAH_VAULT_KEY, undefined, "the SDK path must still filter");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-test");
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000", "the b99 ceiling still ships");
    assert.equal(buildSdkEnv("sk-test", 0).CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined, "0 still disables the ceiling");
  } finally {
    if (prev === undefined) delete process.env.OAH_VAULT_KEY;
    else process.env.OAH_VAULT_KEY = prev;
  }
});

test("the bootstrap seam still widens the shared deny-list", () => {
  // registerDeniedSdkEnvVar kept its name so bootstrap's call site is
  // unchanged, but it must now widen the SHARED list -- otherwise an
  // operator-renamed key would be stripped from the SDK child and handed to
  // the ACP one.
  const src = S("src/adapters/claude-code.ts");
  assert.match(src, /export function registerDeniedSdkEnvVar[\s\S]{0,200}registerDeniedEnvVar\(name\)/,
    "registerDeniedSdkEnvVar must delegate to the shared registrar");
});
