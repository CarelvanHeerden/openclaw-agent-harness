/**
 * Worker.
 *
 * Executes ONE sub-task inside a git worktree, through an injected backend
 * call, with:
 *   - a scoped system prompt (built from the brief + sub-task)
 *   - read/write/edit tools, plus our custom harness_bash tool guarded by
 *     bash-guard.
 *   - a permission callback that hard-blocks Bash outside the whitelist,
 *     blocks writes to path_denylist, blocks git push.
 *   - session tagging so the backend session id is captured for resume.
 *
 * The worker COMMITS but does not PUSH. Push happens once, at the end,
 * by the orchestrator after adversarial review passes.
 */
import { renderConventionsForPrompt } from "./repo-conventions.js";
import { authorizedGeneratorsForPaths, renderGeneratorInstruction, resolveGenerators, } from "./generated-artifacts.js";
import { inferVerifyContract } from "./verify-contract.js";
import { renderObserveReportsBlock } from "./observe-handoff.js";
import { HARNESS_SCRATCH_DIR } from "../adapters/git-worktree.js";
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
        // beta.134: the escape hatch. "Do not re-explore" without it reads as an
        // absolute ban, and a worker that needs a fact this block does not contain
        // is then left choosing between disobeying and inventing. At least one
        // model picked inventing and reported edits it never made.
        `If a path, symbol, or convention you need is NOT given above or in the`,
        `findings block, READ THE REPO to find it. The instruction is "do not redo`,
        `work already done for you", never "guess". Never describe an edit you have`,
        `not actually made.`,
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
export function buildWorkerSystemPrompt(brief, subTask, 
/**
 * rc.5: the generators this sub-task is authorized to run, already narrowed
 * to the paths it owes (see authorizedGeneratorsForPaths). Empty/omitted
 * leaves the blanket no-generators guard fully in force, which is the default
 * because `verify.generators` is empty unless an operator declares it.
 */
authorizedGenerators = []) {
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
    // beta.134 (observe-handoff): the findings of the investigation sub-tasks
    // this one depends on, verbatim. FIRST, ahead of the lead's plan-time
    // context, because they are the newer and more authoritative account of the
    // repo -- the lead guessed at planning time, the probe went and looked.
    // Absent (no observe step, or nothing recorded) = unchanged behaviour.
    const observeBlock = renderObserveReportsBlock(subTask.priorObserveReports ?? []);
    if (observeBlock)
        lines.push(observeBlock);
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
    `- SCOPE IS A HARD BOUNDARY. If the brief, success criteria, or intent says`, `  "do NOT touch/modify/edit <file-or-path>", "test-only", "do not change`, `  <X>", or otherwise forbids a file/area, you MUST NOT modify that file/area`, `  — not even temporarily, not "to verify", not to reconstruct-then-revert.`, `  If completing the sub-task seems to REQUIRE editing a forbidden file, do`, `  NOT do it: finish only the in-scope work and note the tension in your final`, `  message. A commit that touches a forbidden file FAILS review (the adversary`, `  will flag it out-of-scope and refuse merge), so a "working" change that`, `  breaks scope is worse than a smaller in-scope one. When in doubt, stay`, `  narrow: touch ONLY the files the sub-task explicitly requires.`, `- Do not run 'git push'. The orchestrator handles pushes.`, `- Do not install global packages, disable safeguards, or exfiltrate anything.`, `- If a bash command is refused, the refusal usually names the permitted alternative. Take it and`, `  carry on -- a denial is not a reason to stop, and it is not something to report back instead of`, `  doing the work.`, `- Inline interpreter code ('python3 -c', 'node -e') and heredocs are refused. To inspect anything,`, `  write a script to '${HARNESS_SCRATCH_DIR}/' and run it from there. LEAVE IT BEHIND: that directory`, `  is excluded from git and the harness deletes it for you. 'rm' is denied and you do not need it.`, `- End your turn once the sub-task's success criteria are met.`, `- If an "Implementation context" block is present above, the lead already`, `  investigated this. Implement its changeSpec directly; do NOT re-explore the`, `  repo to re-derive what it already tells you. Only read files it did not cover.`, 
    // beta.134 (observe-handoff): the sub-task's intent may name an earlier
    // sub-task's findings ("apply the paths reported by sub-task 1"). Those
    // findings are now IN this prompt, so point at them explicitly -- and say
    // what to do in the case that used to produce a fabricated summary.
    `- If a "Findings from earlier sub-tasks" block is present above, it holds the`, `  facts your intent refers to when it cites an earlier sub-task. Work from`, `  those exact paths and names. If a fact you need is in NEITHER block, read`, `  the repo for it. Under no circumstances report work you did not do.`, ``, `## Execution protocol (CRITICAL)`, `- You have EXACTLY ONE turn to complete this sub-task. Dispatch is one-shot.`, `- There is NO event stream from the harness back to you mid-turn. There is`, `  NO "Monitor event", no "ready signal", no background callback. NOTHING will`, `  ever notify you or resume you. If you end your turn waiting for such an`, `  event, the work simply does not get done and the sub-task FAILS.`, `- NEVER 'await', 'wait for', or 'poll for' a harness/monitor/install event.`, `  These mechanisms do not exist in this harness.`, `- If you TRULY need a one-off install to make an edit possible (rare -- e.g.`, `  \`npm ci\` so an import resolves for a scoped read), run it INLINE in a`, `  single Bash tool call that BLOCKS until the process exits, read its`, `  result, then continue in the SAME turn. Do not background it and wait.`, 
    // beta.81 (Track B / B1): CI-VERIFICATION SHIFT. The worker WRITES + COMMITS
    // code; GitHub CI verifies it. The pre-beta.81 prompt told the worker to run
    // \`npm test\` / \`npx vitest run\` / \`npm run build\` / \`npx eslint .\` in-turn
    // "to green" -- that is what let sub-task 11 (the oversized test sub-task) sit
    // in an until-green loop. Verification is now CI-only: after the branch is
    // pushed the harness polls GitHub's combined status/check-runs. Do NOT run
    // the suite/build/lint locally as a verification gate.
    `- DO NOT run the test suite, a build, or lint "to green" in your turn. That`, `  means: do NOT run \`npm test\`, \`npx vitest run\`, \`npm run build\`, \`tsc\`,`, `  \`npx eslint .\`, or any whole-project check as a VERIFICATION step. GitHub`, `  CI runs those AFTER the harness pushes your branch, and the harness reads`, `  the CI result. Nobody needs you to prove green locally, and there is NO`, `  async test runner / background watcher / "test-run event" in this harness.`, `  Your job is to WRITE the correct code and COMMIT it. Committing the correct`, `  change is what completes the sub-task; CI does the verifying.`, `- HARD STOP RULE: if you are about to write "I'll wait for", "waiting for the`, `  notification/event/signal", "the monitor/watcher/observer/background process`, `  will notify me", or any phrase implying something will resume you -- STOP.`, `  That mechanism does not exist. Run the command inline instead and continue.`, `  Ending your turn on such a phrase = the sub-task FAILS with zero work done.`, `- Do not go off-plan to self-verify by running the suite/build/lint. Make`, `  the required edit and commit. Committing the correct change is what`, `  completes the sub-task; GitHub CI verifies it after the push. (If THIS`, `  sub-task's success criteria are literally "a test asserts X", WRITE that`, `  test file and commit it -- authoring a test is code; RUNNING the suite to`, `  green is not your job.)`, 
    // beta.70 (F1): worker-turn slimming. In PR #870 the cycle-2 worker burned
    // 19 min running `npm run okf` (a 1436-file regenerator) + a repo-wide
    // `tsc` inside its own turn to land a 3-line diff. Keep heavy repo-wide
    // tooling OUT of the worker turn.
    //
    // rc.5 corrects the JUSTIFICATION this guard used to carry. It claimed the
    // harness ran generators "in a POST-WORKER convention-check phase". It does
    // not: that phase runs CHECK scripts, commits nothing, and is off by
    // default since beta.81. So the guard stands on its own cost rationale, and
    // the one authorized exception is a NAMED generator for a NAMED path the
    // sub-task already owes -- appended below from verify.generators. What is
    // forbidden is SPECULATIVE repo-wide tooling, not producing a deliverable.
    // beta.81 (Track B / B1) EXTENDS this beta.70 guard: not only "no repo-wide
    // generators/builds/typechecks in-turn" but "no local verification runs at
    // all" -- CI is the verification spine now.
    `- DO NOT run repo-wide generators, full-repo builds, whole-project`, `  typechecks, or the test suite/lint inside your turn. Specifically: do NOT`, `  run bundle/artifact regenerators (e.g. \`npm run okf\`, codegen,`, `  "regenerate the bundle"), do NOT run a repo-wide \`tsc --noEmit\` / full`, `  \`npm run build\`, do NOT run \`npm test\` / \`npx vitest run\`, and do NOT`, `  run a whole-repo lint. GitHub CI runs the repo's declared checks AFTER the`, `  harness pushes your branch. Running them yourself duplicates minutes of`, `  work, often produces a zero diff, and is NOT how this sub-task is verified.`, `- For your OWN reasoning you MAY read the specific files you changed and`, `  reason about them. Do NOT turn that into a suite/build/lint run. When in`, `  doubt, make the edit, commit, stop -- CI verifies.`);
    // beta.63 (Fix 1): the worker gets NO OpenClaw context injection, so the
    // repo's declared conventions must be carried in the prompt explicitly.
    const conventionBlock = renderConventionsForPrompt(brief.repoConventions, "worker");
    if (conventionBlock)
        lines.push(conventionBlock);
    // rc.5: the narrow, named exception to the guard above. It goes AFTER the
    // prohibition so the worker reads the general rule and then the specific
    // authorization, rather than a rule it has to remember an exception to.
    const generatorBlock = renderGeneratorInstruction(authorizedGenerators);
    if (generatorBlock)
        lines.push(generatorBlock);
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
dispatchHint, 
/**
 * beta.90 (Feature 2): stream-slow liveness callback. Invoked when the worker
 * SDK stream opens then goes idle (no token/activity delta) past the
 * configured threshold. OBSERVABILITY ONLY -- never aborts. Undefined => no
 * stream-slow surfacing (the detector still ticks but has nowhere to report).
 */
