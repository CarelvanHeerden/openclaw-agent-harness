/**
 * Reactions poller service.
 *
 * Runs a lightweight interval that, for every ACTIVE non-terminal session,
 * reads the current reaction snapshot from Slack and writes it into
 * `sessions.reactions_json`. The orchestrator loop reads that column on
 * each checkpoint (see loop.readReactions -> state DB), which keeps the
 * loop's per-cycle work off Slack's rate limits.
 *
 * Rate-limit awareness (added 2026-07-13 in response to maintainer review):
 *
 * - Base interval: 15 s. At 1 session that's 5,760 calls/day well inside
 *   Slack's Tier 3 (50 rpm) budget.
 * - Adaptive backoff: if a tick returns NO new reactions across ALL polled
 *   sessions, the next interval doubles (up to `maxIntervalMs`, default
 *   120 s). Any new reaction resets to the base interval. This keeps
 *   quiet channels cheap without sacrificing responsiveness during a
 *   review.
 * - Concurrency cap: at most `maxPerTick` sessions are polled per tick
 *   (default 20). Above that we round-robin across ticks so a busy
 *   channel with dozens of concurrent sessions doesn't burst-hit Slack.
 * - 429 handling: if the SlackReactionsReader throws an object with a
 *   `retryAfterSeconds` field, we honour it: we skip polling entirely for
 *   that many seconds (interval becomes max(retryAfter*1000, current
 *   interval)) and log a warning.
 * - Idle skip: when there are zero non-terminal sessions we log once and
 *   stay idle at maxIntervalMs (no Slack calls).
 *
 * Lifecycle:
 *   - Started by bootstrapHarness() via api.registerService()
 *   - Stops cleanly on plugin teardown (`stop()`)
 *   - No leaked timers: single setTimeout chain guarded by a flag
 */
import type { StateStore } from "../state/store.js";
import type { SlackReactionsReader } from "./reactions.js";
export interface ReactionsPollerOptions {
    intervalMs?: number;
    maxIntervalMs?: number;
    maxSessionsPerTick?: number;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
}
export declare class ReactionsPoller {
    private readonly state;
    private readonly reader;
    private readonly opts;
    private running;
    private timer;
    private currentIntervalMs;
    private readonly baseIntervalMs;
    private readonly maxIntervalMs;
    private readonly maxPerTick;
    private cursor;
    private lastIdleLogAt;
    private lastReactionsHash;
    constructor(state: StateStore, reader: SlackReactionsReader, opts: ReactionsPollerOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Exposed for tests. Returns count of sessions polled (not "with changes"). */
    pollOnce(): Promise<number>;
    /** Test hook: returns the current adaptive interval. */
    get intervalMs(): number;
    private tick;
}
//# sourceMappingURL=reactions-poller.d.ts.map