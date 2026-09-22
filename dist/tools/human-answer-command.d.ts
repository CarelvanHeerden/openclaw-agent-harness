import type { DatabaseSync } from "node:sqlite";
/** Includes all execution-authority state, excluding routine heartbeat timestamps. */
export declare function pendingAnswerState(db: DatabaseSync, sessionId: string): Record<string, import("node:sqlite").SQLOutputValue> | undefined;
export declare function answerStateHash(value: unknown): string;
export declare function issueHumanAnswer(db: DatabaseSync, sessionId: string, sender: string): {
    text: string;
};
//# sourceMappingURL=human-answer-command.d.ts.map