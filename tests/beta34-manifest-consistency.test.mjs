/**
 * beta.34 regression guard: the plugin MANIFEST (openclaw.plugin.json) is what
 * the gateway validates config against and enumerates tools from. It is a
 * SEPARATE source of truth from src/config.schema.json. beta.34 shipped with
 * api_key_env added to config.schema.json but NOT the manifest, and the
 * gateway rejected the config with:
 *   plugins.entries.openclaw-agent-harness.config.vercel: invalid config:
 *   must not have additional properties: "api_key_env"
 * ...and harness_merge_pr was missing from manifest.tools. Guard both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "openclaw.plugin.json"), "utf8"));

test("manifest vercel configSchema allows api_key_env (env fallback)", () => {
  const vercel = manifest.configSchema?.properties?.vercel;
  assert.ok(vercel, "manifest must declare a vercel config block");
  // additionalProperties:false means every valid key must be enumerated.
  assert.ok(
    vercel.properties?.api_key_env,
    "manifest vercel block must allow api_key_env or the gateway rejects the config " +
      '("must not have additional properties: api_key_env").',
  );
  if (vercel.additionalProperties === false) {
    for (const k of ["enabled", "credential_service", "api_key_env", "project_id", "preview_wait_seconds"]) {
      assert.ok(vercel.properties[k], `manifest vercel block must enumerate "${k}" (additionalProperties:false)`);
    }
  }
});

test("manifest tools list includes harness_merge_pr", () => {
  const tools = manifest.contracts?.tools;
  assert.ok(Array.isArray(tools), "manifest must declare a contracts.tools array");
  assert.ok(tools.includes("harness_merge_pr"), "manifest must declare harness_merge_pr so the gateway exposes it");
});

test("manifest tools list matches the tools registered in registration.ts (no drift)", () => {
  const tools = manifest.contracts?.tools;
  const reg = readFileSync(resolve(repoRoot, "src/tools/registration.ts"), "utf8");
  const registered = [...reg.matchAll(/name:\s*"(harness_[a-z_]+)"/g)].map((m) => m[1]);
  const uniqReg = [...new Set(registered)].sort();
  const uniqManifest = [...new Set(tools)].sort();
  assert.deepEqual(
    uniqManifest,
    uniqReg,
    "manifest.tools must exactly match the harness_* tools registered in registration.ts",
  );
});
