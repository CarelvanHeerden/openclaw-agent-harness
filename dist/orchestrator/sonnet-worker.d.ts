/**
 * Sonnet worker.
 *
 * Executes ONE sub-task inside a git worktree, using
 * `@anthropic-ai/claude-agent-sdk`'s `query()` with:
 *   - a scoped system prompt (built from the brief + sub-task)
 *   - MCP tools: read/write/edit (SDK built-ins), plus our custom
 *     harness_bash tool guarded by bash-guard.
 *   - `canUseTool` permission callback that hard-blocks Bash outside the
 *     whitelist, blocks writes to path_denylist, blocks git push.
 *   - session tagging so the SDK session id is captured for resume.
 *
 * The worker COMMITS but does not PUSH. Push happens once, at the end,
 * by the orchestrator after adversarial review passes.
 */
import type { HarnessConfig } from "../config.js";
import type { LeadPlanSubTask } from "./fable5-lead.js";
import { type VerifyProbes, type VerifyOutcome } from "./verify.js";
export interface WorkerResult {
    status: "completed" | "failed" | "timeout";
    filesChanged: string[];
    commitSha?: string;
    sdkSessionId?: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    reason?: string;
    logsExcerpt?: string;
    /**
     * Result of post-execution observable-side-effect verification (beta.7
     * fix #1). Undefined when the sub-task declared no `verify` contracts.
     * When present and `!ok`, `status` is forced to `failed` and `costUsd` is
     * wasted spend.
     */
    verification?: VerifyOutcome;
    /** True when the SDK reported success but verification proved otherwise. */
    wastedSpend?: boolean;
}
export interface WorkerDeps {
    config: HarnessConfig;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
    /**
     * Injected SDK call. In production this is a thin wrapper around
     * `@anthropic-ai/claude-agent-sdk`'s `query()` -- see
     * `src/adapters/claude-sdk.ts`. In tests it is a stub.
     */
    runWorkerModel: (input: {
        worktreePath: string;
        systemPrompt: string;
        userMessage: string;
        model: string;
        permissionMode: HarnessConfig["safety"]["worker_permission_mode"];
        resumeSessionId?: string;
        timeoutSeconds: number;
        canUseTool: (toolName: string, toolInput: unknown) => Promise<{
            allow: boolean;
            reason?: string;
        }>;
    }) => Promise<{
        sdkSessionId: string;
        stopReason: "end_turn" | "max_tokens" | "tool_error" | "timeout" | "canceled";
        costUsd: number;
        tokensIn: number;
        tokensOut: number;
        logsExcerpt: string;
    }>;
    /**
     * Injected git operations. Wraps `git -C <worktree>` calls.
     */
    gitCommit: (worktreePath: string, message: string, identity: {
        name: string;
        email: string;
    }) => Promise<string | null>;
    gitListChangedFiles: (worktreePath: string, base: string) => Promise<string[]>;
    gitBaseSha: (worktreePath: string) => Promise<string>;
    /**
     * canUseTool guard factory. The orchestrator builds one per session
     * with the bash guard + path denylist wired in.
     */
    buildCanUseTool: () => (toolName: string, toolInput: unknown) => Promise<{
        allow: boolean;
        reason?: string;
    }>;
    /**
     * Observable-side-effect probes for post-execution verification (beta.7
     * fix #1). Optional: when absent, verification is skipped and the SDK
     * signal is trusted (back-compat with existing test doubles).
     */
    buildVerifyProbes?: (worktreePath: string, baseSha: string) => VerifyProbes;
}
export declare function buildWorkerSystemPrompt(brief: {
    title: string;
    motivation: string;
    acceptanceCriteria: string[];
}, subTask: LeadPlanSubTask): string;
export declare function runWorker(worktreePath: string, brief: {
    title: string;
    motivation: string;
    acceptanceCriteria: string[];
}, subTask: LeadPlanSubTask, commitIdentity: {
    name: string;
    email: string;
}, deps: WorkerDeps, resumeSessionId?: string): Promise<WorkerResult>;
//# sourceMappingURL=sonnet-worker.d.ts.map