import test from "node:test";
import assert from "node:assert/strict";

let parseHarnessConfig;
try {
  ({ parseHarnessConfig } = await import("../dist/config.js"));
} catch {
  parseHarnessConfig = null;
}

const minimalOk = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["example-org/*"], default_base_branch: "main" },
};

test("config: minimal input applies defaults",
  { skip: parseHarnessConfig === null }, () => {
    const cfg = parseHarnessConfig(minimalOk);
    assert.equal(cfg.slack.channel, "C1");
    assert.equal(cfg.budgets.monthly_per_user_usd, 1000);
    assert.equal(cfg.loop.max_cycles, 3);
    assert.deepEqual(cfg.slack.reactions, { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" });
  });

test("config: missing channel is rejected ONLY when listener_enabled",
  { skip: parseHarnessConfig === null }, () => {
    // Autonomous mode: channel required.
    assert.throws(() => parseHarnessConfig({
      ...minimalOk,
      slack: { listener_enabled: true, channel: "", authorised_users: ["U1"] },
    }));
    // Agent-orchestrated mode (default): no channel needed.
    assert.doesNotThrow(() => parseHarnessConfig({
      ...minimalOk,
      slack: { channel: "", authorised_users: ["U1"] },
    }));
  });

test("config: listener_enabled defaults to false (agent-orchestrated)",
  { skip: parseHarnessConfig === null }, () => {
    const cfg = parseHarnessConfig(minimalOk);
    assert.equal(cfg.slack.listener_enabled, false);
  });

test("config: empty allow-list is rejected",
  { skip: parseHarnessConfig === null }, () => {
    assert.throws(() => parseHarnessConfig({ ...minimalOk, repos: { allowed: [] } }));
  });

test("config: default > ceiling is rejected",
  { skip: parseHarnessConfig === null }, () => {
    assert.throws(() =>
      parseHarnessConfig({
        ...minimalOk,
        budgets: { session_default_usd: 300, session_hard_ceiling_usd: 100 },
      }),
    );
  });

test("config: no authorised users is rejected",
  { skip: parseHarnessConfig === null }, () => {
    assert.throws(() =>
      parseHarnessConfig({ ...minimalOk, slack: { channel: "C1", authorised_users: [] } }),
    );
  });

test("config: override merges deeply",
  { skip: parseHarnessConfig === null }, () => {
    const cfg = parseHarnessConfig({
      ...minimalOk,
      budgets: { session_default_usd: 25 },
    });
    // Overridden field
    assert.equal(cfg.budgets.session_default_usd, 25);
    // Untouched sibling
    assert.equal(cfg.budgets.session_hard_ceiling_usd, 200);
  });

test("config: models.auth defaults present, overridable",
  { skip: parseHarnessConfig === null }, () => {
    const cfg = parseHarnessConfig(minimalOk);
    // Defaults: env-var name set, vault service empty.
    assert.equal(cfg.models.auth.api_key_env, "ANTHROPIC_API_KEY");
    assert.equal(cfg.models.auth.credential_service, "");
    // Override merges.
    const cfg2 = parseHarnessConfig({
      ...minimalOk,
      models: { auth: { credential_service: "anthropic-harness" } },
    });
    assert.equal(cfg2.models.auth.credential_service, "anthropic-harness");
    // env default survives partial override.
    assert.equal(cfg2.models.auth.api_key_env, "ANTHROPIC_API_KEY");
    // Model ids still default.
    assert.equal(cfg2.models.lead, "claude-fable-5");
  });

test("config: pat_routing default is github-{owner} with GH_TOKEN env fallback",
  { skip: parseHarnessConfig === null }, () => {
    const cfg = parseHarnessConfig(minimalOk);
    assert.equal(cfg.pat_routing.default_service_pattern, "github-{owner}");
    assert.equal(cfg.pat_routing.auth.api_key_env, "GH_TOKEN");
    // Override merges, env fallback survives partial override.
    const cfg2 = parseHarnessConfig({
      ...minimalOk,
      pat_routing: { default_service_pattern: "github-{owner}-{repo}" },
    });
    assert.equal(cfg2.pat_routing.default_service_pattern, "github-{owner}-{repo}");
    assert.equal(cfg2.pat_routing.auth.api_key_env, "GH_TOKEN");
  });
