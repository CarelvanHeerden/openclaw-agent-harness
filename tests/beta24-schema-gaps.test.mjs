/**
 * beta.24 — config schema gaps discovered on the Thanos install (2026-07-17).
 *
 * Two config shapes the runtime accepted / used but the JSON schema rejected:
 *
 * 1. `models.auth: { credential_service, api_key_env }` — beta.4 added
 *    the code path but the schema was never updated. Gateway startup
 *    failed with `models: invalid config: must not have additional
 *    properties: "auth"` when Carel followed my beta.20 docs.
 *
 * 2. `logging: { level }` — new in beta.24. Carel asked for a config-
 *    driven log level so we could set 'debug' during smoke testing to
 *    surface SDK errors instead of terse messages.
 *
 * These tests round-trip the parser to confirm both fields are now
 * accepted defaults-applied. The actual debug-emit gating is a beta.25
 * follow-up; beta.24 just fixes the SCHEMA gap and the inline-error-in-
 * message log-format issue (see the crystallise / pr-watcher fixes).
 */
import test from "node:test";
import assert from "node:assert/strict";

let parseHarnessConfig;
try {
  ({ parseHarnessConfig } = await import("../dist/config.js"));
} catch {
  parseHarnessConfig = null;
}

const skipAll = { skip: parseHarnessConfig === null };

function baseInput(overrides = {}) {
  // Minimal viable config shape used across the schema tests.
  return {
    slack: {
      listener_enabled: false,
      authorised_users: ["U03HD5QEBFU"],
      reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" },
    },
    repos: { allowed: ["Stitch-Vercel/ProjectThanos"] },
    budgets: {
      monthly_per_user_usd: 100,
      session_default_usd: 10,
      session_hard_ceiling_usd: 50,
      daily_warn_usd: 20,
      monthly_warn_ratio: 0.8,
    },
    ...overrides,
  };
}

test(
  "beta.24: parseHarnessConfig accepts models.auth block (schema gap closed)",
  skipAll,
  () => {
    const cfg = parseHarnessConfig(baseInput({
      models: {
        lead: "claude-fable-5",
        worker: "claude-sonnet-5",
        adversary: "claude-fable-5",
        classifier: "claude-haiku-4-5",
        auth: {
          credential_service: "anthropic-api-key",
          api_key_env: "ANTHROPIC_API_KEY",
        },
      },
    }));
    assert.equal(cfg.models.auth.credential_service, "anthropic-api-key");
    assert.equal(cfg.models.auth.api_key_env, "ANTHROPIC_API_KEY");
  },
);

test(
  "beta.24: parseHarnessConfig accepts logging.level (new field)",
  skipAll,
  () => {
    const cfg = parseHarnessConfig(baseInput({
      logging: { level: "debug" },
    }));
    assert.equal(cfg.logging.level, "debug");
  },
);

test(
  "beta.24: parseHarnessConfig defaults logging.level to 'info' when omitted",
  skipAll,
  () => {
    // Back-compat: pre-beta.24 configs omit the logging block entirely.
    const cfg = parseHarnessConfig(baseInput());
    assert.equal(cfg.logging.level, "info", "default log level is 'info'");
  },
);

test(
  "beta.24: parseHarnessConfig back-compat with pre-beta.24 configs (no models.auth, no logging)",
  skipAll,
  () => {
    // The exact shape the Staging beta.20 config had, minus the pieces
    // that failed. Must parse cleanly.
    const cfg = parseHarnessConfig({
      slack: {
        listener_enabled: false,
        channel: "C0BHN081CA0",
        authorised_users: ["U03HD5QEBFU", "U0AEAPZAK8R"],
        credential_service: "slack-harness-test",
        reactions_poll_ms: 15000,
        reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" },
      },
      repos: {
        allowed: ["CarelvanHeerden/openclaw-agent-harness", "Stitch-Vercel/ProjectThanos"],
        default_base_branch: "main",
      },
      budgets: {
        monthly_per_user_usd: 100,
        session_default_usd: 10,
        session_hard_ceiling_usd: 50,
        daily_warn_usd: 20,
        monthly_warn_ratio: 0.8,
      },
      models: {
        lead: "claude-fable-5",
        worker: "claude-sonnet-5",
        adversary: "claude-fable-5",
        classifier: "claude-haiku-4-5",
      },
      storage: {
        state_db_path: "~/.openclaw/workspace/openclaw-agent-harness/state.db",
        worktree_root: "~/.openclaw/workspace/openclaw-agent-harness/worktrees",
      },
    });
    // Both new fields have defaults filled in.
    assert.equal(cfg.logging.level, "info");
    assert.equal(cfg.repos.default_base_branch, "main");
  },
);
