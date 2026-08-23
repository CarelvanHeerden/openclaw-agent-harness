// The gateway validates an operator's config against openclaw.plugin.json, and
// that schema is `additionalProperties: false`. So any key we document in
// src/config.schema.json but forget to enumerate in the manifest is not merely
// undeclared — it rejects the WHOLE plugin config the moment someone sets it:
//
//   plugins.entries.openclaw-agent-harness.config: invalid config:
//   must not have additional properties: "credentials"
//
// beta.34 shipped exactly that, with `vercel.api_key_env`. The guard written
// afterwards asserted the specific keys of the specific block that broke, so it
// could only ever catch that one recurrence — and in 1.0.0-rc.1 the same bug
// came back one level up, with the whole `credentials` block the vault work
// added to config.schema.json and never to the manifest.
//
// This guard is the general form: walk every path config.schema.json advertises
// and ask whether the manifest would refuse it.
//
// Only this direction can hurt an operator. src/config.schema.json is not
// loaded at runtime and is not shipped in dist/ — it is an editor and
// documentation artefact — so a key the manifest allows but the schema omits
// costs nothing at boot.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(root, "src", "config.schema.json"), "utf8"));

/** Every dotted leaf path an object schema advertises. */
function leafPaths(node, path = []) {
  if (!node || typeof node !== "object") return [];
  if (!node.properties) return path.length ? [path.join(".")] : [];
  return Object.entries(node.properties).flatMap(([k, v]) => leafPaths(v, [...path, k]));
}

/**
 * Would the manifest reject this dotted path? Returns the prefix at which it
 * would be refused, or null when it is accepted.
 *
 * A segment is refused when the enclosing object does not enumerate it AND
 * closes itself to extras. An object with `additionalProperties` unset or true
 * accepts anything below it, so we stop looking.
 */
function rejectedAt(dotted) {
  const segments = dotted.split(".");
  let node = manifest.configSchema;
  for (let i = 0; i < segments.length; i++) {
    const next = node?.properties?.[segments[i]];
    if (!next) {
      return node?.additionalProperties === false ? segments.slice(0, i + 1).join(".") : null;
    }
    node = next;
  }
  return null;
}

test("the manifest accepts every key config.schema.json advertises", () => {
  const rejected = leafPaths(schema)
    .map((p) => ({ path: p, at: rejectedAt(p) }))
    .filter((r) => r.at);

  assert.deepEqual(
    rejected,
    [],
    "config.schema.json advertises keys the gateway would refuse, rejecting the operator's ENTIRE plugin config:\n" +
      rejected.map((r) => `  ${r.path}  (refused at "${r.at}")`).join("\n") +
      "\nEnumerate them in openclaw.plugin.json configSchema, or drop them from src/config.schema.json.",
  );
});

test("the credentials block specifically is reachable (the rc.1 regression)", () => {
  const creds = manifest.configSchema?.properties?.credentials;
  assert.ok(creds, "manifest must declare the credentials block; src/index.ts reads config.credentials on every boot");
  for (const k of ["dir", "key_env", "key_file"]) {
    assert.ok(creds.properties?.[k], `manifest credentials block must enumerate "${k}"`);
  }
});

test("rejectedAt models the gateway rather than merely reporting absence", () => {
  // A key under a block that permits extras is fine, and must not be reported.
  assert.equal(manifest.configSchema.properties.pat_routing.additionalProperties, true);
  assert.equal(rejectedAt("pat_routing.some_future_key"), null);
  // A key under a closed block is not.
  assert.equal(manifest.configSchema.properties.safety.additionalProperties, false);
  assert.equal(rejectedAt("safety.some_future_key"), "safety.some_future_key");
  // And an unknown top-level section is refused at the top.
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(rejectedAt("not_a_section.at_all"), "not_a_section");
});
