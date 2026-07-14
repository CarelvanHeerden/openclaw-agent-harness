/**
 * Slack channel listener.
 *
 * Watches the configured dev channel. On a message from an authorised user,
 * classifies intent and, if it looks like a dev task, kicks off the
 * crystallisation flow.
 *
 * Session isolation rule (Rule #1 - hard invariant):
 *   1 Slack thread = at most 1 harness session.
 *
 * Enforced by:
 *   - A UNIQUE index on sessions(slack_channel, slack_thread) in schema.sql.
 *   - The routeMessage() logic below: top-level channel posts always start a
 *     new thread; in-thread replies bind to the existing session for that
 *     thread and never spawn a second one.
 *
 * PHASE 0 SCAFFOLD. handle() body wired in phase 1.
 */
import type { HarnessConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { Dispatcher } from "./dispatcher.js";
export interface ListenerDeps {
    config: HarnessConfig;
    state: StateStore;
    dispatcher: Dispatcher;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
}
export interface SlackMessageEvent {
    channel: string;
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
    subtype?: string;
    bot_id?: string;
}
export type RouteDecision = {
    kind: "ignore";
    reason: string;
} | {
    kind: "start_new_session";
    threadTs: string;
} | {
    kind: "continue_session";
    sessionId: string;
    threadTs: string;
} | {
    kind: "reject_top_level_reply";
    threadTs: string;
};
export declare class SlackChannelListener {
    private readonly deps;
    constructor(deps: ListenerDeps);
    /**
     * Pure decision function. Given an inbound message + current DB state,
     * decides how to route it. Kept pure so it can be unit-tested without
     * mocking Slack, the SDK, or the DB.
     */
    routeMessage(evt: SlackMessageEvent): RouteDecision;
    handle(evt: SlackMessageEvent): Promise<void>;
}
//# sourceMappingURL=channel-listener.d.ts.map