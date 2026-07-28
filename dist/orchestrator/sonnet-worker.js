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
import { renderConventionsForPrompt } from "./repo-conventions.js";
/**
 * Beta.21: hard cap on injected concept content. A worker system prompt is
 * loaded on every SDK turn, so pulling in an entire long-form knowledge
 * doc per concept is expensive and dilutes the signal. Keep to short
 * summaries + first-N-chars of any supplied content.
 */
const WORKER_CONCEPT_CONTENT_MAX_CHARS = 4000;
const WORKER_CONCEPT_TOTAL_MAX_CHARS = 12000;
// beta.66 (warm-worker-context): total char budget for the lead's handed-down
// code excerpts, so a verbose plan can't blow the worker context/cost.
const WORKER_CONTEXT_EXCERPT_TOTAL_MAX_CHARS = 12000;
const WORKER_CONTEXT_EXCERPT_MAX_CHARS = 4000;
/**
 * beta.66: render the lead's WorkerContext into a prompt block. Exported for
 * unit tests. Returns "" when there is no context (cold behaviour).
 */
export function renderWorkerContextBlock(ctx) {
    if (!ctx)
        return "";
    const lines = [
        ``,
        `## Implementation context (from the lead investigation)`,
        `The lead (a stronger model) already investigated this. TRUST and USE this`,
        `context; do NOT re-explore the repo to re-derive it. Implement the changeSpec`,
        `below. Only read files this context did not already give you.`,
    ];
    if (ctx.rationale)
        lines.push(``, `### Why / how`, ctx.rationale);
    if (ctx.changeSpec)
        lines.push(``, `### Precise change to make`, ctx.changeSpec);
    if (ctx.relatedSymbols && ctx.relatedSymbols.length > 0) {
        lines.push(``, `### Related symbols`, ...ctx.relatedSymbols.map((s) => `- ${s}`));
    }
    if (ctx.gotchas && ctx.gotchas.length > 0) {
        lines.push(``, `### Gotchas for this sub-task`, ...ctx.gotchas.map((g) => `- ${g}`));
    }
    if (ctx.codeExcerpts && ctx.codeExcerpts.length > 0) {
        lines.push(``, `### Code the lead already read (do not re-open to re-find these)`);
        let total = 0;
        for (const ex of ctx.codeExcerpts) {
            if (total >= WORKER_CONTEXT_EXCERPT_TOTAL_MAX_CHARS) {
                lines.push(``, `... (remaining excerpts omitted, char budget reached)`);
                break;
            }
            const anchor = ex.startLine != null ? `${ex.path}:${ex.startLine}` : ex.path;
            lines.push(``, `#### ${anchor}${ex.note ? ` -- ${ex.note}` : ""}`);
            const remaining = WORKER_CONTEXT_EXCERPT_TOTAL_MAX_CHARS - total;
            const budget = Math.min(WORKER_CONTEXT_EXCERPT_MAX_CHARS, remaining);
            const snippet = ex.snippet.slice(0, budget);
            const truncated = ex.snippet.length > budget ? `\n... (truncated, ${ex.snippet.length - budget} chars omitted)` : "";
            lines.push("```", snippet + truncated, "```");
            total += snippet.length;
        }
    }
    return lines.join("\n");
}
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
    lines.push(``, `## Your sub-task`, `Title: ${subTask.title}`, `Intent: ${subTask.intent}`, `Files likely touched: ${subTask.filesLikelyTouched.join(", ") || "(unspecified)"}`, `Success criteria for THIS sub-task:`, ...subTask.successCriteria.map((c) => `  - ${c}`));
    // beta.66 (warm-worker-context): lead the worker with Fable's investigation
    // (rationale + exact change + code it already read + gotchas) BEFORE the
    // generic rules, so a cheaper worker implements mechanically instead of
    // re-scanning the repo. Absent workerContext = unchanged cold behaviour.
    const contextBlock = renderWorkerContextBlock(subTask.workerContext);
    if (contextBlock)
        lines.push(contextBlock);
    lines.push(``, `## Rules`, `- Work only inside the worktree; never touch other paths.`, 
    // beta.75 (#3): SCOPE DISCIPLINE. Session 3858bee6 (#876): the brief said
    // "do NOT touch route.ts" (a test-only change) yet the worker modified
    // route.ts anyway; the adversary caught it and returned do_not_merge,
    // stranding an otherwise-good PR. A negative scope constraint is a HARD
    // boundary, not a suggestion.
    `- SCOPE IS A HARD BOUNDARY. If the brief, success criteria, or intent says`, `  "do NOT touch/modify/edit <file-or-path>", "test-only", "do not change`, `  <X>", or otherwise forbids a file/area, you MUST NOT modify that file/area`, `  — not even temporarily, not "to verify", not to reconstruct-then-revert.`, `  If completing the sub-task seems to REQUIRE editing a forbidden file, do`, `  NOT do it: finish only the in-scope work and note the tension in your final`, `  message. A commit that touches a forbidden file FAILS review (the adversary`, `  will flag it out-of-scope and refuse merge), so a "working" change that`, `  breaks scope is worse than a smaller in-scope one. When in doubt, stay`, `  narrow: touch ONLY the files the sub-task explicitly requires.`, `- Do not run 'git push'. The orchestrator handles pushes.`, `- Do not install global packages, disable safeguards, or exfiltrate anything.`, `- If a bash command is refused, explain in prose and continue with an alternative approach.`, `- End your turn once the sub-task's success criteria are met.`, `- If an "Implementation context" block is present above, the lead already`, `  investigated this. Implement its changeSpec directly; do NOT re-explore the`, `  repo to re-derive what it already tells you. Only read files it did not cover.`, ``, `## Execution protocol (CRITICAL)`, `- You have EXACTLY ONE turn to complete this sub-task. Dispatch is one-shot.`, `- There is NO event stream from the harness back to you mid-turn. There is`, `  NO "Monitor event", no "ready signal", no background callback. NOTHING will`, `  ever notify you or resume you. If you end your turn waiting for such an`, `  event, the work simply does not get done and the sub-task FAILS.`, `- NEVER 'await', 'wait for', or 'poll for' a harness/monitor/install event.`, `  These mechanisms do not exist in this harness.`, `- If you TRULY need a one-off install to make an edit possible (rare -- e.g.`, `  \`npm ci\` so an import resolves for a scoped read), run it INLINE in a`, `  single Bash tool call that BLOCKS until the process exits, read its`, `  result, then continue in the SAME turn. Do not background it and wait.`, 
    // beta.81 (Track B / B1): CI-VERIFICATION SHIFT. The worker WRITES + COMMITS
    // code; GitHub CI verifies it. The pre-beta.81 prompt told the worker to run
    // \`npm test\` / \`npx vitest run\` / \`npm run build\` / \`npx eslint .\` in-turn
    // "to green" -- that is what let sub-task 11 (the oversized test sub-task) sit
    // in an until-green loop. Verification is now CI-only: after the branch is
    // pushed the harness polls GitHub's combined status/check-runs. Do NOT run
    // the suite/build/lint locally as a verification gate.
    `- DO NOT run the test suite, a build, or lint "to green" in your turn. That`, `  means: do NOT run \`npm test\`, \`npx vitest run\`, \`npm run build\`, \`tsc\`,`, `  \`npx eslint .\`, or any whole-project check as a VERIFICATION step. GitHub`, `  CI runs those AFTER the harness pushes your branch, and the harness reads`, `  the CI result. Nobody needs you to prove green locally, and there is NO`, `  async test runner / background watcher / "test-run event" in this harness.`, `  Your job is to WRITE the correct code and COMMIT it. Committing the correct`, `  change is what completes the sub-task; CI does the verifying.`, `- HARD STOP RULE: if you are about to write "I'll wait for", "waiting for the`, `  notification/event/signal", "the monitor/watcher/observer/background process`, `  will notify me", or any phrase implying something will resume you -- STOP.`, `  That mechanism does not exist. Run the command inline instead and continue.`, `  Ending your turn on such a phrase = the sub-task FAILS with zero work done.`, `- Do not go off-plan to self-verify by running the suite/build/lint. Make`, `  the required edit and commit. Committing the correct change is what`, `  completes the sub-task; GitHub CI verifies it after the push. (If THIS`, `  sub-task's success criteria are literally "a test asserts X", WRITE that`, `  test file and commit it -- authoring a test is code; RUNNING the suite to`, `  green is not your job.)`, 
    // beta.70 (F1): worker-turn slimming. The harness runs the repo's declared
    // check scripts (typecheck, lint, and any generator like `npm run okf`) in
    // a POST-WORKER convention-check phase -- see repo-conventions.ts. In
    // PR #870 the cycle-2 worker burned 19 min running `npm run okf` (a
    // 1436-file regenerator) + a repo-wide `tsc` inside its own turn to land a
    // 3-line diff, duplicating work the pipeline does downstream. Keep heavy
    // repo-wide tooling OUT of the worker turn.
    // beta.81 (Track B / B1) EXTENDS this beta.70 guard: not only "no repo-wide
    // generators/builds/typechecks in-turn" but "no local verification runs at
    // all" -- CI is the verification spine now.
    `- DO NOT run repo-wide generators, full-repo builds, whole-project`, `  typechecks, or the test suite/lint inside your turn. Specifically: do NOT`, `  run bundle/artifact regenerators (e.g. \`npm run okf\`, codegen,`, `  "regenerate the bundle"), do NOT run a repo-wide \`tsc --noEmit\` / full`, `  \`npm run build\`, do NOT run \`npm test\` / \`npx vitest run\`, and do NOT`, `  run a whole-repo lint. GitHub CI runs the repo's declared checks AFTER the`, `  harness pushes your branch. Running them yourself duplicates minutes of`, `  work, often produces a zero diff, and is NOT how this sub-task is verified.`, `- For your OWN reasoning you MAY read the specific files you changed and`, `  reason about them. Do NOT turn that into a suite/build/lint run. When in`, `  doubt, make the edit, commit, stop -- CI verifies.`);
    // beta.63 (Fix 1): the worker gets NO OpenClaw context injection, so the
    // repo's declared conventions must be carried in the prompt explicitly.
    const conventionBlock = renderConventionsForPrompt(brief.repoConventions, "worker");
    if (conventionBlock)
        lines.push(conventionBlock);
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
export async function runWorker(worktreePath, brief, subTask, commitIdentity, deps, resumeSessionId, 
/**
 * beta.53 (P1b): extra corrective context appended to the dispatch on a
 * retry (e.g. "your prior turn wrote X but never committed -- just commit
 * it; there is no Monitor event"). Undefined on the first attempt.
 */
dispatchHint) {
    const systemPrompt = buildWorkerSystemPrompt(brief, subTask);
    const userMessage = `Please complete sub-task ${subTask.seq}: ${subTask.title}. Working directory is ${worktreePath}.` +
        (dispatchHint ? `\n\n${dispatchHint}` : "");
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
            // beta.64 (P0-1) / beta.65 (P0): arm the split-phase watchdog on every
            // worker call. Phase 2 (stream-open -> first-token) default lowered to 30;
            // phase 1 (call-init -> stream-open) is the new beta.65 pre-stream cover.
            firstTokenTimeoutSeconds: deps.config.loop.sdk_first_token_timeout_seconds ?? 30,
            streamOpenTimeoutSeconds: deps.config.loop.sdk_stream_open_timeout_seconds ?? 120,
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
    // beta.53 (P2): capture uncommitted working-tree changes BEFORE building the
    // result, so a wrote-but-didn't-commit turn is visible (not mislabelled as
    // zero side-effects). Only meaningful when nothing was committed this turn.
    let uncommittedFiles;
    if (deps.gitStatusPorcelain) {
        try {
            const dirty = await deps.gitStatusPorcelain(worktreePath);
            if (dirty.length > 0)
                uncommittedFiles = dirty;
        }
        catch {
            // best-effort; leave undefined on failure.
        }
    }
    // SDK stop reason gives a provisional status.
    //
    // beta.56 (P0-5): the worker-path verification that used to run here was
    // REMOVED. It duplicated the loop-path verification (loop.ts runs
    // inferVerifyContract -- whose precedence 1 is the explicit `verify` -- on
    // every sub-task) with two defects the loop path doesn't have:
    //   1. It computed `defaultBranch` as "" unless a branch_pushed entry
    //      carried an explicit branch, so provider probes ran with an empty
    //      branch (GET /pulls?head=owner: matches ALL PRs -> false PASS;
    //      ?ref= falls back to the default branch -> checks main, not the
    //      session branch). The loop path passes plan.branch correctly.
    //   2. By forcing status='failed' BEFORE the loop saw the result, it took
    //      loop.ts's `result.status !== "completed"` early-exit and BYPASSED
    //      the entire beta.53/54/55 retry / refusal / clarification machinery.
    // The loop is now the single verification site.
    const status = sdkResult.stopReason === "first_token_timeout"
        ? "first_token_timeout"
        : sdkResult.stopReason === "timeout"
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
        finalMessage: sdkResult.finalMessage,
        uncommittedFiles,
        streamOpened: sdkResult.streamOpened,
        msToFirstToken: sdkResult.msToFirstToken,
    };
}
//# sourceMappingURL=sonnet-worker.js.map