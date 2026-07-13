/**
 * openclaw-agent-harness plugin entry.
 *
 * Exports the OpenClaw plugin descriptor. The runtime calls `register(api)`
 * once per lifecycle. We use that hook to:
 *   1. Parse plugin config (from OpenClaw config store)
 *   2. Open the state store (SQLite)
 *   3. Wire budget enforcer + PAT router + orchestrator loop
 *   4. Register runtime tools (harness_* namespace)
 *   5. Register Slack message hook (before-dispatch on message.received)
 *   6. Register cron jobs (retention + queue tick)
 *
 * Shape mirrors memory-hybrid: exported default is a static descriptor with
 * a `register(api)` function. The runtime provides `api.registerTool`,
 * `api.registerHook`, `api.registerService`, `api.logger`, etc.
 *
 * See docs/OpenClaw-plugin-SDK-notes.md for the actual API surface used.
 */

import type { HarnessConfig } from "./config.js";
import { parseHarnessConfig } from "./config.js";
import { openStateStore } from "./state/store.js";
import { OrchestratorLoop } from "./orchestrator/loop.js";
import { SlackChannelListener, type SlackMessageEvent } from "./slack/channel-listener.js";
import { BudgetEnforcer } from "./budgets/enforcer.js";
import { PatRouter } from "./auth/pat-router.js";
import { pruneRetention } from "./state/retention.js";
import { registerHarnessTools } from "./tools/registration.js";
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_VERSION } from "./version.js";

/**
 * Minimal shape of the OpenClaw plugin API surface that we use. The full
 * type ships with the OpenClaw runtime (see
 * `openclaw/plugin-sdk/core#ClawdbotPluginApi`); we declare only what we
 * touch to keep our compile independent.
 */
export interface HarnessPluginApi {
  registrationMode?: "cli-metadata" | "runtime";
  logger: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
    debug?: (msg: string, meta?: unknown) => void;
  };
  registerTool: (
    definition: {
      name: string;
      description: string;
      inputSchema: unknown;
      execute: (input: unknown, ctx?: unknown) => Promise<unknown> | unknown;
    },
    options?: unknown,
  ) => (() => void) | { dispose?: () => void; unregister?: () => void };
  registerHook?: (
    name: string,
    handler: (event: unknown) => unknown,
  ) => (() => void) | { dispose?: () => void };
  registerService?: (svc: {
    id: string;
    start?: () => Promise<void> | void;
    stop?: () => Promise<void> | void;
  }) => (() => void) | { dispose?: () => void };
  getConfig?: () => unknown;
  workspaceDir?: string;
}

export interface HarnessRuntime {
  config: HarnessConfig;
  state: Awaited<ReturnType<typeof openStateStore>>;
  budget: BudgetEnforcer;
  pat: PatRouter;
  loop: OrchestratorLoop;
  listener: SlackChannelListener;
  disposers: Array<() => void | Promise<void>>;
}

let currentRuntime: HarnessRuntime | null = null;

export async function bootstrapHarness(api: HarnessPluginApi): Promise<HarnessRuntime> {
  const rawConfig = (api.getConfig?.() ?? {}) as unknown;
  const config = parseHarnessConfig(rawConfig);

  const dbPath = config.storage.state_db_path.replace(
    /^~/,
    process.env.HOME ?? "",
  );
  const state = await openStateStore(dbPath);

  const budget = new BudgetEnforcer(config.budgets, state);
  const pat = new PatRouter(config.pat_routing);

  const loop = new OrchestratorLoop({
    config,
    state,
    budget,
    pat,
    logger: api.logger,
  });

  const listener = new SlackChannelListener({
    config,
    loop,
    state,
    logger: api.logger,
  });

  const runtime: HarnessRuntime = {
    config,
    state,
    budget,
    pat,
    loop,
    listener,
    disposers: [],
  };

  // Register tools (harness_status, harness_retention_prune, ...)
  const disposeTools = registerHarnessTools(api, runtime);
  runtime.disposers.push(disposeTools);

  // Slack hook -- OpenClaw dispatches inbound Slack messages via a
  // `message.received` style hook. We adapt the event shape at the edge.
  if (api.registerHook) {
    const dispose = api.registerHook("message.received", async (event) => {
      const slackEvt = event as { channel?: { provider?: string }; payload?: SlackMessageEvent } | undefined;
      if (!slackEvt?.payload) return;
      if (slackEvt.channel?.provider !== "slack") return;
      await listener.handle(slackEvt.payload);
    });
    runtime.disposers.push(() => {
      if (typeof dispose === "function") dispose();
      else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
    });
  } else {
    api.logger.warn("[harness] api.registerHook not present; Slack listener will be idle.");
  }

  // Retention prune on service start (safe, idempotent). A cron entry in
  // openclaw.json should also invoke `harness_retention_prune` daily.
  try {
    const r = pruneRetention(state, {
      auditRetentionDays: config.storage.audit_retention_days,
      pruneTerminalSessions: config.storage.prune_terminal_sessions,
    });
    api.logger.info("[harness] retention prune on start", r);
  } catch (err) {
    api.logger.warn("[harness] retention prune on start failed", { err: String(err) });
  }

  currentRuntime = runtime;
  return runtime;
}

async function teardown(runtime: HarnessRuntime, api: HarnessPluginApi): Promise<void> {
  for (const d of runtime.disposers.reverse()) {
    try {
      await d();
    } catch (err) {
      api.logger.warn("[harness] disposer failed", { err: String(err) });
    }
  }
  try {
    runtime.state.close();
  } catch (err) {
    api.logger.warn("[harness] state.close failed", { err: String(err) });
  }
}

const harnessPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  kind: "tool" as const,
  configSchema: { parse: parseHarnessConfig },
  versionInfo: PLUGIN_VERSION,
  async register(api: HarnessPluginApi): Promise<void> {
    if (api.registrationMode === "cli-metadata") {
      // CLI metadata pass: register tool names/descriptions but do NOT open
      // databases or subscribe to hooks. Same pattern memory-hybrid uses.
      api.logger.info("[harness] cli-metadata registration");
      return;
    }

    if (currentRuntime) {
      // Re-register: tear down old runtime first.
      api.logger.info("[harness] re-registering; tearing down previous runtime");
      await teardown(currentRuntime, api);
      currentRuntime = null;
    }

    try {
      await bootstrapHarness(api);
      api.logger.info(`[harness] ${PLUGIN_ID}@${PLUGIN_VERSION.pluginVersion} ready`);
    } catch (err) {
      api.logger.error("[harness] bootstrap failed", { err: String(err) });
      throw err;
    }
  },
};

export default harnessPlugin;