onStreamSlow, 
/**
 * beta.91 (Fix 3): per-sub-task model override. When set, this SDK call uses
 * this model instead of config.models.worker (mechanical scaffolding
 * sub-tasks -> cheaper/faster model). Undefined => config.models.worker.
 */
modelOverride, 
/**
 * beta.113: widen the phase-2 (stream-open -> first-token) watchdog for THIS
 * call only. The loop escalates it per retry attempt, because retrying a slow
 * start against an identical deadline just fails identically.
 */
firstTokenTimeoutSecondsOverride) {
    // rc.5: authorize generators for exactly the paths this sub-task owes. The
    // contract is derived with the SAME inference the verifier uses, so the set
    // the worker is told to produce cannot drift from the set it is judged on --
    // which is the drift that made the old contract impossible to satisfy.
    const generatorMap = resolveGenerators(deps.config.verify?.generators);
    const contractPaths = [
        ...inferVerifyContract(subTask)
            .map((c) => ("path" in c ? c.path : undefined))
            .filter((p) => typeof p === "string" && p.length > 0),
        ...(subTask.filesLikelyTouched ?? []),
    ];
    const systemPrompt = buildWorkerSystemPrompt(brief, subTask, authorizedGeneratorsForPaths(generatorMap, contractPaths));
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
            model: modelOverride?.trim() || deps.config.models.worker,
            permissionMode: deps.config.safety.worker_permission_mode,
            resumeSessionId,
            timeoutSeconds: deps.config.loop.worker_timeout_seconds,
            // beta.64 (P0-1) / beta.65 (P0): arm the split-phase watchdog on every
            // worker call. Phase 2 (stream-open -> first-token) default lowered to 30;
            // phase 1 (call-init -> stream-open) is the new beta.65 pre-stream cover.
            // beta.113: the loop widens this on a retry; see runWorkerCallWithRetry.
            firstTokenTimeoutSeconds: firstTokenTimeoutSecondsOverride ?? deps.config.loop.sdk_first_token_timeout_seconds ?? 30,
            streamOpenTimeoutSeconds: deps.config.loop.sdk_stream_open_timeout_seconds ?? 120,
            // beta.90 (Feature 2): stream-slow liveness. Threshold from config; the
            // callback (when supplied by the loop) surfaces loop.worker_stream_slow +
            // bumps the session heartbeat. Never aborts.
            onStreamSlow,
            streamIdleWarnSeconds: deps.config.loop.worker_stream_idle_warn_seconds ?? 90,
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
    const reconciled = await reconcileWorkerCommit(worktreePath, subTask, commitIdentity, deps, baseSha);
    const changed = reconciled.filesChanged;
    const commitSha = reconciled.commitSha;
    const commitShas = reconciled.commitShas;
    const uncommittedFiles = reconciled.reconciliation && reconciled.reconciliation.dirtyFiles.length > 0
        ? reconciled.reconciliation.dirtyFiles
        : undefined;
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
    const sdkStatus = sdkResult.stopReason === "first_token_timeout"
        ? "first_token_timeout"
        : sdkResult.stopReason === "timeout"
            ? "timeout"
            : sdkResult.stopReason === "end_turn"
                ? "completed"
                : "failed";
    // rc.3: a git call that actually errored is a failure of the turn, not a
    // quiet zero-commit `completed`. Before, `gitCommit` rejecting propagated out
    // of `runWorker` as an unhandled rejection and the sub-task died with no
    // stderr recorded anywhere.
    const gitFailed = reconciled.reconciliation?.state === "git_error";
    const status = gitFailed ? "failed" : sdkStatus;
    if (commitSha && !commitShas.includes(commitSha))
        commitShas.push(commitSha);
    return {
        status,
        filesChanged: changed,
        commitSha,
        commitShas,
        commitReconciliation: reconciled.reconciliation,
        sdkSessionId: sdkResult.sdkSessionId,
        costUsd: sdkResult.costUsd,
        tokensIn: sdkResult.tokensIn,
        tokensOut: sdkResult.tokensOut,
        reason: gitFailed
            ? `git_error: ${reconciled.reconciliation?.error ?? "unknown git failure"}`
            : sdkResult.stopReason,
        logsExcerpt: sdkResult.logsExcerpt,
        finalMessage: sdkResult.finalMessage,
        deniedToolCalls: sdkResult.deniedToolCalls,
        unguardedReads: sdkResult.unguardedReads,
        uncommittedFiles,
        streamOpened: sdkResult.streamOpened,
        msToFirstToken: sdkResult.msToFirstToken,
    };
}
/**
 * rc.3: decide what a worker turn actually did to git, and commit anything it
 * left behind.
 *
 * The old code asked one question -- `git diff --name-only <base> HEAD` -- and
 * branched the harness commit on the answer. That diff compares two COMMITS. A
 * worker that edited files and never committed leaves `base === HEAD`, so the
 * answer was empty and the harness skipped its own commit; the writes then went
 * down with the worktree and every downstream consumer was told the turn was a
 * no-op. Inverted, the same gate meant the harness only ever offered to commit
 * when the worker had ALREADY committed something.
 *
 * This asks the three questions that can actually distinguish the cases: HEAD
 * before, HEAD after, and `git status --porcelain`. See `WorkerCommitState`.
 *
 * Degradation: without `gitHeadSha` or `gitStatusPorcelain` (older injected
 * deps) there is no way to tell a dirty tree from a clean one, so the legacy
 * committed-range gate is used and `reconciliation` is left undefined --
 * "we did not classify" rather than a fabricated classification.
 */
