/**
 * Durable, structured, append-only INTERACTION LOG (beta.63, Part B).
 *
 * WHY THIS EXISTS
 * ---------------
 * The b60 record-depth run silently stalled ~2 days near completion with no
 * terminal verdict, and it was UNDIAGNOSABLE because:
 *   - the harness `state.db` (plan JSON, sub-task shapes, audit_log) lives
 *     INSIDE the ephemeral git worktree that gets released at teardown, so a
 *     released/restarted worktree takes the history with it;
 *   - the piped stdout (`okf-test.log`) does NOT capture DB audit events and
 *     freezes/detaches on restart;
 *   - the SDK/LLM interactions (lead planner, worker, adversary) are separate
 *     Claude Agent SDK calls whose inputs/outputs/costs/timing are NOT durably
 *     captured anywhere an operator can read after the fact.
 *
 * THE FIX
 * -------
 * A dedicated, append-only, structured JSONL log written OUTSIDE the worktree
 * in the harness data dir (`<dataDir>/logs`). One file per session
 * (`session-<id>.jsonl`) that survives worktree release AND container restart
 * (if the data dir is on a persisted volume), plus a rolling global tail
 * (`harness-interactions.jsonl`) for a cross-session view.
 *
 * SECRET REDACTION on write is MANDATORY and NOT disableable — every string
 * value in every payload is scrubbed through {@link redactSecrets} before it
 * touches disk. `log.full_prompts` only controls whether we persist full
 * prompt text (default false = sizes + tails only); it NEVER disables
 * redaction.
 *
 * A stalled run leaves a complete trail: a last `sdk_request` with no matching
 * `sdk_response` is the exact hang point; frozen phase + last event ts is the
 * stall boundary.
 */
/** The phase classification carried on every interaction-log event. */
export type InteractionPhase = "classify" | "plan" | "worker" | "review" | "finalize" | "watchdog" | "unknown";
/** The role of an SDK/LLM call. */
export type SdkRole = "lead" | "worker" | "adversary" | "classifier" | "crystalliser";
/**
 * One structured event. `event` is the discriminator. Everything else is a
 * free-form bag that gets redacted + serialised. `ts` and `sessionId` are
 * always stamped by the logger, not the caller.
 */
export interface InteractionEvent {
    event: string;
    phase?: InteractionPhase;
    seq?: number;
    cycle?: number;
    [k: string]: unknown;
}
export interface InteractionLogConfig {
    enabled: boolean;
    dir: string;
    fullPrompts: boolean;
    retentionDays: number;
}
export interface InteractionLogDeps {
    config: InteractionLogConfig;
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
    /** Injectable clock for deterministic tests. */
    now?: () => number;
}
/** Max chars of a prompt tail we keep when full_prompts is off. */
export declare const PROMPT_TAIL_CHARS = 2000;
/**
 * Deep-redact every string leaf in an arbitrary JSON-ish value. Reuses the
 * exec/git redaction discipline (userinfo-in-URL + exact-token scrubbing) and
 * additionally scrubs common standalone credential token shapes
 * (Anthropic `sk-ant-...`, GitHub `ghp_`/`gho_`/`ghs_`/`github_pat_...`,
 * generic bearer tokens). MANDATORY on every write — there is no off switch.
 */
export declare function redactValue(value: unknown): unknown;
/**
 * Scrub standalone secret token shapes that {@link redactSecrets} (which only
 * knows about URL userinfo + a KNOWN token value) cannot catch when the raw
 * token appears bare in a prompt/log line.
 */
export declare function redactTokenShapes(text: string): string;
/**
 * Truncate a prompt to a tail (last N chars) unless full_prompts is on. Always
 * returns the character count separately so a stall's prompt SIZE is durable
 * even when the body is not.
 */
export declare function summarisePrompt(prompt: string, fullPrompts: boolean): {
    promptChars: number;
    promptTail: string;
    promptFull?: string;
};
/**
 * The interaction logger. Construct one per runtime; call {@link log} on the
 * hot path. All writes are synchronous appends (JSONL) so a crash mid-run
 * still leaves a complete, parseable trail up to the last flushed line.
 */
export declare class InteractionLog {
    private readonly cfg;
    private readonly logger?;
    private readonly nowFn;
    private dirEnsured;
    constructor(deps: InteractionLogDeps);
    get enabled(): boolean;
    get dir(): string;
    get fullPrompts(): boolean;
    private ensureDir;
    private sessionFile;
    private globalFile;
    /**
     * Append one structured event for a session. Never throws — a logging
     * failure must not crash a live run. Redaction is applied UNCONDITIONALLY.
     */
    log(sessionId: string, event: InteractionEvent): void;
    /**
     * Convenience: log an `sdk_request`. Applies the full_prompts gate to the
     * prompt body (size + tail always retained). Redaction still applies on write.
     */
    logSdkRequest(sessionId: string, params: {
        role: SdkRole;
        model: string;
        prompt: string;
        phase?: InteractionPhase;
        seq?: number;
        cycle?: number;
        toolsAllowed?: string[];
        sdkSessionId?: string;
    }): void;
    /** Convenience: log an `sdk_response`. */
    logSdkResponse(sessionId: string, params: {
        role: SdkRole;
        model: string;
        phase?: InteractionPhase;
        seq?: number;
        cycle?: number;
        finishReason?: string;
        outputChars?: number;
        costUsd?: number;
        durationMs?: number;
        toolCalls?: string[];
        sdkSessionId?: string;
        finalMessageTail?: string;
    }): void;
    /**
     * Read the tail of a session's JSONL as parsed events (newest last). Used by
     * the `harness_logs` tool so operators can read the trail without shell /
     * container access. Returns `{ found:false }` when the file does not exist.
     */
    readSessionTail(sessionId: string, limit?: number): {
        found: boolean;
        file: string;
        events: Array<Record<string, unknown>>;
        totalLines: number;
    };
    /**
     * Prune session log files older than `retention_days`. The rolling global
     * tail is never deleted (it is the cross-session index) but is left to grow
     * bounded by the operator's disk; per-session files are the bulk. Returns the
     * number of files removed. Never throws.
     */
    prune(now?: number): {
        removed: number;
        kept: number;
    };
}
/**
 * Derive the interaction-log config from the harness `log` block + the data
 * dir (dirname of the state db). Centralised so both the runtime and tests
 * resolve the same `<dataDir>/logs` default.
 */
export declare function resolveInteractionLogConfig(logBlock: {
    interaction_log_enabled?: boolean;
    dir?: string;
    full_prompts?: boolean;
    retention_days?: number;
} | undefined, dataDir: string): InteractionLogConfig;
//# sourceMappingURL=interaction-log.d.ts.map