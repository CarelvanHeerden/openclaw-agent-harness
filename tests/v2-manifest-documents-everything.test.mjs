// v2.0.0 M7 — the manifest and the schema must agree, in BOTH directions.
//
// The harness has two config schemas and they do different jobs.
//
// `openclaw.plugin.json` is what the GATEWAY validates against. It has
// `additionalProperties: false`, so a key missing from it is a key the gateway
// rejects outright — that was the beta.34 regression, where `api_key_env` was
// added to the schema and not the manifest and every config carrying it was
// refused with "must not have additional properties".
//
// `src/config.schema.json` is what `docs/CONFIGURATION.md` is generated from,
// so a key missing from IT is a key nobody can find out about. That direction
// has never been checked, and it is quieter: the key works, it just does not
// exist as far as any operator reading the documentation is concerned.
//
// beta.34 guards the first direction. This file guards the second, and it went
// red on `models.worker_mechanical` the moment it was written — a real feature,
// shipped in beta.91, absent from the schema for eleven betas.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const J = (p) => JSON.parse(readFileSync(resolve(root, p), "utf8"));

const manifest = J("openclaw.plugin.json");
const schema = J("src/config.schema.json");

/**
 * Every config key, as `a.b.c`, from a JSON-Schema-ish object tree.
 *
 * Only descends `properties`. That is deliberate: `additionalProperties`
 * subtrees and `patternProperties` describe open-ended maps (price overrides,
 * provider blocks) whose keys are operator-chosen and cannot be enumerated or
 * documented individually.
 */
function keyPaths(node, prefix = "") {
  const out = [];
  const props = node?.properties;
  if (!props || typeof props !== "object") return out;
  for (const [k, v] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    out.push(...keyPaths(v, path));
  }
  return out;
}

const manifestKeys = keyPaths(manifest.configSchema);
const schemaKeys = new Set(keyPaths(schema));

test("the manifest is a subset of the schema, so every accepted key is documented", () => {
  // Direction: manifest -> schema. A key the gateway ACCEPTS but the schema
  // does not describe is a key that never reaches CONFIGURATION.md, because
  // that document is generated from the schema.
  const undocumented = manifestKeys.filter((k) => !schemaKeys.has(k));
  assert.deepEqual(
    undocumented,
    [],
    `these keys are accepted by the gateway but absent from src/config.schema.json, so they are ` +
      `invisible in the generated documentation:\n  ${undocumented.join("\n  ")}`,
  );
});

/**
 * Config keys with no description in EITHER file, as of v2.0.0-beta.1.
 *
 * A frozen baseline rather than a target. Every entry is a long-standing key
 * whose meaning is not in doubt — `models.lead`, `safety.bash_whitelist` — and
 * inventing prose for forty-seven of them in a refactor commit would produce
 * confident-sounding descriptions written by someone reading the same key name
 * the reader already has. That is worse than an honest gap, because a wrong
 * description is believed.
 *
 * The rule is one-directional: this list may SHRINK, never grow. A new key
 * arrives described, or it does not arrive.
 */
const UNDESCRIBED_BASELINE = new Set([
  "budgets.daily_warn_usd", "budgets.monthly_per_user_usd", "budgets.monthly_warn_ratio",
  "budgets.session_default_usd", "budgets.session_hard_ceiling_usd",
  "loop.adversarial_pass_ends_early", "loop.adversary_timeout_seconds", "loop.max_cycles",
  "loop.session_hard_timeout_seconds", "loop.worker_timeout_seconds",
  "models.adversary", "models.classifier", "models.lead", "models.worker",
  "pat_routing.auth.api_key_env", "pat_routing.default_provider",
  "pat_routing.default_service_pattern", "pat_routing.provider_by_owner", "pat_routing.providers",
  "repos.can_create", "repos.create_org", "repos.create_visibility", "repos.default_base_branch",
  "safety.allow_git_push", "safety.allow_network_commands", "safety.bash_denylist_tokens",
  "safety.bash_whitelist", "safety.path_denylist", "safety.worker_permission_mode",
  "slack.reactions.abort", "slack.reactions.budget_bump", "slack.reactions.pause",
  "slack.reactions.ship_it", "slack.reactions_poll_ms",
  "storage.audit_retention_days", "storage.min_free_disk_bytes", "storage.prune_terminal_sessions",
  "storage.prune_terminal_sessions_days", "storage.state_db_path", "storage.worktree_root",
  "vercel.credential_service", "vercel.deploy_repair.enabled", "vercel.deploy_repair.max_attempts",
  "vercel.enabled", "vercel.preview_wait_seconds", "vercel.project_id", "vercel.team_id",
]);

