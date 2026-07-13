/**
 * Reactions poller service.
 *
 * Runs a lightweight interval that, for every non-terminal session, reads
 * the current reaction snapshot from Slack and writes it into
 * `sessions.reactions_json`. The orchestrator loop reads that column on
 * each checkpoint (see loop.readReactions -> state DB), which keeps the
 * loop's per-cycle work off Slack's rate limits.
 *
 * The poll interval defaults to 30s (round-3, 2026-07-13, bumped from
 * 15s). Reactions are not time-critical — the loop only reads them at
 * checkpoint boundaries — so a slower baseline saves rate-limit budget.
 *
 * Additionally, we track a per-session snapshot hash and apply exponential
 * backoff (up to 5x the base interval) for sessions whose reactions don't
 * change between polls. Any change resets the backoff. Slack Web API is
 * generous for `reactions.get` (Tier 3, ~50 rpm), and this keeps a large
 * channel with many idle sessions well within limits.
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
  /** Maximum multiplier on the base interval for unchanged snapshots. Default 5. */
  maxBackoffMultiplier?: number;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
}

const NON_TERMINAL = ["crystallising", "planning", "executing", "reviewing"] as const;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BACKOFF = 5;

interface SessionPollState {
  lastHash: string;
  /** Number of consecutive unchanged polls (0..maxBackoffMultiplier). */
  streak: number;
  /** Poll counter at which this session was last polled. */
  lastPolledTick: number;
}

export class ReactionsPoller {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private tickCounter = 0;
  private readonly sessionState = new Map<string, SessionPollState>();

  constructor(
    private readonly state: StateStore,
    private readonly reader: SlackReactionsReader,
    private readonly opts: ReactionsPollerOptions,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.opts.logger.info(
      `[reactions-poller] starting (interval ${this.opts.intervalMs ?? DEFAULT_INTERVAL_MS}ms, max backoff ${this.opts.maxBackoffMultiplier ?? DEFAULT_MAX_BACKOFF}x)`,
    );
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.opts.logger.info(`[reactions-poller] stopped`);
  }

  /**
   * Exposed for tests: run one iteration synchronously.
   *
   * Only sessions in a non-terminal status are polled (terminal sessions
   * will never see a new reaction that matters to the loop). Within that
   * set, sessions whose reaction snapshot has not changed since the last
   * poll are subject to exponential backoff: we skip them for `streak`
   * consecutive ticks, capped at `maxBackoffMultiplier`.
   *
   * Returns the number of sessions whose row was actually updated.
   */
  async pollOnce(): Promise<number> {
    this.tickCounter++;
    const rows = this.state.db
      .prepare(
        `SELECT id FROM sessions
         WHERE status IN (${NON_TERMINAL.map(() => "?").join(",")})`,
      )
      .all(...NON_TERMINAL) as Array<{ id: string }>;

    // Reap state entries for sessions that are no longer active.
    const activeIds = new Set(rows.map((r) => r.id));
    for (const id of this.sessionState.keys()) {
      if (!activeIds.has(id)) this.sessionState.delete(id);
    }

    const maxBackoff = this.opts.maxBackoffMultiplier ?? DEFAULT_MAX_BACKOFF;
    let updated = 0;
    for (const { id } of rows) {
      const st = this.sessionState.get(id);
      if (st && this.shouldSkipForBackoff(st, maxBackoff)) continue;

      try {
        const snap = await this.reader.read(id);
        const serialised = JSON.stringify(snap);
        const hash = fnv1a(serialised);
        const prev = this.sessionState.get(id);
        const unchanged = prev && prev.lastHash === hash;
        this.sessionState.set(id, {
          lastHash: hash,
          streak: unchanged ? Math.min(prev!.streak + 1, maxBackoff) : 0,
          lastPolledTick: this.tickCounter,
        });
        this.state.db
          .prepare(`UPDATE sessions SET reactions_json = ?, updated_at = ? WHERE id = ?`)
          .run(serialised, Date.now(), id);
        updated++;
      } catch (err) {
        this.opts.logger.warn("[reactions-poller] read failed", { err: String(err), id });
      }
    }
    return updated;
  }

  /** Test hook: expose per-session backoff state. */
  _debugState(): Map<string, SessionPollState> {
    return this.sessionState;
  }

  private shouldSkipForBackoff(st: SessionPollState, maxBackoff: number): boolean {
    // With streak=0 we poll every tick. With streak=k (1..maxBackoff) we
    // insert k skipped ticks between reads, i.e. we read on tick L+k+1
    // after last read at L. Yields effective intervals of 2x, 3x, ..., up
    // to (maxBackoff+1)x the base interval for idle sessions.
    if (st.streak <= 0) return false;
    const k = Math.min(st.streak, maxBackoff);
    return (this.tickCounter - st.lastPolledTick) <= k;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollOnce();
    } catch (err) {
      this.opts.logger.warn("[reactions-poller] tick failed", { err: String(err) });
    }
    if (this.running) {
      this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    }
  }
}

/** Cheap 32-bit FNV-1a hash for short snapshot strings. Not for security. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
