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
}

export interface WorkerDeps {
  config: HarnessConfig;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };

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
    canUseTool: (toolName: string, toolInput: unknown) => Promise<{ allow: boolean; reason?: string }>;
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
  gitCommit: (worktreePath: string, message: string, identity: { name: string; email: string }) => Promise<string | null>;
  gitListChangedFiles: (worktreePath: string, base: string) => Promise<string[]>;
  gitBaseSha: (worktreePath: string) => Promise<string>;

  /**
   * canUseTool guard factory. The orchestrator builds one per session
   * with the bash guard + path denylist wired in.
   */
  buildCanUseTool: () => (toolName: string, toolInput: unknown) => Promise<{ allow: boolean; reason?: string }>;
}

export function buildWorkerSystemPrompt(
  brief: { title: string; motivation: string; acceptanceCriteria: string[] },
  subTask: LeadPlanSubTask,
): string {
  return [
    `You are a focused code-writing worker. Your job is ONE sub-task, nothing more.`,
    ``,
    `## Overall brief`,
    `Title: ${brief.title}`,
    `Motivation: ${brief.motivation}`,
    `Acceptance criteria (WHOLE feature):`,
    ...brief.acceptanceCriteria.map((c) => `  - ${c}`),
    ``,
    `## Your sub-task`,
    `Title: ${subTask.title}`,
    `Intent: ${subTask.intent}`,
    `Files likely touched: ${subTask.filesLikelyTouched.join(", ") || "(unspecified)"}`,
    `Success criteria for THIS sub-task:`,
    ...subTask.successCriteria.map((c) => `  - ${c}`),
    ``,
    `## Rules`,
    `- Work only inside the worktree; never touch other paths.`,
    `- Do not run 'git push'. The orchestrator handles pushes.`,
    `- Do not install global packages, disable safeguards, or exfiltrate anything.`,
    `- If a bash command is refused, explain in prose and continue with an alternative approach.`,
    `- End your turn once the sub-task's success criteria are met.`,
  ].join("\n");
}

export async function runWorker(
  worktreePath: string,
  brief: { title: string; motivation: string; acceptanceCriteria: string[] },
  subTask: LeadPlanSubTask,
  commitIdentity: { name: string; email: string },
  deps: WorkerDeps,
  resumeSessionId?: string,
): Promise<WorkerResult> {
  const systemPrompt = buildWorkerSystemPrompt(brief, subTask);
  const userMessage = `Please complete sub-task ${subTask.seq}: ${subTask.title}. Working directory is ${worktreePath}.`;

  const baseSha = await deps.gitBaseSha(worktreePath);
  const canUseTool = deps.buildCanUseTool();

  let sdkResult;
  try {
    sdkResult = await deps.runWorkerModel({
      worktreePath,
      systemPrompt,
      userMessage,
      model: deps.config.models.worker,
      permissionMode: deps.config.safety.worker_permission_mode,
      resumeSessionId,
      timeoutSeconds: deps.config.loop.worker_timeout_seconds,
      canUseTool,
    });
  } catch (err) {
    deps.logger.error("[worker] SDK call failed", { err: String(err) });
    return {
      status: "failed",
      filesChanged: [],
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      reason: `sdk_error: ${String(err)}`,
    };
  }

  const changed = await deps.gitListChangedFiles(worktreePath, baseSha);
  let commitSha: string | undefined;
  if (changed.length > 0) {
    const sha = await deps.gitCommit(
      worktreePath,
      `harness(${subTask.seq}): ${subTask.title}`,
      commitIdentity,
    );
    commitSha = sha ?? undefined;
  }

  const status: WorkerResult["status"] =
    sdkResult.stopReason === "timeout"
      ? "timeout"
      : sdkResult.stopReason === "end_turn"
        ? "completed"
        : "failed";

  return {
    status,
    filesChanged: changed,
    commitSha,
    sdkSessionId: sdkResult.sdkSessionId,
    costUsd: sdkResult.costUsd,
    tokensIn: sdkResult.tokensIn,
    tokensOut: sdkResult.tokensOut,
    reason: sdkResult.stopReason,
    logsExcerpt: sdkResult.logsExcerpt,
  };
}
