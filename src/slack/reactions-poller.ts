/**
 * Reactions poller service.
 *
 * Runs a lightweight interval that, for every non-terminal session, reads
 * the current reaction snapshot from Slack and writes it into
 * `sessions.reactions_json`. The orchestrator loop reads that column on
 * each checkpoint (see loop.readReactions -> state DB), which keeps the
 * loop's per-cycle work off Slack's rate limits.
 *
 * The poll interval defaults to 15s. Slack Web API is generous for
 * `reactions.get` (Tier 3, ~50 rpm), so a channel with a handful of
 * active sessions is well within limits.
 *
 * Lifecycle:
 *   - Started by bootstrapHarness() via api.registerService()
 *   - Stops cleanly on plugin teardown (`stop()`)
 *   - No leaked timers: uses a single setTimeout chain guarded by a flag
 */

import type { StateStore } from "../state/store.js";
import type { SlackReactionsReader } from "./reactions.js";

export interface ReactionsPollerOptions {
  intervalMs?: number;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
}

const NON_TERMINAL = ["crystallising", "planning", "executing", "reviewing"] as const;

export class ReactionsPoller {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly state: StateStore,
    private readonly reader: SlackReactionsReader,
    private readonly opts: ReactionsPollerOptions,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.opts.logger.info(`[reactions-poller] starting (interval ${this.opts.intervalMs ?? 15000}ms)`);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.opts.logger.info(`[reactions-poller] stopped`);
  }

  /** Exposed for tests: run one iteration synchronously. */
  async pollOnce(): Promise<number> {
    const rows = this.state.db
      .prepare(
        `SELECT id FROM sessions
         WHERE status IN (${NON_TERMINAL.map(() => "?").join(",")})`,
      )
      .all(...NON_TERMINAL) as Array<{ id: string }>;
    let updated = 0;
    for (const { id } of rows) {
      try {
        const snap = await this.reader.read(id);
        this.state.db
          .prepare(`UPDATE sessions SET reactions_json = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(snap), Date.now(), id);
        updated++;
      } catch (err) {
        this.opts.logger.warn("[reactions-poller] read failed", { err: String(err), id });
      }
    }
    return updated;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollOnce();
    } catch (err) {
      this.opts.logger.warn("[reactions-poller] tick failed", { err: String(err) });
    }
    if (this.running) {
      this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs ?? 15000);
    }
  }
}
