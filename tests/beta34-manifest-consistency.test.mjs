// beta.34 restored: manifest and runtime registration must agree on the canonical four tools.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHarnessTools } from "../dist/tools/registration.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "openclaw.plugin.json"), "utf8"));
const expected = ["harness_change_result", "harness_confirm_change", "harness_merge_change", "harness_prepare_change"];

test("beta34: manifest tool contract is exactly the canonical four-tool catalog", () => {
  assert.deepEqual([...manifest.contracts.tools].sort(), expected);
});

test("beta34: manifest and runtime registration have no drift", () => {
  const registered = [];
  registerHarnessTools({ logger: { info() {}, warn() {}, error() {} }, registerTool(def) { registered.push(def.name); return () => {}; } }, {});
  assert.deepEqual(registered.sort(), expected);
});

test("beta34: manifest declares the bounded control-plane configuration", () => {
  const control = manifest.configSchema?.properties?.control;
  assert.ok(control);
  assert.equal(control.additionalProperties, false);
  for (const key of ["lease_ttl_ms", "authority_ttl_seconds", "readiness_timeout_seconds"]) assert.ok(control.properties[key], key);
});
