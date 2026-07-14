/**
 * Adapters over `@anthropic-ai/claude-agent-sdk`.
 *
 * These wrap the SDK so callers get a stable, testable shape:
 *   - `runWorker()`: single-turn worker with canUseTool + tools.
 *   - `runReviewer()`: single-turn adversary with JSON-only output.
 *   - `runClassifier()`: single-turn intent classifier.
 *   - `runLead()`: single-turn planner returning a strict LeadPlan.
 *
 * All wrappers convert the streaming AsyncIterator into a single terminal
 * result and count usage. The SDK's `canUseTool` callback signature is a
 * function `(toolName, toolInput) => { behavior: "allow" | "deny", ... }`.
 * We adapt our internal `{ allow, reason }` shape to that.
 *
 * NOTE (2026-07-13): This module lazy-imports the SDK so tests can run
 * without the real SDK installed. Production code will error clearly if
 * the SDK is missing.
 */
import type { ClassifierResult, CrystallisedBrief } from "../crystallise/prompt-refiner.js";
import type { LeadPlan } from "../orchestrator/fable5-lead.js";
export interface RunWorkerParams {
    worktreePath: string;
    systemPrompt: string;
    userMessage: string;
    model: string;
    permissionMode: "acceptEdits" | "bypassPermissions" | "plan";
    resumeSessionId?: string;
    timeoutSeconds: number;
    canUseTool: (toolName: string, toolInput: unknown) => Promise<{
        allow: boolean;
        reason?: string;
    }>;
}
export interface RunWorkerResult {
    sdkSessionId: string;
    stopReason: "end_turn" | "max_tokens" | "tool_error" | "timeout" | "canceled";
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    logsExcerpt: string;
}
export declare function runWorkerSdk(params: RunWorkerParams): Promise<RunWorkerResult>;
/**
 * Extracts the first well-formed top-level JSON object or array from a
 * string. Handles the common case where the model wraps output in prose
 * or a fenced code block despite instructions.
 *
 * WARNING: prefer `extractAndValidateJson()` over calling this directly.
 * If the model outputs `{"foo":1}\n{"bar":2}` we return only the first object;
 * without validation you can silently miss the second half of the response.
 */
export declare function extractJson(text: string): string;
export interface JsonValidationOptions<T> {
    /** Required top-level keys on the parsed object. Missing keys throw. */
    requiredKeys: readonly (keyof T)[];
    /** Optional per-key type checker. Values that fail throw. */
    typeCheck?: (parsed: unknown) => parsed is T;
    /** Warn if the raw text after the JSON object contains more JSON. Default true. */
    warnOnTrailingJson?: boolean;
    /** Logger for the trailing-JSON warning. */
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
    /** Context label for error messages (e.g. "lead planner"). */
    label?: string;
}
/**
 * Robust wrapper around `extractJson()`.
 *  - Extracts the first JSON object/array.
 *  - Parses it.
 *  - Verifies required top-level keys are present.
 *  - Optionally warns (not throws) when the raw response contains a
 *    second JSON object we're silently discarding.
 *  - Rethrows with the ORIGINAL raw text on any failure, so an operator
 *    can see exactly what the model returned.
 */
export declare function extractAndValidateJson<T>(rawText: string, opts: JsonValidationOptions<T>): T;
export declare function runClassifierSdk(params: {
    model: string;
    userText: string;
    timeoutSeconds: number;
}): Promise<ClassifierResult & {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
}>;
export declare function runCrystalliserSdk(params: {
    model: string;
    userText: string;
    timeoutSeconds: number;
}): Promise<CrystallisedBrief & {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
}>;
export declare function runLeadSdk(params: {
    model: string;
    brief: CrystallisedBrief;
    reposAllowed: string[];
    timeoutSeconds: number;
}): Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd"> & {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
}>;
export declare function splitDiffOnFileBoundaries(diff: string, maxBytes?: number): string[];
export declare function runAdversarySdk(params: {
    model: string;
    systemPrompt: string;
    diffText: string;
    timeoutSeconds: number;
}): Promise<{
    parsed: {
        verdict: "pass" | "revise" | "block";
        findings: unknown[];
        summary: string;
    };
    sdkSessionId: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    chunkedReview?: {
        chunkCount: number;
        totalBytes: number;
    };
}>;
/**
 * Cost estimation table (USD per M tokens).
 *
 * Update policy: these prices WILL drift. `estimateSubTaskCost()` is used
 * only for BUDGET PROJECTIONS in the loop; the authoritative source of
 * truth is the `total_cost_usd` returned by the SDK on each call, which we
 * accumulate in the state store.
 *
 * `checkPriceDrift()` runs whenever we get a real SDK cost back and compares
 * it against our estimate. Drift > 20% logs a warning so we can update the
 * table. Pricing is also configurable at plugin config time via
 * `harness.models.price_overrides` (see config.ts), so operators can patch
 * without waiting for a release.
 */
export declare const PRICES: Record<string, {
    input: number;
    output: number;
}>;
export declare function estimateSubTaskCost(model: string, tokens: number, overrides?: Record<string, {
    input: number;
    output: number;
}>): number;
/**
 * Called after a real SDK call. Returns { drift, warn } where warn=true when
 * the actual cost deviates > 20% from our estimate for that model+tokens.
 * Callers should log the warning (with model + actual + estimate) so we
 * catch stale price tables in one run instead of over billing cycles.
 */
export declare function checkPriceDrift(model: string, actualCostUsd: number, tokensIn: number, tokensOut: number, overrides?: Record<string, {
    input: number;
    output: number;
}>): {
    drift: number;
    warn: boolean;
    estimated: number;
};
//# sourceMappingURL=claude-sdk.d.ts.map