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
import type { ClassifierResult, CrystallisedBrief, OkfConceptRef } from "../crystallise/prompt-refiner.js";
import type { LeadPlan } from "../orchestrator/fable5-lead.js";
export declare function buildSdkEnv(apiKey?: string): Record<string, string> | undefined;
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
    /** Anthropic API key. Injected into the SDK subprocess env as ANTHROPIC_API_KEY so it never falls back to `/login`. */
    apiKey?: string;
    /**
     * beta.64 (P0-1) / beta.65 (P0): PHASE-2 watchdog window (seconds). A SEPARATE
     * timer from `timeoutSeconds`, armed when the SDK stream OPENS (system/init)
     * and disarmed on the first assistant content block (text/tool_use). No first
     * content block within this window => abort with the DISTINCT stopReason
     * `first_token_timeout` so the caller RETRIES on a fresh session. This is the
     * beta.63 smoke #2 case beta.64 already covered. beta.65 lowered the loop
     * default 90 -> 30 (phase 2 is always <10ms on success). Undefined/<=0
     * disables the phase-2 watchdog. Default supplied by the loop (30s).
     */
    firstTokenTimeoutSeconds?: number;
    /**
     * beta.65 (P0): PHASE-1 watchdog window (seconds). A SEPARATE timer from
     * `timeoutSeconds`, armed from CALL INITIATION (the moment consumeWorkerStream
     * begins, BEFORE the stream is even opened) and disarmed when the stream opens
     * (system/init). If the stream NEVER opens within this window, the call is
     * aborted with the same DISTINCT stopReason `first_token_timeout`.
     *
     * This closes the beta.64 gap: beta.64 armed the first-token watchdog only on
     * stream-open, so a PRE-STREAM POST hang (the SDK streaming POST never returns
     * its first byte -- smoke #3: 28+min silence, no sdk_stream_opened, no abort)
     * was NEVER covered and sat for the full `worker_timeout_seconds` (1800s).
     * Phase 1 is highly variable even on SUCCESS (smoke #3: 47s / 422s-succeeded /
     * >1800s-hung), so a legit-but-slow open WILL breach this window -- CORRECT:
     * the abort routes into the SAME first_token_timeout -> one-fresh-session
     * retry path (a cold/unpooled open is fast on retry). Undefined/<=0 disables
     * the phase-1 watchdog. Default supplied by the loop (120s).
     */
    streamOpenTimeoutSeconds?: number;
}
export interface RunWorkerResult {
    sdkSessionId: string;
    stopReason: "end_turn" | "max_tokens" | "tool_error" | "timeout" | "canceled" | "first_token_timeout";
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    logsExcerpt: string;
    /**
     * beta.48 (C1 observability): the worker's LAST assistant text message.
     * Captured on every turn so a zero-side-effect `end_turn` (e.g. a reasoned
     * refusal like session dca2f3b5's) is never opaque to the harness. Empty
     * string when the worker produced no text (pure tool turn).
     */
    finalMessage: string;
    /**
     * beta.64 (P0-1): true once the SDK stream opened (a system/init message
     * carrying session_id arrived). Lets the caller distinguish "the POST hung
     * before the stream ever opened" (streamOpened=false) from "the stream
     * opened but no tokens were produced" (streamOpened=true, msToFirstToken
     * undefined) -- the two failure modes beta.63 smoke #2 could not tell apart.
     */
    streamOpened: boolean;
    /**
     * beta.64 (P0-1) / beta.65 (P0): ms from CALL INITIATION (the top of
     * consumeWorkerStream) to the FIRST assistant content block (text or
     * tool_use) -- i.e. spanning BOTH phase 1 (call-init -> stream-open) and
     * phase 2 (stream-open -> first-token). beta.64 measured only phase 2 (from
     * stream open); beta.65 measures from call initiation so the value stays
     * meaningful even when the pre-stream POST is what hung. Undefined when no
     * first token ever arrived (the first_token_timeout hang).
     */
    msToFirstToken?: number;
}
/**
 * beta.64 (P0-1) / beta.65 (P0): consume a worker SDK message stream, applying
 * a SPLIT-PHASE watchdog. Extracted from {@link runWorkerSdk} as an exported
 * pure-ish helper so the watchdog is directly testable with a fake
 * async-iterable (no real SDK).
 *
 * `stream` is any async-iterable of SDK messages. `abort` is the shared
 * AbortController the caller passes to the SDK (so aborting here cancels the
 * real stream).
 *
 * beta.65 SPLIT-PHASE design (from live smoke #3 durable-log evidence: the hang
 * has two distinct phases, and phase 1 is highly variable even on SUCCESS, so a
 * single call-initiation timer would false-positive-abort a legit slow open):
 *   - PHASE 1 (call-init -> stream-open): a timer ARMED AT CALL INITIATION (the
 *     top of this function, BEFORE the `for await` yields anything), disarmed
 *     when the stream opens (system/init). Bound by `streamOpenTimeoutSeconds`.
 *     This is the beta.64 gap -- a PRE-STREAM POST hang (system/init NEVER
 *     arrives; smoke #3) that beta.64's stream-open-armed watchdog never saw.
 *   - PHASE 2 (stream-open -> first-token): a timer ARMED on system/init and
 *     disarmed on the first assistant content block (text/tool_use). Bound by
 *     `firstTokenTimeoutSeconds`. This is the beta.63 smoke #2 case beta.64
 *     already covered -- preserved unchanged.
 *
 * EITHER timer firing => `abort.abort()` + the returned stopReason is the SAME
 * DISTINCT `first_token_timeout`, so both route into the caller's existing
 * fresh-session retry path. A phase-1 breach of a legit-but-slow open is thus a
 * benign abort-and-retry-fresh, never a terminal fail on first breach.
 * `now` is injectable for deterministic tests.
 */
