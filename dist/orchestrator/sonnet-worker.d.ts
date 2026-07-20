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
     * beta.48 (C1): the worker's final assistant text message. Persisted on
     * every turn so a zero-side-effect end_turn (reasoned refusal) is visible
     * to the harness / operator instead of being an opaque empty turn.
     */
    finalMessage?: string;
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
        finalMessage?: string;
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
     * beta.47: current HEAD sha of the worktree. Used to detect a worker that
     * committed its OWN changes during the turn (via its git tool), which
     * leaves the working tree clean so `gitListChangedFiles` returns empty and
     * the harness never runs its own commit -> commitSha was silently lost
     * (session 94a516a0: commit_made verifier passed on HEAD!=base but the
     * sub_task row had commit_sha=null). Optional for back-compat; when absent
     * behaviour is unchanged.
     */
    gitHeadSha?: (worktreePath: string) => Promise<string>;
    /**
     * beta.47: files touched by commits in base..HEAD (includes worker
     * self-commits, unlike the working-tree diff). Optional; used to backfill
     * filesChanged when the worker self-committed.
     */
    gitListCommittedFiles?: (worktreePath: string, base: string) => Promise<string[]>;
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
/**
 * Beta.21: minimal OKF concept shape the worker prompt understands.
 * Kept local (structural type) so this module doesn't take a cross-
 * package dep on the crystallise types just for prompt formatting.
 */
type WorkerConceptRef = {
    id: string;
    path?: string;
    summary?: string;
    tags?: string[];
    content?: string;
};
export declare function buildWorkerSystemPrompt(brief: {
    title: string;
    motivation: string;
    acceptanceCriteria: string[];
    /** Beta.21: OKF concept refs from the crystallised brief. Optional. */
    relevantConcepts?: WorkerConceptRef[];
}, subTask: LeadPlanSubTask): string;
/**
 * Beta.21: choose which concepts are pertinent to this specific sub-task.
 * Filters to concepts whose `path` matches one of the sub-task's likely
 * files (exact match or prefix), OR concepts with no `path` (which we
 * treat as generally applicable to the whole brief).
 */
export declare function pickConceptsForSubTask(concepts: WorkerConceptRef[], subTask: LeadPlanSubTask): WorkerConceptRef[];
export declare function runWorker(worktreePath: string, brief: {
    title: string;
    motivation: string;
    acceptanceCriteria: string[];
}, subTask: LeadPlanSubTask, commitIdentity: {
    name: string;
    email: string;
}, deps: WorkerDeps, resumeSessionId?: string): Promise<WorkerResult>;
export {};
//# sourceMappingURL=sonnet-worker.d.ts.map