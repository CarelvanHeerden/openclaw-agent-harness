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
 *
 * v2.0.0: this file is now the ONLY one in `src/` that touches
 * `@anthropic-ai/claude-agent-sdk`, and a test enforces that. Everything that
 * was never really about the SDK -- JSON extraction, cost arithmetic, diff
 * chunking, stream-liveness, env filtering -- moved to `shared/`, where the ACP
 * backend uses the same code rather than a second copy that drifts. What stayed
 * is what is genuinely Claude Code's: the truncation ladder,
 * `messageIndicatesTruncation`, the `canUseTool` adaptation, the SDK message
 * stream, and the Anthropic Models API lookup.
 */
import type { ClassifierResult, CrystallisedBrief, OkfConceptRef } from "../crystallise/prompt-refiner.js";
import type { LeadPlan, LeadPlanSubTask, WorkerContext } from "../orchestrator/lead.js";
import type { ReviewReport } from "../orchestrator/adversary.js";
import { type LeadAttemptInfo } from "./shared/json.js";
import { type BackendCapabilities, type CapabilityTier } from "./backend.js";
export { describeJsonSyntaxFault, extractAndValidateJson, extractJson, repairTruncatedJson, type JsonValidationOptions, type LeadAttemptInfo, type StructuredCallError, } from "./shared/json.js";
export { splitDiffOnFileBoundaries } from "./shared/diff.js";
export { evaluateStreamSlowTick } from "./shared/stream.js";
export { PRICES, assessModelPricingHealth, checkPriceDrift, estimateSubTaskCost, isUnknownModel, mostExpensivePrice, } from "./shared/pricing.js";
/**
 * Build the `env` passed to the SDK subprocess.
 *
 * The embedded Claude Code binary reads ANTHROPIC_API_KEY from its process
 * environment. We inherit the parent env and, when the harness has resolved
 * an explicit key (vault or config env-var), set ANTHROPIC_API_KEY so the
 * subprocess never falls back to the interactive `/login` session store
 * (which does not exist in a headless container).
 *
 * Returns `undefined` when no explicit key is supplied, so the SDK keeps its
 * default behaviour (inherit parent env) for local dev where the developer
 * may already be logged in.
 */
/**
 * beta.110: allow bootstrap to deny an operator-renamed secret env var (e.g. a
 * custom `credentials.key_env`).
 *
 * v2.0.0: the denylist itself now lives in `shared/env.ts` because the ACP
 * backend spawns a subprocess too and must be filtered by the same list. Kept
 * under its old name so bootstrap's call site is unchanged.
 */
export declare function registerDeniedSdkEnvVar(name: string): void;
/**
 * beta.99 (P0-4): default output-token ceiling exported to the SDK subprocess.
 * Fable 5 / Sonnet 5 / Opus 4.7 / Opus 4.8 all advertise
 * `max_output_tokens: { default: 64000, upper: 128000 }`. We pin the default
 * rather than the upper bound: 64k is ample for a plan, and a ceiling that is
 * merely LARGE does not fix a plan that is unboundedly large (that is what the
 * bounded top-up and the compaction retry are for).
 */
export declare const DEFAULT_SDK_MAX_OUTPUT_TOKENS = 64000;
/**
 * beta.99 (P0-7): default stream-open watchdog window for structured calls.
 * Matches the worker path's phase-1 default. A healthy call opens its stream in
 * seconds; 120s is slack for a cold subprocess spawn, not for model thinking
 * time (which happens AFTER the stream is open and is bounded separately).
 */
