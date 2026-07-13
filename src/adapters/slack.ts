/**
 * Slack adapter.
 *
 * The harness needs to:
 *   - post replies into a thread
 *   - add/remove emoji reactions (for lifecycle signals)
 *   - listen for reactions on our own messages (ship_it, abort, pause, budget_bump)
 *
 * We prefer to use OpenClaw's built-in messaging pipeline (`api.sendMessage`
 * / hook events) instead of hitting Slack's Web API directly. This keeps
 * routing consistent and lets OpenClaw handle rate limits, redaction, and
 * envelope metadata for us.
 *
 * The adapter is a thin wrapper so tests can inject mocks.
 */

export interface SlackAdapterDeps {
  /**
   * OpenClaw's outbound send. Wraps chat.postMessage under the hood.
   */
  sendMessage: (input: { channel: string; threadTs?: string; text: string; blocks?: unknown[] }) => Promise<{ ts: string }>;

  /**
   * OpenClaw's reaction API (reactions.add / remove).
   */
  addReaction?: (input: { channel: string; ts: string; name: string }) => Promise<void>;
  removeReaction?: (input: { channel: string; ts: string; name: string }) => Promise<void>;

  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}

export class SlackAdapter {
  constructor(private readonly deps: SlackAdapterDeps) {}

  async replyInThread(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<{ ts: string }> {
    return this.deps.sendMessage({ channel, threadTs, text, blocks });
  }

  async postNew(channel: string, text: string): Promise<{ ts: string }> {
    return this.deps.sendMessage({ channel, text });
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    if (!this.deps.addReaction) {
      this.deps.logger.warn("[slack] addReaction not wired; skipping", { channel, ts, name });
      return;
    }
    try {
      await this.deps.addReaction({ channel, ts, name });
    } catch (err) {
      // Slack returns already_reacted -- harmless, log and continue.
      const msg = String(err);
      if (/already_reacted/.test(msg)) return;
      this.deps.logger.warn("[slack] addReaction failed", { channel, ts, name, err: msg });
    }
  }
}
