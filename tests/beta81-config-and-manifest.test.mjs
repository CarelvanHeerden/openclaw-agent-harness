// beta.81 — config + manifest declaration discipline. EVERY new config key must
// be declared in BOTH src/config.ts DEFAULTS/interface AND openclaw.plugin.json
// (manifest has additionalProperties:false -- an undeclared key rejects the
// WHOLE config; the beta.34 lesson). Also asserts the version bump + the B4
// default flip.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let parseHarnessConfig = null;
try {
  ({ parseHarnessConfig } = await import("../dist/config.js"));
} catch {
  parseHarnessConfig = null;
}

const NEW_LOOP_KEYS = [
  "recovery_max_resumes",
  "recovery_resume_window_seconds",
  "recovery_resume_at_subtask",
  "lead_json_retry_enabled",
];
const NEW_CI_KEYS = ["wait_timeout_seconds", "poll_interval_seconds"];

// ---- version bump ----
test("beta81: version bumped to 0.1.0-beta.81 in BOTH package.json and version.ts", () => {
  const pkg = JSON.parse(S("package.json"));
  assert.equal(pkg.version, "0.1.0-beta.81");
  const ver = S("src/version.ts");
  assert.match(ver, /pluginVersion:\s*"0\.1\.0-beta\.81"/);
});

// ---- DEFAULTS carry every new key ----
test("beta81: config.ts DEFAULTS declare the new loop + ci keys", () => {
  const src = S("src/config.ts");
  for (const k of NEW_LOOP_KEYS) assert.match(src, new RegExp(`${k}:`), `loop.${k} missing from config.ts`);
  assert.match(src, /ci:\s*\{/, "ci block missing from config.ts DEFAULTS");
  for (const k of NEW_CI_KEYS) assert.match(src, new RegExp(`${k}:`), `ci.${k} missing from config.ts`);
  // B4: the local runner default flipped to false.
  assert.match(src, /run_repo_check_scripts:\s*false/, "verify.run_repo_check_scripts default should be false (B4)");
});

// ---- manifest declares every new key (additionalProperties:false) ----
test("beta81: openclaw.plugin.json manifest declares ci block + new loop keys", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  const loop = m.configSchema.properties.loop;
  const ci = m.configSchema.properties.ci;
  assert.ok(loop, "loop block present");
  assert.ok(ci, "ci block present in manifest -- else additionalProperties:false rejects the whole config");
  assert.equal(ci.additionalProperties, false);
  for (const k of NEW_CI_KEYS) assert.ok(ci.properties[k], `manifest ci.${k} missing`);
  assert.equal(ci.properties.wait_timeout_seconds.default, 900);
  assert.equal(ci.properties.poll_interval_seconds.default, 20);
  for (const k of NEW_LOOP_KEYS) assert.ok(loop.properties[k], `manifest loop.${k} missing`);
  // B4: manifest default flipped too.
  assert.equal(m.configSchema.properties.verify.properties.run_repo_check_scripts.default, false);
});

// ---- config.schema.json mirror declares the new keys ----
test("beta81: config.schema.json mirrors the new ci block + loop keys", () => {
  const schema = JSON.parse(S("src/config.schema.json"));
  assert.ok(schema.properties.ci, "schema ci block present (top-level additionalProperties:false)");
  for (const k of NEW_CI_KEYS) assert.ok(schema.properties.ci.properties[k], `schema ci.${k} missing`);
  for (const k of NEW_LOOP_KEYS) assert.ok(schema.properties.loop.properties[k], `schema loop.${k} missing`);
});

// ---- behavioural: defaults resolve + clamps hold ----
test("beta81: parseHarnessConfig resolves ci defaults + clamps", { skip: parseHarnessConfig === null }, () => {
  const base = { slack: { authorised_users: ["U1"] }, repos: { allowed: ["o/*"] } };
  const cfg = parseHarnessConfig(base);
  assert.equal(cfg.ci.wait_timeout_seconds, 900);
  assert.equal(cfg.ci.poll_interval_seconds, 20);
  assert.equal(cfg.loop.recovery_max_resumes, 3);
  assert.equal(cfg.loop.recovery_resume_window_seconds, 60);
  assert.equal(cfg.loop.recovery_resume_at_subtask, true);
  assert.equal(cfg.loop.lead_json_retry_enabled, true);
  assert.equal(cfg.verify.run_repo_check_scripts, false);
  // clamps: below floor -> floored; above ceiling -> ceilinged.
  const clamped = parseHarnessConfig({ ...base, ci: { wait_timeout_seconds: 5, poll_interval_seconds: 1 } });
  assert.equal(clamped.ci.wait_timeout_seconds, 30);
  assert.equal(clamped.ci.poll_interval_seconds, 5);
  const clampedHi = parseHarnessConfig({ ...base, ci: { wait_timeout_seconds: 99999, poll_interval_seconds: 99999 } });
  assert.equal(clampedHi.ci.wait_timeout_seconds, 7200);
  assert.equal(clampedHi.ci.poll_interval_seconds, 300);
});

// ---- an UNDECLARED key would reject (proves additionalProperties:false has teeth) ----
test("beta81: an undeclared ci key is rejected by the manifest schema (additionalProperties:false)", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  // The manifest's ci + loop blocks must both be additionalProperties:false so
  // an undeclared key (e.g. ci.bogus_key) would be rejected by the platform
  // validator. This is a STATIC assertion of the property that guarantees the
  // beta.34 lesson: no silently-ignored config keys.
  assert.equal(m.configSchema.properties.ci.additionalProperties, false);
  assert.equal(m.configSchema.properties.loop.additionalProperties, false);
  // And the schema.json ci block too.
  const schema = JSON.parse(S("src/config.schema.json"));
  assert.equal(schema.properties.ci.additionalProperties, false);
});