export declare const DEFAULT_STREAM_OPEN_TIMEOUT_SECONDS = 120;
export declare function buildSdkEnv(apiKey?: string, maxOutputTokens?: number): Record<string, string> | undefined;
/**
 * beta.99 (P0-5): did THIS SDK message indicate the model was cut off at the
 * output ceiling?
 *
 * b97's Fix #8 read `stop_reason` from the `result` event ONLY. That event
 * reports how the SESSION ended, which is `end_turn`/`success` even when an
 * assistant turn inside it was truncated -- so the `[truncated:max_tokens]`
 * annotation never fired, the compaction retry it gates was dead code, and
 * every truncation fell through to the beta.81 prose-drift retry, which
 * re-truncates identically. That is the b98 retry ladder: 3 calls, 3 identical
 * truncations, ~12 minutes, no plan.
 *
 * Truncation surfaces in three places, so we check all three:
 *   1. `assistant.error === "max_output_tokens"` -- the SDK's own dedicated
 *      signal (see SDKAssistantMessageError in sdk.d.ts).
 *   2. `assistant.message.stop_reason === "max_tokens"` -- the raw API stop
 *      reason for that turn.
 *   3. `result.stop_reason === "max_tokens"`, plus the
 *      `error_max_structured_output_retries` subtype (b97's original check).
 */
export declare function messageIndicatesTruncation(message: unknown): boolean;
/**
 * beta.126: test seam for the retry ladder.
 *
 * Every rung of the b81/b97/b99 lead ladder was individually correct on b125
 * and the run still died, because the signal that chooses between the rungs was
 * wrong. That is a wiring failure, and a wiring failure is only visible to a
 * test that drives the whole ladder. Nothing below `runLeadSdk` could be
 * exercised without a real subprocess and a real API key, so nothing was.
 *
 * Replaces the cached SDK module and returns a restore function. Production
 * never calls this; `loadSdk` behaves exactly as before when it is unused.
 */
export declare function __setSdkForTests(fake: unknown): () => void;
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
    /**
     * beta.90 (Feature 2): STREAM-SLOW liveness callback + threshold. When the
     * worker SDK stream opens then goes idle (no token/activity delta) for
     * `streamIdleWarnSeconds`, onStreamSlow is invoked. OBSERVABILITY ONLY (never
     * aborts). Threaded straight through to consumeWorkerStream.
     */
    onStreamSlow?: (info: {
        idleMs: number;
        elapsedMs: number;
        tokensOut: number;
        label: string;
    }) => void;
    /** beta.90: idle-warn threshold (seconds). Default 90; <=0 disables. */
    streamIdleWarnSeconds?: number;
    /** beta.90: optional logger for the periodic stream tick. */
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
    /** beta.99 (P0-4): output-token ceiling for the SDK subprocess. See buildSdkEnv. */
    maxOutputTokens?: number;
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
     * beta.104: every assistant text block joined in order. Populated ONLY when
     * the caller passes `accumulateAllText` (the lead scout); undefined
     * otherwise, so the worker path carries no extra retained text.
     */
    allText?: string;
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
    /**
     * beta.90 (Feature 2): STREAM-SLOW liveness callback. When the worker SDK
     * stream opens but then goes IDLE (no token/activity delta) for
     * `streamIdleWarnSeconds`, this is invoked so the caller can surface a
     * `worker_stream_slow` audit + bump the session liveness heartbeat.
     * OBSERVABILITY ONLY -- it never aborts (a slow stream recovered on b89;
     * a blunt abort would have wrongly killed it). Best-effort; may fire more
     * than once while idle (once per tick past the threshold).
     */
    onStreamSlow?: (info: {
        idleMs: number;
        elapsedMs: number;
        tokensOut: number;
        label: string;
    }) => void;
    /**
     * beta.104: also return EVERY assistant text block joined, not just the
     * last one. Needed by the lead scout, whose whole deliverable is a long
     * prose report the SDK may emit across several messages. Off by default:
     * the worker path deliberately wants the concluding message alone.
     */
    accumulateAllText?: boolean;
    /**
     * beta.106: called with each assistant text block as it arrives (only when
     * `accumulateAllText` is set). Lets a caller that gives up waiting still
     * salvage the prose produced so far. Best-effort; never throws into the
     * stream loop.
     */
    onText?: (text: string) => void;
    /**
     * beta.90 (Feature 2): idle-warn threshold in SECONDS. Default 90; <=0
     * disables the stream-slow detector entirely. The detector re-uses the
     * existing 30s tick cadence (it only fires onStreamSlow once idleMs crosses
     * this threshold), so the effective granularity is one tick (30s).
     */
    streamIdleWarnSeconds?: number;
    /** beta.90: label for the stream-slow info (e.g. "worker"); default "worker". */
    streamSlowLabel?: string;
    /** beta.90: optional logger for the periodic tick (mirrors structuredCall). */
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
}): Promise<Omit<RunWorkerResult, never>>;
export declare function runWorkerSdk(params: RunWorkerParams): Promise<RunWorkerResult>;
/**
 * beta.104: THE LEAD'S ONE LOOK AT THE REPOSITORY.
 *
 * Runs BEFORE the toolless planning call, in a real worktree, with read-only
 * tools. Returns free-form prose that the planning call then receives as input.
 *
 * Why this is a separate call rather than tools on the planning call: b28/b40
 * record the planner, when given tools, wandering off and writing its plan to a
 * FILE instead of returning JSON. `structuredCall`'s toolless shape is what
 * fixed that, and it stays untouched -- this call has no JSON contract to drift
 * away from, and the planning call has no tools to wander with.
 *
 * Read-only is enforced twice: an allow-list (`tools`, the authoritative switch
 * per sdk.d.ts) and a deny-list, plus a `canUseTool` gate that refuses anything
 * off the allow-list even if the SDK's own filtering changes shape. The scout
 * must not be able to touch the worktree the run is about to build in.
 */
