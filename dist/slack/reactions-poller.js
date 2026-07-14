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
const NON_TERMINAL = ["crystallising", "planning", "executing", "reviewing"];
export class ReactionsPoller {
    state;
    reader;
    opts;
    running = false;
    timer;
    currentIntervalMs;
    baseIntervalMs;
    maxIntervalMs;
    maxPerTick;
    cursor = 0; // round-robin cursor across ticks
    lastIdleLogAt = 0;
    lastReactionsHash = {};
    constructor(state, reader, opts) {
        this.state = state;
        this.reader = reader;
        this.opts = opts;
        this.baseIntervalMs = opts.intervalMs ?? 15000;
        this.maxIntervalMs = opts.maxIntervalMs ?? 120000;
        this.maxPerTick = opts.maxSessionsPerTick ?? 20;
        this.currentIntervalMs = this.baseIntervalMs;
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        this.opts.logger.info(`[reactions-poller] starting`, {
            baseIntervalMs: this.baseIntervalMs,
            maxIntervalMs: this.maxIntervalMs,
            maxSessionsPerTick: this.maxPerTick,
        });
        void this.tick();
    }
    async stop() {
        this.running = false;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.opts.logger.info(`[reactions-poller] stopped`);
    }
    /** Exposed for tests. Returns count of sessions polled (not "with changes"). */
    async pollOnce() {
        const rows = this.state.db
            .prepare(`SELECT id FROM sessions
         WHERE status IN (${NON_TERMINAL.map(() => "?").join(",")})`)
            .all(...NON_TERMINAL);
        if (rows.length === 0) {
            // Idle: no active sessions. Log at most once per 5min, then stay in
            // maxInterval and issue no Slack calls until sessions appear.
            const now = Date.now();
            if (now - this.lastIdleLogAt > 5 * 60_000) {
                this.opts.logger.info(`[reactions-poller] idle (no non-terminal sessions)`);
                this.lastIdleLogAt = now;
            }
            this.currentIntervalMs = this.maxIntervalMs;
            return 0;
        }
        // Round-robin subset when there are more sessions than the per-tick cap
        let ids = rows.map((r) => r.id);
        if (ids.length > this.maxPerTick) {
            const start = this.cursor % ids.length;
            ids = [
                ...ids.slice(start, start + this.maxPerTick),
                ...ids.slice(0, Math.max(0, this.maxPerTick - (ids.length - start))),
            ];
            this.cursor = (this.cursor + this.maxPerTick) % rows.length;
        }
        let polled = 0;
        let sawChange = false;
        for (const id of ids) {
            try {
                const snap = await this.reader.read(id);
                const serialised = JSON.stringify(snap);
                const prev = this.lastReactionsHash[id];
                if (prev !== serialised) {
                    this.state.db
                        .prepare(`UPDATE sessions SET reactions_json = ?, updated_at = ? WHERE id = ?`)
                        .run(serialised, Date.now(), id);
                    this.lastReactionsHash[id] = serialised;
                    sawChange = true;
                }
                polled++;
            }
            catch (err) {
                // Slack sends 429 with Retry-After header; our reader translates to
                // { retryAfterSeconds }. Honour it globally: skip this whole tick
                // and delay the next one.
                const asObj = err;
                if (typeof asObj?.retryAfterSeconds === "number" && asObj.retryAfterSeconds > 0) {
                    const delayMs = Math.min(asObj.retryAfterSeconds * 1000, this.maxIntervalMs);
                    this.opts.logger.warn(`[reactions-poller] 429 from Slack; backing off`, { retryAfterSeconds: asObj.retryAfterSeconds, delayMs });
                    this.currentIntervalMs = Math.max(this.currentIntervalMs, delayMs);
                    return polled;
                }
                this.opts.logger.warn(`[reactions-poller] read failed`, { err: String(err), id });
            }
        }
        // Adaptive interval: no change -> double up to cap; change -> reset.
        if (sawChange) {
            if (this.currentIntervalMs !== this.baseIntervalMs) {
                this.opts.logger.info(`[reactions-poller] reset to base interval on new reaction`);
            }
            this.currentIntervalMs = this.baseIntervalMs;
        }
        else {
            this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxIntervalMs);
        }
        // Trim the per-session hash cache so it can't grow unbounded across
        // long-lived processes (drop entries for sessions no longer polled).
        const active = new Set(rows.map((r) => r.id));
        for (const key of Object.keys(this.lastReactionsHash)) {
            if (!active.has(key))
                delete this.lastReactionsHash[key];
        }
        return polled;
    }
    /** Test hook: returns the current adaptive interval. */
    get intervalMs() {
        return this.currentIntervalMs;
    }
    async tick() {
        if (!this.running)
            return;
        try {
            await this.pollOnce();
        }
        catch (err) {
            this.opts.logger.warn("[reactions-poller] tick failed", { err: String(err) });
        }
        if (this.running) {
            this.timer = setTimeout(() => void this.tick(), this.currentIntervalMs);
        }
    }
}
//# sourceMappingURL=reactions-poller.js.map