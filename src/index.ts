/**
 * openclaw-agent-harness plugin entry point.
 *
 * NOTE: Phase 0 scaffold. Nothing here is wired yet. The goal of this file is
 * to declare the plugin surface so it type-checks and can be imported by
 * OpenClaw's plugin loader once the config schema is finalised.
 *
 * Later phases fill in:
 *   - Slack listener registration
 *   - Tool registration (harness_start_session, harness_session_status, ...)
 *   - Orchestrator wiring
 *
 * See docs/ARCHITECTURE.md for the full design.
 */

import type { HarnessConfig } from "./config.js";
import { openStateStore } from "./state/store.js";
import { OrchestratorLoop } from "./orchestrator/loop.js";
import { SlackChannelListener, type SlackMessageEvent } from "./slack/channel-listener.js";
import { BudgetEnforcer } from "./budgets/enforcer.js";
import { PatRouter } from "./auth/pat-router.js";

export interface PluginHost {
  // Minimal shape of what OpenClaw exposes to a plugin. Real interface will
  // be imported from OpenClaw's plugin SDK once we integrate.
  logger: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
  config: HarnessConfig;
  registerTool: (name: string, handler: (input: unknown) => Promise<unknown>) => void;
  registerSlackMessageListener: (
    channel: string,
    handler: (event: unknown) => Promise<void>,
  ) => void;
  credentialGet: (service: string) => Promise<{ value: string } | null>;
}

export async function init(host: PluginHost): Promise<void> {
  host.logger.info("[openclaw-agent-harness] initialising", {
    version: "0.0.1",
  });

  const state = await openStateStore(host.config.storage.state_db_path);
  const budgets = new BudgetEnforcer(host.config.budgets, state);
  const pat = new PatRouter(host.config.pat_routing, host.credentialGet);
  const loop = new OrchestratorLoop({
    config: host.config,
    state,
    budgets,
    pat,
    logger: host.logger,
  });

  const listener = new SlackChannelListener({
    config: host.config,
    loop,
    state,
    logger: host.logger,
  });

  host.registerSlackMessageListener(host.config.slack.channel, (event) =>
    listener.handle(event as SlackMessageEvent),
  );

  // Tools registered here in later phases.
  host.registerTool("harness_session_status", async () => ({
    ok: true,
    note: "phase-0 scaffold, not implemented yet",
  }));

  host.logger.info("[openclaw-agent-harness] initialised");
}

export default { init };