export declare function consumeWorkerStream(stream: AsyncIterable<any>, abort: AbortController, opts: {
    firstTokenTimeoutSeconds?: number;
    streamOpenTimeoutSeconds?: number;
    now?: () => number;
}): Promise<Omit<RunWorkerResult, never>>;
export declare function runWorkerSdk(params: RunWorkerParams): Promise<RunWorkerResult>;
/**
 * Extract the JSON contract from a model's raw output.
 *
 * beta.31: the lead planner (session 78237f43) failed with
 *   `[lead] JSON.parse failed: SyntaxError: Unexpected token '\', "\n{\n \"r\"..."`
 * The model wrapped its plan as a JSON-STRING-ENCODED payload (as if writing
 * it to a file): the ```json fence content was the escaped string
 * `\n{\n \"repo\": ...` rather than raw JSON. The old code grabbed the first
 * fence blindly and returned the escaped text, which JSON.parse rejects on
 * the leading `\`.
 *
 * New strategy: gather CANDIDATES (all fenced blocks + the first balanced
 * brace-scan of the whole text + a JSON-string-unescape of each candidate)
 * and return the FIRST candidate that actually parses. This tolerates:
 *   - raw JSON,
 *   - ```json fenced JSON,
 *   - double-encoded (JSON-string-escaped) JSON, incl. inside a fence,
 *   - JSON preceded/followed by prose.
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
    apiKey?: string;
}): Promise<ClassifierResult & {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
}>;
export declare function runCrystalliserSdk(params: {
    model: string;
    userText: string;
    timeoutSeconds: number;
    apiKey?: string;
    /**
     * beta.21: optional OKF concepts pre-attached by the caller. When
     * present, they are formatted into the system prompt so the crystalliser
     * can reference them by id when building the brief. Populated end-to-end
     * only when the OpenClaw agent surfaced OKF blocks in its own context
     * and forwarded them to `harness_run`; empty otherwise (behaviour is
     * identical to pre-beta.21).
     */
    concepts?: OkfConceptRef[];
}): Promise<CrystallisedBrief & {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
}>;
/**
 * beta.21: render supplied OKF concepts into a block the crystalliser can
 * reference. Keeps summaries short and omits `content` (large; that's for
 * the worker, not the crystalliser). Returns empty string when no concepts
 * are supplied, so the .filter() at the callsite drops the block cleanly.
 */
export declare function formatConceptBlockForCrystalliser(concepts?: OkfConceptRef[]): string;
export declare function runLeadSdk(params: {
    model: string;
    brief: CrystallisedBrief;
    reposAllowed: string[];
    timeoutSeconds: number;
    apiKey?: string;
    /** Optional logger; enables the periodic `[lead] tick +30s` progress log. */
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
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
    apiKey?: string;
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
/**
 * beta.61: the price used when a model id is NOT in the table (and not
 * overridden). Previously this silently fell back to sonnet -- which
 * UNDER-estimates for a more expensive model and lets a run overshoot its
 * budget (exactly the b60 opus-priced-as-sonnet miss). A budget projection
 * must FAIL SAFE: an unknown model is assumed to be the MOST EXPENSIVE known
 * tier, so we over-reserve rather than under-reserve. Combined with the
 * checkPriceDrift unknown-model warning, an operator sees the mispricing on
 * run 1 and can add an exact price_override.
 */
export declare function mostExpensivePrice(table: Record<string, {
    input: number;
    output: number;
}>): {
    input: number;
    output: number;
};
/** beta.61: true when a model id has neither a table entry nor an override. */
export declare function isUnknownModel(model: string, overrides?: Record<string, {
    input: number;
    output: number;
}>): boolean;
/**
 * beta.61: fetch the list of live model ids from the Anthropic Models API
 * (GET /v1/models). IMPORTANT LIMITATION: Anthropic exposes NO pricing API --
 * /v1/models returns model IDs and display names only, NOT per-token prices
 * (pricing lives in the docs, not the API). So this canNOT auto-refresh the
 * PRICES table with real numbers; it can only tell us WHICH model ids exist,
 * so the harness can warn when a configured model is (a) not in our price
 * table and (b) either a real live model we simply haven't priced, or a
 * renamed/deprecated id. Best-effort: any network/auth error returns null and
 * the caller degrades to the static table. Never throws.
 */
export declare function fetchLiveModelIds(apiKey: string, opts?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<string[] | null>;
/**
 * beta.61: assess pricing health of the CONFIGURED models. Returns per-model
 * flags: `unpriced` (not in the price table/overrides -> projections fall back
 * to the most-expensive tier), and `notLive` (a live model list was fetched and
 * this id was absent -> possibly renamed/deprecated). `liveIds` null means the
 * Models API was unreachable, so `notLive` is left undefined (unknown, not
 * false). Pure/deterministic given inputs -- no network here (fetch is done by
 * fetchLiveModelIds and passed in) so it is unit-testable.
 */
export declare function assessModelPricingHealth(configuredModels: string[], liveIds: string[] | null, overrides?: Record<string, {
    input: number;
    output: number;
}>): Array<{
    model: string;
    unpriced: boolean;
    notLive?: boolean;
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
    unknownModel?: boolean;
};
//# sourceMappingURL=claude-sdk.d.ts.map