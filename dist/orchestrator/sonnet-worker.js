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
import { verifySubTaskOutput } from "./verify.js";
/**
 * Beta.21: hard cap on injected concept content. A worker system prompt is
 * loaded on every SDK turn, so pulling in an entire long-form knowledge
 * doc per concept is expensive and dilutes the signal. Keep to short
 * summaries + first-N-chars of any supplied content.
 */
const WORKER_CONCEPT_CONTENT_MAX_CHARS = 4000;
const WORKER_CONCEPT_TOTAL_MAX_CHARS = 12000;
export function buildWorkerSystemPrompt(brief, subTask) {
    const lines = [
        `You are a focused code-writing worker. Your job is ONE sub-task, nothing more.`,
        ``,
        `## Overall brief`,
        `Title: ${brief.title}`,
        `Motivation: ${brief.motivation}`,
        `Acceptance criteria (WHOLE feature):`,
        ...brief.acceptanceCriteria.map((c) => `  - ${c}`),
    ];
    // Beta.21: inject concept context if the brief carries any relevantConcepts.
    // Only concepts whose `path` is in `subTask.filesLikelyTouched`, OR that
    // have no path (repo-external knowledge), are included — keeps the
    // per-sub-task prompt focused instead of dumping the whole bundle.
    const applicable = pickConceptsForSubTask(brief.relevantConcepts ?? [], subTask);
    if (applicable.length > 0) {
        lines.push(``, `## Relevant knowledge (OKF concepts)`);
        let totalChars = 0;
        for (const c of applicable) {
            const header = c.path ? `### ${c.id} — ${c.path}` : `### ${c.id}`;
            lines.push(``, header);
            if (c.summary)
                lines.push(c.summary);
            if (c.tags && c.tags.length > 0)
                lines.push(`tags: [${c.tags.join(", ")}]`);
            if (c.content && totalChars < WORKER_CONCEPT_TOTAL_MAX_CHARS) {
                const remaining = WORKER_CONCEPT_TOTAL_MAX_CHARS - totalChars;
                const budget = Math.min(WORKER_CONCEPT_CONTENT_MAX_CHARS, remaining);
                const snippet = c.content.slice(0, budget);
                const truncated = c.content.length > budget ? `\n... (truncated, ${c.content.length - budget} chars omitted)` : "";
                lines.push(``, snippet + truncated);
                totalChars += snippet.length;
            }
        }
    }
    lines.push(``, `## Your sub-task`, `Title: ${subTask.title}`, `Intent: ${subTask.intent}`, `Files likely touched: ${subTask.filesLikelyTouched.join(", ") || "(unspecified)"}`, `Success criteria for THIS sub-task:`, ...subTask.successCriteria.map((c) => `  - ${c}`), ``, `## Rules`, `- Work only inside the worktree; never touch other paths.`, `- Do not run 'git push'. The orchestrator handles pushes.`, `- Do not install global packages, disable safeguards, or exfiltrate anything.`, `- If a bash command is refused, explain in prose and continue with an alternative approach.`, `- End your turn once the sub-task's success criteria are met.`);
    return lines.join("\n");
}
/**
 * Beta.21: choose which concepts are pertinent to this specific sub-task.
 * Filters to concepts whose `path` matches one of the sub-task's likely
 * files (exact match or prefix), OR concepts with no `path` (which we
 * treat as generally applicable to the whole brief).
 */
export function pickConceptsForSubTask(concepts, subTask) {
    if (concepts.length === 0)
        return [];
    const files = subTask.filesLikelyTouched;
    return concepts.filter((c) => {
        if (!c.path)
            return true;
        return files.some((f) => f === c.path || f.startsWith(c.path + "/") || (c.path ?? "").startsWith(f + "/"));
    });
}
export async function runWorker(worktreePath, brief, subTask, commitIdentity, deps, resumeSessionId) {
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
    }
    catch (err) {
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
    let changed = await deps.gitListChangedFiles(worktreePath, baseSha);
    let commitSha;
    if (changed.length > 0) {
        // Uncommitted working-tree changes exist -> the harness commits them.
        const sha = await deps.gitCommit(worktreePath, `harness(${subTask.seq}): ${subTask.title}`, commitIdentity);
        commitSha = sha ?? undefined;
    }
    // beta.47: the worker may have committed its OWN changes during the turn
    // (via its git tool), leaving a clean working tree. In that case the block
    // above is skipped and commitSha stays undefined even though HEAD moved.
    // Always reconcile against HEAD: if HEAD advanced past baseSha and we don't
    // yet have a sha, record HEAD as the commit sha and backfill filesChanged
    // from base..HEAD. This makes commit_sha bookkeeping correct regardless of
    // WHO made the commit (session 94a516a0 root cause).
    if (!commitSha && deps.gitHeadSha && baseSha) {
        try {
            const head = await deps.gitHeadSha(worktreePath);
            if (head && head !== baseSha) {
                commitSha = head;
                if (changed.length === 0 && deps.gitListCommittedFiles) {
                    const committed = await deps.gitListCommittedFiles(worktreePath, baseSha);
                    if (committed.length > 0)
                        changed = committed;
                }
            }
        }
        catch {
            // HEAD lookup best-effort; leave commitSha as-is on failure.
        }
    }
    // SDK stop reason gives a provisional status.
    let status = sdkResult.stopReason === "timeout"
        ? "timeout"
        : sdkResult.stopReason === "end_turn"
            ? "completed"
            : "failed";
    // beta.7 fix #1: for sub-tasks with observable side effects, do NOT trust
    // the SDK signal. Verify against reality; a provisional `completed` that
    // fails verification becomes `failed` and its spend is flagged wasted.
    let verification;
    let wastedSpend = false;
    if (deps.buildVerifyProbes && (subTask.verify?.length ?? 0) > 0) {
        const probes = deps.buildVerifyProbes(worktreePath, baseSha);
        verification = await verifySubTaskOutput(subTask.verify, {
            defaultBranch: subTask.verify?.reduce((acc, v) => (v.kind === "branch_pushed" && v.branch ? v.branch : acc), "") ?? "",
            subTaskStartMs,
            baseSha,
        }, probes);
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
        finalMessage: sdkResult.finalMessage,
        verification,
        wastedSpend,
    };
}
//# sourceMappingURL=sonnet-worker.js.map