export declare function runLeadScoutSdk(params: {
    model: string;
    worktreePath: string;
    systemPrompt: string;
    userMessage: string;
    timeoutSeconds: number;
    apiKey?: string;
    maxOutputTokens?: number;
    allowedTools: readonly string[];
    deniedTools: readonly string[];
    /**
     * beta.106: hard ceiling on scout agent turns. The b105 smoke's scout ran 14
     * minutes against a 600s budget; a wall-clock abort cannot interrupt a tool
     * call already in flight, so the SDK's own turn cap is the bound that
     * actually holds. See lead-scout.ts SCOUT_MAX_TURNS.
     */
    maxTurns?: number;
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
}): Promise<{
    report: string;
    sdkSessionId: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    stopReason: string;
    timedOut?: boolean;
}>;
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
    /**
     * beta.80 (F1): when true (default), the crystalliser is told the harness is
     * a REPO tool -- reframe live-external-API side-effect ACs into "build the
     * code + a test", never "perform the call". Off restores the pre-beta.80
     * prompt.
     */
    repoOnlyInvariant?: boolean;
    /**
     * beta.80 (F2): when true (default), the crystalliser is told to SELF-REPORT
     * competing readings (interpretations) and, when >=2 buildable readings
     * exist, populate clarificationNeeded instead of guessing one.
     */
    bimodalClarify?: boolean;
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
    /** beta.67 (P0a): corrective note for the ONE bounded workerContext re-ask. */
    correctiveNote?: string;
    /**
     * beta.81 (Track C): when true (default), retry the lead plan call ONCE on an
     * extractJson/validation failure (prose-drift). Threaded from
     * loop.lead_json_retry_enabled. Set false to disable.
     */
    jsonRetryEnabled?: boolean;
    /** beta.99 (P0-4): output-token ceiling for the SDK subprocess. */
    maxOutputTokens?: number;
    /**
     * beta.99 (P0-6): when both attempts are truncated, salvage the well-formed
     * prefix instead of failing the plan. Default true; set false to restore the
     * pre-beta.99 hard-fail.
     */
    leadSalvageEnabled?: boolean;
    /**
     * beta.128: when true (default), a COMPLETE plan that fails JSON.parse buys
     * one more call with the parse error quoted back. Distinct from
     * `jsonRetryEnabled` (prose drift) and from the truncation rung. Threaded
     * from loop.lead_syntax_retry_enabled.
     */
    leadSyntaxRetryEnabled?: boolean;
    /**
     * beta.128: called once per lead attempt, win or lose.
     *
     * WHY: two things were invisible without it. A truncation that RECOVERED left
     * no audit trail at all -- the smoke report read the terminal failure and
     * printed "truncation detected: no" about a run whose logs said the opposite,
     * which is the confidently-wrong verdict class. And an attempt that failed
     * was billed to nobody, so a planning failure that burned two Opus calls
     * reported $0.00. Both are answered by telling the caller what happened on
     * each attempt, at the moment it happens, rather than inferring it from
     * whatever the last error looked like.
     */
    onAttempt?: (info: LeadAttemptInfo) => void;
    /**
     * v2.0.0: how capable the WORKER model is declared to be, which is what the
     * sizing instruction below is really calibrating against. Defaults to
     * `strong`, which reproduces v1's sentence in backend-neutral wording.
     */
    workerTier?: CapabilityTier;
}): Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd"> & {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
}>;
/**
 * beta.67 (P0b): FABLE-IN-THE-LOOP revise-spec turn. Reads the adversary
 * findings + current plan, RE-INVESTIGATES, and returns the SAME sub-tasks
 * (same seqs) with each affected mutate/mixed sub-task's workerContext
 * REFRESHED to a resolved changeSpec. Fed to cycle-2 workers via the beta.66
 * warm-context render path -- workers never see the raw findings. HARD
 * BOUNDARY: reads the adversary OUTPUT only; nothing flows back INTO it.
 */
