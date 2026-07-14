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
import type { StateStore } from "../state/store.js";
import type { GitAdapter } from "./git-worktree.js";
export interface PrWatcherOptions {
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
    fetchImpl?: typeof fetch;
    intervalMs?: number;
    git?: GitAdapter;
    slackNotify?: (channel: string, threadTs: string, text: string) => Promise<unknown>;
    /** Resolves the PAT service to use for a given repo + slack user. */
    resolveGhToken: (repo: string, slackUserId: string) => Promise<string>;
}
export declare class PrMergedWatcher {
    private readonly state;
    private readonly opts;
    private running;
    private timer;
    constructor(state: StateStore, opts: PrWatcherOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Public for tests: run one iteration. Returns number of sessions closed. */
    pollOnce(): Promise<number>;
    private fetchPrState;
    private finalise;
    private tick;
}
export declare function parsePrUrl(url: string): {
    owner: string;
    repo: string;
    number: number;
} | null;
//# sourceMappingURL=github-watcher.d.ts.map