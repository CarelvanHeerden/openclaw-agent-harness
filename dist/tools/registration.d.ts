/**
 * Runtime tool registration for openclaw-agent-harness.
 *
 * These are the tools OpenClaw exposes to callers (Slack users via
 * commands, other plugins, or cron jobs). They intentionally do NOT
 * include the "run a task" surface -- that entry point is the Slack
 * listener. These tools are for inspection, admin, and cron jobs.
 */
import type { HarnessPluginApi, HarnessRuntime } from "../index.js";
export declare function registerHarnessTools(api: HarnessPluginApi, runtime: HarnessRuntime): () => void;
//# sourceMappingURL=registration.d.ts.map