export declare function runLeadReviseSpecSdk(params: {
    model: string;
    brief: CrystallisedBrief;
    subTasks: LeadPlanSubTask[];
    review: ReviewReport;
    timeoutSeconds: number;
    apiKey?: string;
    /**
     * beta.99 (P0-4): output-token ceiling. This turn re-emits the FULL sub-task
     * list with refreshed workerContext, so it has the same size profile -- and
     * the same truncation exposure -- as the initial plan call.
     */
    maxOutputTokens?: number;
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
}): Promise<{
    subTasks: LeadPlanSubTask[];
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
}>;
/**
 * beta.99 (P0-2): BOUNDED workerContext top-up.
 *
 * The beta.67 gate used to re-ask for the WHOLE plan whenever any mutate
 * sub-task had thin `workerContext`. That reply has to restate every sub-task
 * AND add the extra prose, so its size grows with the plan -- and on b98
 * (session f2613eec) it breached the output ceiling three times running and
 * took the run down with it, discarding a plan that was already valid.
 *
 * This asks for ONLY the `workerContext` blocks of the named seqs. Output size
 * is bounded by how many are missing, the validated plan is never re-emitted
 * (so it cannot be corrupted or lost), and the reply is small enough that
 * truncation is not a realistic failure mode.
 */
export declare function runLeadWorkerContextSdk(params: {
    model: string;
    brief: CrystallisedBrief;
    subTasks: LeadPlanSubTask[];
    missingSeqs: number[];
    timeoutSeconds: number;
    apiKey?: string;
    maxOutputTokens?: number;
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
}): Promise<Array<{
    seq: number;
    workerContext: WorkerContext;
}>>;
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
 * What this backend can do.
 *
 * Every entry is `true` because the Claude Agent SDK supports all of it, and
 * because v1 was built assuming exactly this — which is the point of writing it
 * down. The declaration is not interesting until a second backend fills the
 * same shape and some of the answers are `false`. Then the harness can refuse a
 * pairing at startup instead of discovering it mid-run, and this row is the
 * baseline the other is compared against.
 */
export declare const CLAUDE_CODE_CAPABILITIES: BackendCapabilities;
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
//# sourceMappingURL=claude-code.d.ts.map