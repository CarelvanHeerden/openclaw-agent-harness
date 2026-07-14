/**
 * Slack reaction reader.
 *
 * The orchestrator loop polls this on every checkpoint to decide whether
 * to short-circuit (ship_it, abort) or extend budget (budget_bump). Reads
 * are cheap (a single `conversations.replies` + a `reactions.get` on the
 * origin message).
 *
 * Only reactions from `slack.authorised_users` count. This prevents a
 * random channel visitor from aborting an in-flight session.
 */
import type { HarnessConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
export interface ReactionSnapshot {
    shipIt: boolean;
    abort: boolean;
    pause: boolean;
    budgetBump: boolean;
}
export interface ReactionsDeps {
    config: HarnessConfig;
    state: StateStore;
    slackToken: string;
    fetchImpl?: typeof fetch;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
}
export declare class SlackReactionsReader {
    private readonly deps;
    constructor(deps: ReactionsDeps);
    private fetchFn;
    /**
     * Read reactions for `sessionId`. Aggregates the origin message + every
     * message the harness itself posted in the thread (those bot messages
     * are where users typically drop the `:rocket:` / `:x:`).
     */
    read(sessionId: string): Promise<ReactionSnapshot>;
    private reactionsForMessage;
    private threadReplyTimestamps;
}
//# sourceMappingURL=reactions.d.ts.map