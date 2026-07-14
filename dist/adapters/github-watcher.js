/**
 * GitHub PR-merged watcher.
 *
 * Runs on a timer. For every session with `final_pr_url` set and status
 * still 'done' (not yet marked shipped-and-closed), asks GitHub if the
 * PR has been merged / closed. When it has:
 *   - drops a Slack note in the session's thread
 *   - marks the session with a `pr_merged_at` timestamp (soft column;
 *     schema-forward-compatible, stored as JSON in reactions_json for
 *     now to avoid a migration on beta)
 *   - releases the worktree
 *
 * Cheap: `GET /repos/:owner/:repo/pulls/:number` is a single request per
 * open session, capped at the number of sessions in-flight. Slack rate
 * limits are the more constraining side; we back off to 5 minutes.
 */
export class PrMergedWatcher {
    state;
    opts;
    running = false;
    timer;
    constructor(state, opts) {
        this.state = state;
        this.opts = opts;
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        this.opts.logger.info(`[pr-watcher] starting (interval ${this.opts.intervalMs ?? 300_000}ms)`);
        void this.tick();
    }
    async stop() {
        this.running = false;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.opts.logger.info(`[pr-watcher] stopped`);
    }
    /** Public for tests: run one iteration. Returns number of sessions closed. */
    async pollOnce() {
        const rows = this.state.db
            .prepare(`SELECT id, requester, repo, final_pr_url, slack_channel, slack_thread, worktree_path
         FROM sessions
         WHERE status = 'done' AND final_pr_url IS NOT NULL AND final_pr_url != ''
           AND pr_closed_at IS NULL`)
            .all();
        let closed = 0;
        for (const row of rows) {
            const info = parsePrUrl(row.final_pr_url);
            if (!info)
                continue;
            try {
                const ghToken = await this.opts.resolveGhToken(row.repo, row.requester);
                const state = await this.fetchPrState(info.owner, info.repo, info.number, ghToken);
                if (!state)
                    continue;
                if (state.state === "closed" || state.merged) {
                    await this.finalise(row, state);
                    closed++;
                }
            }
            catch (err) {
                this.opts.logger.warn("[pr-watcher] poll failed", { err: String(err), sessionId: row.id });
            }
        }
        return closed;
    }
    async fetchPrState(owner, repo, number, ghToken) {
        const fetchFn = this.opts.fetchImpl ?? fetch;
        const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
            headers: {
                Authorization: `Bearer ${ghToken}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "openclaw-agent-harness/0.1",
            },
        });
        if (!res.ok) {
            this.opts.logger.warn("[pr-watcher] GH fetch failed", { status: res.status });
            return null;
        }
        const j = (await res.json());
        return { state: j.state, merged: j.merged, mergedAt: j.merged_at };
    }
    async finalise(row, state) {
        // Proper columns as of 2026-07-13. `reactions_json` no longer stores
        // PR lifecycle (that was a beta-era shortcut). See src/state/store.ts.
        const now = Date.now();
        const mergedAtMs = state.mergedAt ? (Date.parse(state.mergedAt) || null) : null;
        this.state.db.prepare(`UPDATE sessions
          SET pr_closed_at = ?,
              pr_merged    = ?,
              pr_merged_at = ?,
              updated_at   = ?
        WHERE id = ?`).run(now, state.merged ? 1 : 0, mergedAtMs, now, row.id);
        this.state.audit("pr-watcher.closed", { sessionId: row.id, merged: state.merged, mergedAt: state.mergedAt }, row.id);
        const text = state.merged
            ? `:white_check_mark: PR merged: ${row.final_pr_url}. Cleaning up.`
            : `:no_entry_sign: PR closed without merge: ${row.final_pr_url}.`;
        try {
            await this.opts.slackNotify?.(row.slack_channel, row.slack_thread, text);
        }
        catch (err) {
            this.opts.logger.warn("[pr-watcher] slack notify failed", { err: String(err), sessionId: row.id });
        }
        // Release the worktree
        if (this.opts.git && row.worktree_path) {
            try {
                await this.opts.git.release(row.id, row.repo);
            }
            catch (err) {
                this.opts.logger.warn("[pr-watcher] worktree release failed", { err: String(err), sessionId: row.id });
            }
        }
    }
    async tick() {
        if (!this.running)
            return;
        try {
            await this.pollOnce();
        }
        catch (err) {
            this.opts.logger.warn("[pr-watcher] tick failed", { err: String(err) });
        }
        if (this.running) {
            this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs ?? 300_000);
        }
    }
}
export function parsePrUrl(url) {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m)
        return null;
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
}
//# sourceMappingURL=github-watcher.js.map