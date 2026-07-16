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
import { verifySubTaskOutput, type VerifyProbes, type VerifyOutcome } from "./verify.js";

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

  /**
   * Observable-side-effect probes for post-execution verification (beta.7
   * fix #1). Optional: when absent, verification is skipped and the SDK
   * signal is trusted (back-compat with existing test doubles).
   */
  buildVerifyProbes?: (worktreePath: string, baseSha: string) => VerifyProbes;
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

  const subTaskStartMs = Date.now();
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

  // SDK stop reason gives a provisional status.
  let status: WorkerResult["status"] =
    sdkResult.stopReason === "timeout"
      ? "timeout"
      : sdkResult.stopReason === "end_turn"
        ? "completed"
        : "failed";

  // beta.7 fix #1: for sub-tasks with observable side effects, do NOT trust
  // the SDK signal. Verify against reality; a provisional `completed` that
  // fails verification becomes `failed` and its spend is flagged wasted.
  let verification: VerifyOutcome | undefined;
  let wastedSpend = false;
  if (deps.buildVerifyProbes && (subTask.verify?.length ?? 0) > 0) {
    const probes = deps.buildVerifyProbes(worktreePath, baseSha);
    verification = await verifySubTaskOutput(
      subTask.verify,
      {
        defaultBranch:
          subTask.verify?.reduce<string>(
            (acc, v) => (v.kind === "branch_pushed" && v.branch ? v.branch : acc),
            "",
          ) ?? "",
        subTaskStartMs,
        baseSha,
      },
      probes,
    );
    if (status === "completed" && !verification.ok) {
      status = "failed";
      wastedSpend = true;
      deps.logger.warn("[worker] SDK reported success but verification failed", {
        seq: subTask.seq,
        summary: verification.summary,
        costUsd: sdkResult.costUsd,
      });
    }
  }

  return {
    status,
    filesChanged: changed,
    commitSha,
    sdkSessionId: sdkResult.sdkSessionId,
    costUsd: sdkResult.costUsd,
    tokensIn: sdkResult.tokensIn,
    tokensOut: sdkResult.tokensOut,
    reason: verification && !verification.ok ? `verification_failed: ${verification.summary}` : sdkResult.stopReason,
    logsExcerpt: sdkResult.logsExcerpt,
    verification,
    wastedSpend,
  };
}
