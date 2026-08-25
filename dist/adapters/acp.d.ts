import type { AcpToolCallForGuard } from "../safety/bash-guard.js";
import type { JsonValidationOptions } from "./shared/json.js";
import type { BackendCapabilities } from "./backend.js";
/** The harness-side stop reasons the worker contract expects. */
export type WorkerStopReason = "end_turn" | "max_tokens" | "tool_error" | "timeout" | "canceled" | "first_token_timeout";
/**
 * The `usage` object on a `session/prompt` result.
 *
 * Every field optional, and the cache fields spelled several ways, because
 * agents disagree: the captured OpenCode sessions use `cachedWriteTokens`,
 * while other implementations use `cacheReadTokens`/`cacheWriteTokens`. Reading
 * all of them is cheaper than being wrong about which one arrived.
 */
export interface AcpPromptUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedWriteTokens?: number;
    cachedReadTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
export interface AcpAgentSpec {
    /** Executable to launch, e.g. "npx" or an absolute path to a baked-in binary. */
    command: string;
    args: string[];
    /** Extra environment for the child, merged over the inherited env. */
    env?: Record<string, string>;
}
export interface RunWorkerAcpParams {
    agent: AcpAgentSpec;
    worktreePath: string;
    systemPrompt: string;
    userMessage: string;
    model: string;
    resumeSessionId?: string;
    timeoutSeconds: number;
    streamOpenTimeoutSeconds?: number;
    firstTokenTimeoutSeconds?: number;
    streamIdleWarnSeconds?: number;
    onStreamSlow?: (info: {
        idleMs: number;
        elapsedMs: number;
        tokensOut: number;
        label: string;
    }) => void;
    /**
     * REQUIRED, and deliberately not the SDK-shaped `canUseTool` from
     * WorkerDeps. That callback keys on Claude Code tool names and would fall
     * through to allow for every ACP call. Taking an ACP-shaped guard as a
     * required parameter makes the unsafe wiring impossible to express.
     * Build it with `buildAcpGuard()`.
     */
    acpGuard: (call: AcpToolCallForGuard) => Promise<{
        allow: boolean;
        reason?: string;
    }>;
    /** Redacted from logs and error text when present. */
    secretToken?: string;
    logger?: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
}
export interface RunWorkerAcpResult {
    sdkSessionId: string;
    stopReason: WorkerStopReason;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    logsExcerpt: string;
    finalMessage: string;
    streamOpened: boolean;
    msToFirstToken?: number;
    /** Cache tokens, when the agent reported a split. Priced separately in M8. */
    tokensCached?: number;
    /**
     * How to read costUsd / tokensIn / tokensOut.
     *
     * "acp-delta"    — costUsd is a real delta of the agent's cumulative figure.
     * "tokens-only"  — a token split arrived but no cost, which is what a local
     *                  or self-hosted provider looks like: there is no invoice,
     *                  so `costUsd: 0` is TRUE rather than unknown, and the
     *                  tokens are the usage signal.
     * "unavailable"  — the agent reported neither. The ledger has a hole here and
     *                  must say so rather than record a measured zero.
     */
    usageSource: "acp-delta" | "tokens-only" | "unavailable";
    /** Context-window occupancy, the only token signal ACP actually carries. */
    contextUsed?: number;
    contextSize?: number;
    /** Denials the guard issued this turn. Surfaced for the audit trail. */
    deniedToolCalls: Array<{
        kind?: string | null;
        reason?: string;
    }>;
}
/**
 * Runs one worker turn against an ACP backend.
 *
 * Watchdogs stay harness-side, exactly as they do for the SDK path: ACP has no
 * notion of "the stream failed to open", so phase-1 (launch -> first update),
 * phase-2 (first update -> first token) and the overall turn timeout are all
 * enforced here by aborting the child.
 */
