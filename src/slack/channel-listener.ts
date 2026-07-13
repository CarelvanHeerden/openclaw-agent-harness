/**
 * Slack channel listener.
 *
 * Watches the configured dev channel. On a message from an authorised user,
 * classifies intent and, if it looks like a dev task, kicks off the
 * crystallisation flow.
 *
 * PHASE 0 SCAFFOLD.
 */

import type { HarnessConfig } from "../config.js";
import type { OrchestratorLoop } from "../orchestrator/loop.js";

export interface ListenerDeps {
  config: HarnessConfig;
  loop: OrchestratorLoop;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
}

export class SlackChannelListener {
  constructor(private readonly deps: ListenerDeps) {}

  async handle(_event: unknown): Promise<void> {
    // TODO(phase-1):
    //   1. filter by config.slack.authorised_users
    //   2. skip bot / edit / delete events
    //   3. classify intent (haiku)
    //   4. if dev_task: crystallisePrompt -> loop.run(...)
    //   5. handle reactions (ship_it, abort, pause, budget_bump)
    this.deps.logger.info("[slack-listener] handle() called but not implemented (phase-0 scaffold)");
  }
}
