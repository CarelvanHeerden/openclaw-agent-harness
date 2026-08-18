import type { AcpToolCallForGuard } from "../safety/bash-guard.js";
/** The harness-side stop reasons the worker contract expects. */
export type WorkerStopReason = "end_turn" | "max_tokens" | "tool_error" | "timeout" | "canceled" | "first_token_timeout";
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
    /**
     * How to read costUsd / tokensIn / tokensOut. "acp-delta" means costUsd is a
     * real delta of the agent's cumulative figure and the token counts are
     * structurally unavailable; "unavailable" means the agent reported no cost at
     * all. Never let a consumer mistake either for a measured zero.
     */
    usageSource: "acp-delta" | "unavailable";
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