/**
 * The structured-output ladder, and what happens when it runs out.
 *
 * Six of the eight roles ask a model for a JSON document and parse what comes
 * back. Neither backend offers a forced-output mode, so "the model returned
 * prose" is not an error condition to be handled once — it is a routine event
 * with a defined response. v1 handled it twice: the lead grew an elaborate
 * three-attempt ladder over beta.97 through beta.128, and the adversary grew
 * nothing at all and simply threw.
 *
 * v2 makes it one ladder both backends climb, because pointing the worker at a
 * local model makes a malformed or truncated reply likelier, not rarer.
 *
 *   1. extract    — pull the JSON out of prose, fences, or double encoding
 *   2. validate   — check the keys the caller actually requires
 *   3. repair     — if the document was cut off, close it and re-validate
 *   4. retry      — ask again, told specifically what was wrong last time
 *
 * The rungs are ordered by cost. Extraction and repair are free; a retry is a
 * whole model call. A truncated reply is repaired before it is re-asked,
 * because re-asking a model that hit its output ceiling reproduces the same
 * truncation — that was b98's retry ladder, three identical failures and
 * twelve minutes for no plan.
 *
 * WHAT HAPPENS AT THE END is the part that matters. See `onExhaustion`.
 */
import { type JsonValidationOptions } from "./json.js";
/** One model call. The ladder supplies the correction; the backend makes the call. */
export type StructuredAttempt = (correction: string | null) => Promise<{
    raw: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    sessionId: string;
    /** True when the backend knows the reply was cut off at the output ceiling. */
    truncated?: boolean;
}>;
export interface LadderAttempt {
    outcome: "ok" | "invalid_json" | "truncated" | "repaired" | "call_failed";
    detail?: string;
    costUsd: number;
}
export interface LadderResult<T> {
    parsed: T;
    raw: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    sessionId: string;
    attempts: LadderAttempt[];
    /** True when the document came back from `repairTruncatedJson`, so it is INCOMPLETE-but-valid. */
    repaired: boolean;
}
/**
 * Thrown when every rung has been tried.
 *
 * Carries the attempt trail so a caller can report what it cost and what went
 * wrong at each step, rather than surfacing only the final message. b128's
 * lesson: a recovered truncation that left no trace is a mechanism nobody can
 * tell is working.
 */
export interface LadderExhaustedError extends Error {
    attempts: LadderAttempt[];
    costUsd: number;
    lastRaw: string;
    role: string;
}
export interface LadderOptions<T> {
    /** Which role is asking, for messages and audit. */
    role: string;
    validation: JsonValidationOptions<T>;
    attempt: StructuredAttempt;
    /** Total model calls, including the first. Default 3. */
    maxAttempts?: number;
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
}
/**
 * Run the ladder. Resolves with a validated document, or throws
 * `LadderExhaustedError`.
 *
 * It THROWS rather than returning a degraded default, deliberately. A default
 * that means "this went wrong" has to travel through the caller as data, and
 * every caller then has to remember to check it — which is precisely how a
 * failed review becomes an approval. A throw cannot be forgotten. What the
 * caller must do with it is `onExhaustion`, below.
 */
export declare function runStructuredLadder<T>(opts: LadderOptions<T>): Promise<LadderResult<T>>;
/**
 * The direction each role fails in, when no valid document could be obtained.
 *
 * `review` — the run continues, but the result is treated as "a human must
 *   look at this". Never as approval.
 * `fail_run` — the run stops. Nothing ships.
 *
 * The adversary is the case this exists for. Its failure mode is not that it
 * returns nothing; it is that "the reviewer could not be reached" and "the
 * reviewer found no problems" have the same shape at the call site, and a
 * `pass`-shaped default silently converts an outage into an approval. So there
 * is no route from ladder exhaustion to `pass`, for any role, under any
 * configuration.
 */
export type ExhaustionPolicy = "review" | "fail_run";
export declare const ROLE_EXHAUSTION_POLICY: Readonly<Record<string, ExhaustionPolicy>>;
/**
 * The verdict a role reports when its ladder is exhausted.
 *
 * Exported so a test can assert the property directly: for every role, and
 * every policy, the answer is never `pass`.
 */
export declare function exhaustionVerdict(role: string): {
    verdict: "revise" | "block";
    policy: ExhaustionPolicy;
    why: string;
};
//# sourceMappingURL=structured.d.ts.map