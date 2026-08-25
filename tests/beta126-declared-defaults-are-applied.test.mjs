// beta.126 — a default that exists only in prose.
//
// b99 added `models.max_output_tokens` to stop structured calls inheriting
// whatever output ceiling the bundled SDK happened to pick. It declared
// `"default": 64000` in openclaw.plugin.json, again in config.schema.json, and
// a third time in the doc comment on the interface ("Default here: 64000").
//
// It never put the value in DEFAULTS.
//
// A JSON Schema `default` is an annotation. It documents what a value would be;
// it does not supply one. Nothing in the harness reads it. So on every install
// where an operator had not written the key by hand -- which is every install --
// `maxOutputTokens` went to the SDK as undefined, and the ceiling came from the
// SDK's own model table. For a model id newer than the pinned SDK there is no
// entry, which is the case b99's own description names out loud:
//
//   "undefined for a model newer than the pinned SDK (e.g. claude-opus-5
//    against SDK 0.3.207)"
//
// The b125 smoke ran lead and adversary on claude-opus-5. The plan was cut off
// at an invisible limit, the retry was cut off at the same invisible limit six
// minutes later, and the session died in planning having recorded $0.00. Three
// declarations of a default, and the feature was off.
//
// b124 built the mirror of this test: every key the harness ships as a default
// must be a key the gateway would accept. This is the other direction -- every
// default the manifest PROMISES an operator must be one the harness actually
// delivers. The b124 test passed throughout, because max_output_tokens was
// present in the manifest and absent from DEFAULTS, which is the one shape it
// could not see.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let parseHarnessConfig;
try {
  ({ parseHarnessConfig } = await import("../dist/config.js"));
} catch {
  parseHarnessConfig = null;
}
const skip = parseHarnessConfig === null ? "build not present (npm run build)" : false;

// The smallest config the parser will accept. Everything else must arrive as a
// default, which is precisely what is under test.
const MINIMAL = { slack: { authorised_users: ["U1"] }, repos: { allowed: ["o/r"] } };

/**
 * Defaults the manifest declares but the harness deliberately does not apply,
 * each with the reason. Anything not listed here is a bug: an operator reading
 * the manifest would believe a value is in force when it is not.
 */
const JUSTIFIED = new Map([
  // These four are absent from DEFAULTS but supply the documented value at the
  // point of use, so an operator who reads the manifest gets what it promises.
  // That is the difference between them and max_output_tokens, whose read site
  // was a bare `config.models.max_output_tokens` with nothing behind it.
  ["slack.reactions_poll_ms", "applied at the read site: `config.slack.reactions_poll_ms ?? 15000`"],
  ["repos.never_commit_paths", "applied at the consumer: `(this.opts.neverCommitPaths ?? [])`"],
  ["loop.require_worker_context_strict", "read as `=== true`, so absent behaves as the promised false"],
  ["loop.lead_salvage_truncated_plan", "read as `!== false`, so absent behaves as the promised true"],
]);

/** Walk a JSON-Schema properties tree collecting every declared `default`. */
function declaredDefaults(properties, prefix = []) {
  const out = [];
  for (const [key, schema] of Object.entries(properties ?? {})) {
    if (!schema || typeof schema !== "object") continue;
    const path = [...prefix, key];
    if ("default" in schema) out.push({ path, value: schema.default });
    if (schema.properties) out.push(...declaredDefaults(schema.properties, path));
  }
  return out;
}

function readPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object" || !(k in cur)) return { found: false, value: undefined };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

test("every default the manifest promises is a default the harness actually applies", { skip }, () => {
  const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
  const effective = parseHarnessConfig(MINIMAL);

  const broken = [];
  for (const { path, value } of declaredDefaults(manifest.configSchema?.properties)) {
    const dotted = path.join(".");
    if (JUSTIFIED.has(dotted)) continue;
    const { found, value: actual } = readPath(effective, path);
    if (!found) {
      broken.push(`${dotted}: manifest promises ${JSON.stringify(value)}, harness applies NOTHING (key absent)`);
    } else if (JSON.stringify(actual) !== JSON.stringify(value)) {
      broken.push(`${dotted}: manifest promises ${JSON.stringify(value)}, harness applies ${JSON.stringify(actual)}`);
    }
  }

  assert.deepEqual(
    broken,
    [],
    "the manifest documents defaults the harness does not deliver. An operator reading it would " +
      "believe these values are in force:\n  " + broken.join("\n  "),
  );
});