export declare function runWorkerAcp(params: RunWorkerAcpParams): Promise<RunWorkerAcpResult>;
/**
 * How to read the usage numbers on a result.
 *
 * Three states, because the two signals arrive independently: a hosted provider
 * sends both cost and tokens, a local endpoint sends tokens but has no invoice
 * to report, and an agent that sends neither leaves the ledger with a hole that
 * must not be recorded as zero spend.
 */
export declare function acpUsageSource(sawCost: boolean, sawTokens: boolean): RunWorkerAcpResult["usageSource"];
export interface RunStructuredAcpParams<T> {
    agent: AcpAgentSpec;
    /** Which role is asking. Drives the ladder's messages and its exhaustion policy. */
    role: string;
    /** A scratch directory. ACP requires a `cwd` even for a turn that touches nothing. */
    cwd: string;
    systemPrompt: string;
    userMessage: string;
    model: string;
    timeoutSeconds: number;
    streamOpenTimeoutSeconds?: number;
    validation: JsonValidationOptions<T>;
    maxAttempts?: number;
    secretToken?: string;
    logger?: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
}
export interface RunStructuredAcpResult<T> {
    parsed: T;
    sdkSessionId: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    usageSource: RunWorkerAcpResult["usageSource"];
    /** True when the document was recovered from a truncated reply. */
    repaired: boolean;
}
/**
 * Run one of the six tool-less roles over ACP.
 *
 * These roles take one prompt and return one JSON document. They are not
 * agents: giving them tools does not merely waste a turn, it changes what they
 * emit — beta.28 and beta.40 both traced "no JSON in output" to a structured
 * role drifting into an assistant persona and narrating instead of answering.
 *
 * Tools are refused TWICE, on purpose. M6 configures the backend to have none,
 * and the guard below denies every request that arrives anyway. The first is
 * the real mechanism; the second is there because the whole reason
 * `preflightAcpBackend` exists is that a backend silently ignoring its own
 * permission configuration is a thing that happens, and a structured role that
 * quietly gained filesystem access would be a containment failure in the roles
 * that were supposed to be the safe ones.
 *
 * Each ladder rung is a FRESH session. Appending a correction to a session that
 * has already produced prose invites the model to continue in the same register,
 * and a new session costs nothing here because there is no accumulated worktree
 * state to carry over.
 */
export declare function runStructuredAcp<T>(params: RunStructuredAcpParams<T>): Promise<RunStructuredAcpResult<T>>;
/**
 * What this backend can do.
 *
 * `toolPermissionCallback` is declared true, but M6 does not take that on
 * trust: it is the one capability whose absence is invisible at runtime, and
 * the M2 probe measured OpenCode on default configuration running four shell
 * commands and two edits without a single permission request. The declaration
 * says "this backend is capable of asking"; the live probe establishes that
 * this INSTALLATION actually does.
 *
 * `reportsCostUsd` is true for hosted providers and false in practice for local
 * ones, which is why `usageSource` accompanies every result rather than the
 * harness inferring it from a zero.
 */
export declare const ACP_CAPABILITIES: BackendCapabilities;
export interface AcpPreflightResult {
    ok: boolean;
    reasons: string[];
}
/**
 * Startup check for the one failure mode that is invisible at runtime.
 *
 * An ACP backend that is not configured to ask for permission simply never
 * sends `session/request_permission`. Nothing errors; the guard is just never
 * consulted, and the bash whitelist and path denylist are silently inert while
 * still reading as enabled. The M2 probe measured exactly this: OpenCode on
 * default config ran four shell commands and two edits with zero permission
 * requests.
 *
 * This must therefore be verified before a worker is ever dispatched, and must
 * fail closed.
 */
export declare function preflightAcpBackend(input: {
    agentId: string;
    /** Parsed contents of the backend's own config, e.g. opencode.json. */
    backendConfig: unknown;
}): AcpPreflightResult;
//# sourceMappingURL=acp.d.ts.map