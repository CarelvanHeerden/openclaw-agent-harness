/**
 * Slack adapter.
 *
 * The harness uses this adapter only for outbound messages.
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
}