async function reconcileWorkerCommit(worktreePath, subTask, commitIdentity, deps, baseSha) {
    const commitMessage = `harness(${subTask.seq}): ${subTask.title}`;
    const commitShas = [];
    const listCommitted = async () => {
        const diffed = await deps.gitListChangedFiles(worktreePath, baseSha);
        if (diffed.length > 0 || !deps.gitListCommittedFiles)
            return diffed;
        // beta.47/beta.95: several commits whose NET diff is empty still touched
        // files, and `file_committed` verifies against the touched set.
        return await deps.gitListCommittedFiles(worktreePath, baseSha);
    };
    if (!deps.gitHeadSha || !deps.gitStatusPorcelain || !baseSha) {
        const changed = await deps.gitListChangedFiles(worktreePath, baseSha);
        let commitSha;
        if (changed.length > 0) {
            commitSha = (await deps.gitCommit(worktreePath, commitMessage, commitIdentity)) ?? undefined;
        }
        if (!commitSha && deps.gitHeadSha && baseSha) {
            const head = await deps.gitHeadSha(worktreePath).catch(() => "");
            if (head && head !== baseSha)
                commitSha = head;
        }
        if (commitSha)
            commitShas.push(commitSha);
        return { filesChanged: commitSha ? await listCommitted() : changed, commitSha, commitShas };
    }
    let headAfterWorker;
    let dirtyBefore;
    try {
        headAfterWorker = await deps.gitHeadSha(worktreePath);
        dirtyBefore = await deps.gitStatusPorcelain(worktreePath);
    }
    catch (err) {
        return {
            filesChanged: [],
            commitShas,
            reconciliation: {
                state: "git_error",
                headBefore: baseSha,
                headAfter: baseSha,
                dirtyFiles: [],
                dirtyBefore: [],
                error: gitErrorText(err),
            },
        };
    }
    const workerAdvancedHead = Boolean(headAfterWorker) && headAfterWorker !== baseSha;
    // beta.103: record the worker's OWN tip before the harness commits on top of
    // it, so a turn that produced two commits leaves two ledger anchors.
    const workerCommitSha = workerAdvancedHead ? headAfterWorker : undefined;
    if (workerCommitSha)
        commitShas.push(workerCommitSha);
    let harnessCommitSha;
    if (dirtyBefore.length > 0) {
        try {
            harnessCommitSha = (await deps.gitCommit(worktreePath, commitMessage, commitIdentity)) ?? undefined;
        }
        catch (err) {
            return {
                filesChanged: workerAdvancedHead ? await listCommitted().catch(() => []) : [],
                commitSha: workerCommitSha,
                commitShas,
                reconciliation: {
                    state: "git_error",
                    headBefore: baseSha,
                    headAfter: headAfterWorker,
                    workerCommitSha,
                    dirtyFiles: dirtyBefore,
                    dirtyBefore,
                    error: gitErrorText(err),
                },
            };
        }
        if (harnessCommitSha)
            commitShas.push(harnessCommitSha);
    }
    // What is STILL dirty once the harness has had its turn. A tree that is dirty
    // here is the recoverable case: the files exist, nothing committed them, and
    // no caller may call this a no-change turn.
    let dirtyAfter;
    try {
        dirtyAfter = harnessCommitSha ? await deps.gitStatusPorcelain(worktreePath) : dirtyBefore;
    }
    catch {
        dirtyAfter = dirtyBefore;
    }
    const commitSha = harnessCommitSha ?? workerCommitSha;
    const state = harnessCommitSha
        ? workerAdvancedHead
            ? "worker_commit_remainder"
            : "harness_commit"
        : dirtyAfter.length > 0
            ? "uncommitted_changes"
            : workerAdvancedHead
                ? "worker_commit"
                : "no_change";
    return {
        filesChanged: commitSha ? await listCommitted() : [],
        commitSha,
        commitShas,
        reconciliation: {
            state,
            headBefore: baseSha,
            headAfter: harnessCommitSha ?? headAfterWorker,
            workerCommitSha,
            harnessCommitSha,
            dirtyFiles: dirtyAfter,
            dirtyBefore,
        },
    };
}
/**
 * Keep git's own words. A rejected `git commit` says why on stderr, and a
 * `String(err)` that drops it leaves the operator guessing between a hook, a
 * lock file and a signing failure.
 */
function gitErrorText(err) {
    const e = err;
    const parts = [e?.message, e?.stdout, e?.stderr]
        .map((p) => (typeof p === "string" ? p.trim() : ""))
        .filter(Boolean);
    const joined = parts.length > 0 ? Array.from(new Set(parts)).join("\n") : String(err);
    return joined.slice(0, 4000);
}
//# sourceMappingURL=worker.js.map