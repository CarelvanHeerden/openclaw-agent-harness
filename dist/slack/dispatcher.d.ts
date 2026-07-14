/**
 * Slack -> harness dispatcher.
 *
 * The dispatcher is the glue between the Slack listener (pure routing +
 * event ingestion) and the orchestrator loop (heavy async work).
 *
 * Responsibilities:
 *   1. Insert a `sessions` row on `start_new_session`, respecting the
 *      UNIQUE(slack_channel, slack_thread) constraint.
 *   2. Kick off `crystallisePrompt()` for the first user message.
 *   3. On successful brief, hand to orchestrator loop (fire-and-forget;
 *      Slack replies are pushed by the loop's `reportProgress`).
 *   4. On `continue_session`, accept follow-up messages (currently: log +
 *      react so users know we saw them; a real conversational refinement
 *      pass is future work).
 *
 * The dispatcher owns the "session-level" try/catch that reports failures
 * back to Slack so the user isn't left staring at a silent thread.
 */
import type { HarnessConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { OrchestratorLoop } from "../orchestrator/loop.js";
import type { SlackMessageEvent } from "./channel-listener.js";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
export interface DispatcherDeps {
    config: HarnessConfig;
    state: StateStore;
    loop: OrchestratorLoop;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
    crystallise: (userText: string) => Promise<{
        kind: "brief";
        brief: CrystallisedBrief;
        costUsd: number;
    } | {
        kind: "clarify";
        question: string;
        costUsd: number;
    } | {
        kind: "reject";
        intent: "not_dev" | "unsafe";
        reason: string;
        costUsd: number;
    }>;
    slackReply: (channel: string, threadTs: string, text: string) => Promise<{
        ts: string;
    }>;
    slackReact: (channel: string, ts: string, name: string) => Promise<void>;
}
export declare class Dispatcher {
    private readonly deps;
    constructor(deps: DispatcherDeps);
    /**
     * Called when `routeMessage()` returns `start_new_session`. Creates the
     * session row (UNIQUE constraint enforces uniqueness), reacts to the
     * origin message with an "on it" emoji, then crystallises and hands off.
     */
    startNewSession(evt: SlackMessageEvent): Promise<void>;
    private runSession;
    /**
     * Called for follow-up messages inside an existing thread's session. Right
     * now we simply log + react. Conversational refinement (mid-flight scope
     * changes, override reactions delivered as messages) lands next.
     */
    continueSession(sessionId: string, evt: SlackMessageEvent): Promise<void>;
}
//# sourceMappingURL=dispatcher.d.ts.map