test("the same promise holds in config.schema.json", { skip }, () => {
  // Two schemas ship. They drift from each other (b124 found ci.none_grace_seconds
  // in one and not the other), so both are checked against the same reality.
  const schema = JSON.parse(readFileSync(join(root, "src", "config.schema.json"), "utf8"));
  const effective = parseHarnessConfig(MINIMAL);

  const broken = [];
  for (const { path, value } of declaredDefaults(schema.properties)) {
    const dotted = path.join(".");
    if (JUSTIFIED.has(dotted)) continue;
    const { found, value: actual } = readPath(effective, path);
    if (!found) broken.push(`${dotted}: schema promises ${JSON.stringify(value)}, harness applies NOTHING`);
    else if (JSON.stringify(actual) !== JSON.stringify(value)) {
      broken.push(`${dotted}: schema promises ${JSON.stringify(value)}, harness applies ${JSON.stringify(actual)}`);
    }
  }

  assert.deepEqual(broken, [], "config.schema.json documents defaults the harness does not deliver:\n  " + broken.join("\n  "));
});

test("the justified list does not outlive its entries", { skip }, () => {
  // A stale exemption is how a real bug gets waved through later.
  const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
  const schema = JSON.parse(readFileSync(join(root, "src", "config.schema.json"), "utf8"));
  const known = new Set([
    ...declaredDefaults(manifest.configSchema?.properties).map((d) => d.path.join(".")),
    ...declaredDefaults(schema.properties).map((d) => d.path.join(".")),
  ]);
  for (const key of JUSTIFIED.keys()) {
    assert.ok(known.has(key), `${key} is exempted but no longer declares a default anywhere -- drop the exemption`);
  }
});

// ---------------------------------------------------------------------------
// The specific regression, pinned by name. The general test above would catch
// it, but this one names the failure so a future reader knows what it cost.
// ---------------------------------------------------------------------------

test("max_output_tokens reads back from the effective config without an operator setting it", { skip }, async () => {
  const cfg = parseHarnessConfig(MINIMAL);
  const { DEFAULT_SDK_MAX_OUTPUT_TOKENS } = await import("../dist/adapters/claude-code.js");
  assert.equal(
    cfg.models.max_output_tokens,
    DEFAULT_SDK_MAX_OUTPUT_TOKENS,
    "the ceiling always reached the subprocess via buildSdkEnv's own fallback, so this was never an " +
      "outage -- but the config object read back `undefined`, which is what anyone inspecting, logging " +
      "or reasoning about the effective ceiling saw. An hour of the b125 diagnosis went into that gap.",
  );
});

test("the two 64000s cannot drift apart", { skip }, async () => {
  // One value, declared in config.ts, in buildSdkEnv's fallback, in the
  // manifest and in config.schema.json. Three of those are now checked against
  // the fourth by the tests above; this closes the last pair.
  const { DEFAULT_SDK_MAX_OUTPUT_TOKENS } = await import("../dist/adapters/claude-code.js");
  assert.equal(parseHarnessConfig(MINIMAL).models.max_output_tokens, DEFAULT_SDK_MAX_OUTPUT_TOKENS);
});

test("an operator can still override it, including to 0 for the old behaviour", { skip }, () => {
  assert.equal(parseHarnessConfig({ ...MINIMAL, models: { max_output_tokens: 32000 } }).models.max_output_tokens, 32000);
  assert.equal(
    parseHarnessConfig({ ...MINIMAL, models: { max_output_tokens: 0 } }).models.max_output_tokens,
    0,
    "0 means inherit the SDK default -- a documented escape hatch, and it must survive the new default",
  );
});
