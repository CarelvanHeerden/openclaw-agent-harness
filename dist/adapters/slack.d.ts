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
    sendMessage: (input: {
        channel: string;
        threadTs?: string;
        text: string;
        blocks?: unknown[];
    }) => Promise<{
        ts: string;
    }>;
    /**
     * OpenClaw's reaction API (reactions.add / remove).
     */
    addReaction?: (input: {
        channel: string;
        ts: string;
        name: string;
    }) => Promise<void>;
    removeReaction?: (input: {
        channel: string;
        ts: string;
        name: string;
    }) => Promise<void>;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
}
export declare class SlackAdapter {
    private readonly deps;
    constructor(deps: SlackAdapterDeps);
    replyInThread(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<{
        ts: string;
    }>;
    postNew(channel: string, text: string): Promise<{
        ts: string;
    }>;
    addReaction(channel: string, ts: string, name: string): Promise<void>;
}
//# sourceMappingURL=slack.d.ts.map