function undescribedKeys() {
  const missing = [];
  const walk = (node, prefix = "") => {
    for (const [k, v] of Object.entries(node?.properties ?? {})) {
      const path = prefix ? `${prefix}.${k}` : k;
      const described = typeof v?.description === "string" && v.description.trim().length > 0;
      const isContainer = v?.type === "object" && v?.properties;
      if (!described && !isContainer) missing.push(path);
      walk(v, path);
    }
  };
  walk(schema);
  return missing;
}

test("no NEW config key ships without a description", () => {
  // A key present but undescribed generates an empty documentation entry,
  // which is worse than an absent one: it looks answered.
  const fresh = undescribedKeys().filter((k) => !UNDESCRIBED_BASELINE.has(k));
  assert.deepEqual(fresh, [], `these config keys ship with no description anywhere:\n  ${fresh.join("\n  ")}`);
});

test("the undescribed baseline may shrink but never grow", () => {
  // If a key is described, it must leave the list, or the list stops meaning
  // anything and quietly becomes a permanent exemption.
  const still = new Set(undescribedKeys());
  const stale = [...UNDESCRIBED_BASELINE].filter((k) => !still.has(k));
  assert.deepEqual(stale, [],
    `these keys now have descriptions and must be removed from UNDESCRIBED_BASELINE:\n  ${stale.join("\n  ")}`);
});

test("anything the manifest describes is described in the schema too", () => {
  // The direction that is cheap to hold: the manifest already did the writing,
  // so there is no excuse for the schema to be thinner.
  const thin = [];
  const walk = (mNode, sNode, prefix = "") => {
    for (const [k, mv] of Object.entries(mNode?.properties ?? {})) {
      const path = prefix ? `${prefix}.${k}` : k;
      const sv = sNode?.properties?.[k];
      if (!sv) continue; // the subset test above owns that case
      if (mv?.description?.trim() && !sv?.description?.trim()) thin.push(path);
      walk(mv, sv, path);
    }
  };
  walk(manifest.configSchema, schema);
  assert.deepEqual(thin, [], `described in the manifest, undescribed in the schema:\n  ${thin.join("\n  ")}`);
});

test("the check is real: it enumerates a meaningful number of keys", () => {
  // A traversal bug that returned nothing would make both tests above pass
  // vacuously, which is the failure mode of every "compare two lists" check.
  assert.ok(manifestKeys.length > 100, `expected the manifest to declare many keys, got ${manifestKeys.length}`);
  assert.ok(schemaKeys.size > 100, `expected the schema to declare many keys, got ${schemaKeys.size}`);
  // And the traversal must actually go deep, not just read the top level.
  assert.ok(manifestKeys.some((k) => k.split(".").length >= 3), "the traversal must descend nested blocks");
});

test("worker_mechanical is documented (the key this check was written to find)", () => {
  // beta.91 shipped it, the gateway accepted it, and it was absent from the
  // schema until v2.0.0. Named explicitly so the regression is unambiguous if
  // it is ever removed again.
  assert.ok(schemaKeys.has("models.worker_mechanical"));
  assert.ok(manifestKeys.includes("models.worker_mechanical"));
});
