// beta.124 — a configured feature must be a real feature.
//
// b119's cycle extension was authorised by `advance()` and discarded by the
// driver, and it took four releases and a $19 smoke run to notice. The same
// species, one layer up, is a config key that is declared, schema'd,
// defaulted, documented -- and read by nothing. An operator sets it, the
// harness ignores it, and nothing anywhere says so.
//
// This test walks the shipped loop defaults and requires each key to be
// consulted somewhere in src/, or to be named in INERT with a reason. Adding a
// dead key now fails here rather than in a smoke report.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Keys that are deliberately declared and deliberately do nothing. Each one
 * needs a reason, because "it's fine, it's unused" is how the b119 extension
 * survived code review four times.
 */
const INERT = new Map([
  [
    "revise_spec_turn_enabled",
    "b92 deleted the LLM revise-spec turn for a deterministic mapping. Retained so pre-b92 configs still validate under additionalProperties:false.",
  ],
  [
    "adversarial_pass_ends_early",
    "b124: a pass has always ended the loop unconditionally. Retained for config compatibility; wiring 'false' would ship a passed run as do_not_merge.",
  ],
]);

function sourceFiles() {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  })(join(root, "src"));
  return out;
}

/** The `loop:` block of DEFAULT_CONFIG, which is what actually ships. */
function loopDefaultKeys(cfgText) {
  const start = cfgText.indexOf("  loop: {");
  assert.notEqual(start, -1, "could not find the loop defaults block in src/config.ts");
  let depth = 0;
  let end = start;
  for (let i = cfgText.indexOf("{", start); i < cfgText.length; i++) {
    if (cfgText[i] === "{") depth++;
    else if (cfgText[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = cfgText.slice(start, end);
  return [...block.matchAll(/^\s{4}([a-z_0-9]+):/gm)].map((m) => m[1]);
}

test("every shipped loop config key is read by something, or declared inert with a reason", () => {
  const cfgPath = join(root, "src", "config.ts");
  const cfgText = readFileSync(cfgPath, "utf8");
  const keys = loopDefaultKeys(cfgText);
  assert.ok(keys.length > 20, `expected the real loop defaults, parsed only ${keys.length} keys`);

  const others = sourceFiles()
    .filter((f) => f !== cfgPath)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const dead = keys.filter((k) => !others.includes(k) && !INERT.has(k));
  assert.deepEqual(
    dead,
    [],
    `these loop config keys are declared and defaulted but nothing reads them.\n` +
      `Either wire them up, or add them to INERT with the reason they exist:\n  ${dead.join("\n  ")}`,
  );
});

test("the inert list does not outlive its entries", () => {
  // The mirror of the above: a key listed as inert that has since been wired
  // up, or deleted outright, makes the list lie in the other direction.
  const cfgText = readFileSync(join(root, "src", "config.ts"), "utf8");
  for (const [key, reason] of INERT) {
    assert.ok(cfgText.includes(key), `INERT lists ${key}, which no longer exists in config.ts — drop it from the list`);
    assert.ok(reason.length > 40, `${key} needs a real reason, not a placeholder`);
  }
});

test("every default the harness ships is a config the GATEWAY would accept", () => {
  // The other half of the same lie. `openclaw.plugin.json` is what the gateway
  // validates against, and every section sets additionalProperties:false, so a
  // key present in DEFAULT_CONFIG but absent from the manifest cannot be set
  // by an operator at all -- the gateway rejects the whole config. b34 shipped
  // exactly that with vercel.api_key_env, and `ci.none_grace_seconds` had
  // drifted out of src/config.schema.json by b124.
  const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
  const cfgText = readFileSync(join(root, "src", "config.ts"), "utf8");

  const missing = [];
  for (const [section, schema] of Object.entries(manifest.configSchema?.properties ?? {})) {
    if (schema?.additionalProperties !== false || !schema.properties) continue;
    // Read the shipped defaults for this section straight out of the source,
    // so the test tracks what actually ships rather than a copy of it.
    const start = cfgText.indexOf(`  ${section}: {`);
    if (start === -1) continue;
    let depth = 0;
    let end = start;
    for (let i = cfgText.indexOf("{", start); i < cfgText.length; i++) {
      if (cfgText[i] === "{") depth++;
      else if (cfgText[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    for (const m of cfgText.slice(start, end).matchAll(/^\s{4}([a-z_0-9]+):/gm)) {
      if (!(m[1] in schema.properties)) missing.push(`${section}.${m[1]}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `these keys ship as defaults but the manifest would reject them if an operator set one:\n  ${missing.join("\n  ")}`,
  );
});

test("an inert key is documented as inert where a reader will meet it", () => {
  // The declaration is where someone editing openclaw.json ends up. If the
  // type says nothing, the key reads as live.
  const cfgText = readFileSync(join(root, "src", "config.ts"), "utf8");
  for (const key of INERT.keys()) {
    const decl = cfgText.indexOf(`  ${key}`);
    assert.notEqual(decl, -1, `${key} should be declared in the LoopConfig interface`);
    const preamble = cfgText.slice(Math.max(0, decl - 1400), decl);
    assert.match(
      preamble,
      /INERT|DEPRECATED|no effect/,
      `${key} does nothing, and its declaration does not say so`,
    );
  }
});
