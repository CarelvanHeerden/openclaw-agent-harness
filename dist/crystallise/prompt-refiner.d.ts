/**
 * Prompt crystallisation.
 *
 * Rough user request in Slack -> structured, well-scoped brief that a lead
 * agent can plan against. Two-step:
 *
 *   1. Classifier (Haiku) decides intent:
 *      - "dev_task"     : real dev work, proceed to crystallisation.
 *      - "clarify"      : ambiguous, ask the user a question.
 *      - "not_dev"      : chat / non-dev request, decline politely.
 *      - "unsafe"       : mentions secrets, deletion, etc.; refuse.
 *
 *   2. If dev_task: Fable-5 crystalliser produces a strict-schema brief:
 *      { title, motivation, acceptanceCriteria[], filesLikelyTouched[],
 *        outOfScope[], repoHint, riskLevel }.
 *
 * The brief is stored on `sessions.crystallised_prompt` before the loop
 * starts. Users see it as a Slack thread reply and can react with a
 * confirming emoji before execution begins.
 */
import type { HarnessConfig } from "../config.js";
export type ClassifierIntent = "dev_task" | "clarify" | "not_dev" | "unsafe";
export interface ClassifierResult {
    intent: ClassifierIntent;
    reason: string;
    suggestedClarification?: string;
}
export interface CrystallisedBrief {
    title: string;
    motivation: string;
    acceptanceCriteria: string[];
    filesLikelyTouched: string[];
    outOfScope: string[];
    repoHint?: string;
    branchHint?: string;
    riskLevel: "low" | "medium" | "high";
}
export interface CrystalliserDeps {
    config: HarnessConfig;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
    callClassifier: (userText: string) => Promise<ClassifierResult>;
    callCrystalliser: (userText: string, classifier: ClassifierResult) => Promise<CrystallisedBrief>;
}
/**
 * The pure orchestration -- takes injected callables so unit tests never
 * hit the network.
 */
export declare function crystallisePrompt(userText: string, deps: CrystalliserDeps): Promise<{
    kind: "brief";
    brief: CrystallisedBrief;
    classification: ClassifierResult;
} | {
    kind: "clarify";
    question: string;
} | {
    kind: "reject";
    reason: string;
    intent: ClassifierIntent;
}>;
//# sourceMappingURL=prompt-refiner.d.ts.map