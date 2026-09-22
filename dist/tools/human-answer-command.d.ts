import type { DatabaseSync } from "node:sqlite";
/** Includes all execution-authority state, excluding routine heartbeat timestamps. */
export declare function pendingAnswerState(db: DatabaseSync, sessionId: string): any;
export declare function answerStateHash(value: unknown): string;
/**
 * Show everything that can affect THIS decision without dumping every unrelated
 * plan task into Slack. The receipt still hashes the complete persisted state,
 * including the full lead_plan_json, so omitted plan tasks cannot change after
 * review. Large decision payloads are paged rather than rejected.
 */
export declare function pendingAnswerReview(state: any): string;
export declare function reviewPages(state: unknown): string[];
export declare function renderHumanAnswerReview(state: any, sessionId: string, challenge: string, page: number): {
    text: string;
};
export declare function issueHumanAnswer(db: DatabaseSync, sessionId: string, sender: string): {
    text: string;
};
//# sourceMappingURL=human-answer-command.d.ts.map