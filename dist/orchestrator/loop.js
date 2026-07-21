/**
 * Orchestrator loop.
 *
 * The core state machine. Given a session id (already row-inserted with a
 * crystallised prompt + brief), it walks:
 *
 *   crystallising -> planning -> executing -> reviewing -> {done|revise}
 *
 * Up to `config.loop.max_cycles` cycles of executing+reviewing. Early exits:
 *   - Adversary verdict "pass"
 *   - User ship-it reaction
 *   - User abort reaction
 *   - Session budget breached
 *   - Session hard timeout
 *
 * The loop is deliberately structured as pure decision helpers + an outer
 * driver, so `advance()` can be unit-tested standalone.
 */
import { estimateSubTaskCost } from "../adapters/claude-sdk.js";
import { deriveMergeRecommendation } from "./merge-recommendation.js";
/** beta.34: extract the PR number from a GitHub PR URL (.../pull/846). */
function parsePrNumber(prUrl) {
    const m = /\/pull\/(\d+)/.exec(prUrl) ?? /\/merge_requests\/(\d+)/.exec(prUrl);
    return m ? Number(m[1]) : undefined;
}
import { inferVerifyContract } from "./verify-contract.js";
import { verifySubTaskOutput } from "./verify.js";
/**
 * beta.38: module-level set of session ids whose loop is CURRENTLY running in
 * THIS process. The single source of truth for "is this session's loop alive?"
 *
 * WHY: `recoverSessions` runs on every plugin bootstrap. A plugin RE-REGISTER
 * (e.g. the OKF bundle-reindex churn) triggers bootstrap WITHOUT the process
 * dying -- so the previous generation's `loop.run()` may still be executing in
 * the background. Recovery, seeing a still-`executing` session, would assume
 * the process died and re-drive `loop.run()` -- spawning a SECOND concurrent
 * loop for the same session. That second loop's `git worktree add` then
 * collides with the first loop's still-live worktree (Staging ProjectThanos
 * smoke, session 36f53c40: `fatal: '<branch>' is already checked out at
 * '<pending-...>'` -> loop.plan_failed -> whole run killed after sub-task 1).
 *
 * This module-level set answers the question precisely: within one process
 * lifetime it tracks every live loop, so recovery can skip a session that is
 * still running. On a REAL process restart the module is re-instantiated fresh
 * (empty set), so recovery correctly auto-resumes genuinely-dead sessions.
 * It lives at module scope (not on the runtime instance) so it survives a
 * plugin re-register the same way `runtime-registry` does.
 */
const runningSessions = new Set();
/**
 * beta.52/53: detect a worker that ended its turn WAITING for a mid-turn event
 * that does not exist in the one-shot harness protocol. Two observed cases:
 *   beta.51 seq-3 (session fc64d8ea): "I'll await the Monitor event signaling
 *     tsc is ready rather than polling further." (one clause)
 *   beta.52 seq-5 (session 8464f8ae): "npm ci is still running. The Monitor
 *     will notify me when eslint is installed. Waiting for that event."
 *     (split across TWO sentences -- the beta.52 regex REQUIRED the wait-verb,
 *     the monitor/tool noun, and "event" within ONE clause ([^.\n] stops at the
 *     period) so it FALSE-NEGATIVED this variant, mis-tagging it as a generic
 *     refusal.)
 *
 * beta.53 (P1a) FIX: match on the DISTINCTIVE phrasings independently, then
 * require an environment/tool word ANYWHERE in the message. `PART_RE` catches
 * either half of the seq-5 split ("the Monitor will notify me", "waiting for
 * that event", "await ... event", "Monitor event"); `ENV_RE` confirms it is an
 * environment-wait hallucination (not some unrelated use of "event"). Both must
 * be present. `matchesEnvWaitHallucination` is the exported predicate; the bare
 * regex export is kept for backward-compat with the beta.52 test.
 */
const WORKER_ENV_WAIT_PART_RE = /\b(monitor|observer|watcher|sentinel)\s+(event|will\s+notify|notif)|will\s+notify\s+me|await(ing)?\s+(the\s+)?[^.\n]{0,40}\bevent\b|waiting\s+for\s+(that|the|an?)\s+[^.\n]{0,20}\b(event|signal|install|build|completion)\b|poll(ing)?\s+for\s+[^.\n]{0,40}\b(event|signal|ready)\b/i;
const WORKER_ENV_WAIT_ENV_RE = /\b(install(ing|ed)?|npm|npm\s+ci|yarn|pnpm|node_modules|tsc|typecheck|eslint|lint|build|compil)/i;
/** beta.53: true when the worker awaited a non-existent env/monitor event. */
export function matchesEnvWaitHallucination(text) {
    const t = (text ?? "").replace(/\s+/g, " ");
    return WORKER_ENV_WAIT_PART_RE.test(t) && WORKER_ENV_WAIT_ENV_RE.test(t);
}
/**
 * beta.54: BROADENED async-coordination-confabulation detector. beta.53's
 * `matchesEnvWaitHallucination` AND-gated on an install/build word, on the
 * (now-disproven) premise that this hallucination is triggered by a missing
 * environment. Staging beta.53 #858 seq-3 refuted that: on a plain TypeScript
 * mutate sub-task with NO install path, the worker still ended its turn with
 *   "I'll wait for the completion notification from the background watcher
 *    before running the test suite."
 * -- confabulating an async coordination primitive (a "background watcher" /
 * "completion notification") and yielding its turn instead of running the
 * command inline. The env word ('test suite' is not in ENV_RE) was absent, and
 * the phrase used 'wait for' (not 'waiting for'), so beta.53 missed it twice.
 *
 * This predicate captures the CLASS: the worker says it will wait/await for
 * some notification/event/signal/callback from an imagined watcher/monitor/
 * background process, WITHOUT requiring any env/install context. It is the
 * gate for the retry-with-context path (still restricted to no-side-effect
 * verification kinds, so a confabulated push/PR is never retried).
 *
 * Two independent shapes, either suffices:
 *  (A) an explicit coordination NOUN the harness does not provide
 *      (monitor/observer/watcher/sentinel/daemon/background process/
 *       completion notification/callback/webhook) paired with a wait/await/
 *       notify/resume verb; OR
 *  (B) a wait/await/poll verb pointed at an event/signal/notification/
 *      callback/completion the worker expects to ARRIVE (passive coordination).
 */
const ASYNC_COORD_NOUN_RE = /\b(monitor|observer|watcher|sentinel|daemon|background\s+(process|task|job|watcher|runner)|completion\s+(notification|signal|event|message)|async\s+(runner|process)|callback|webhook)\b/i;
const ASYNC_COORD_WAIT_VERB_RE = /\b(wait(ing|s)?\s+for|await(ing|s)?|poll(ing|s)?\s+for|listen(ing)?\s+for|expect(ing)?\s+(a|an|the)?)\b/i;
const ASYNC_COORD_ARRIVAL_RE = /\b(event|signal|notification|notify|callback|completion|ready\s+message|message\s+from|to\s+(complete|finish|be\s+(ready|done|installed|built)))\b/i;
/** beta.54: true when the worker confabulated an async coordination primitive. */
export function matchesAsyncCoordConfabulation(text) {
    const t = (text ?? "").replace(/\s+/g, " ");
    if (!t)
        return false;
    // Shape A: a coordination NOUN the harness never provides, near a wait verb.
    const hasNoun = ASYNC_COORD_NOUN_RE.test(t);
    const hasWaitVerb = ASYNC_COORD_WAIT_VERB_RE.test(t);
    if (hasNoun && hasWaitVerb)
        return true;
    // Shape B: a wait/await/poll verb aimed at an arriving event/signal/notif.
    if (hasWaitVerb && ASYNC_COORD_ARRIVAL_RE.test(t))
        return true;
    // Backward-compat: the original env-wait shape is a strict subset.
    return matchesEnvWaitHallucination(t);
}
/**
 * beta.53 (P1b): verification kinds that are eligible for an env-wait retry.
 * These are the "no observable change" kinds -- a worker that hallucinated a
 * wait produced no commit/no committed-file/wrote-but-didnt-commit. We NEVER
 * retry a confabulated push/PR (branch_pushed, pr_opened, ...): those aren't
 * env-wait shapes and retrying could mask a real confabulation.
 */
const ENV_WAIT_RETRYABLE_KINDS = new Set(["commit_made", "file_committed", "file_written"]);
/**
 * beta.58 (Bug B): distinguish a GOOD-FAITH premise-contradicted skip from a
 * bad-faith refusal. `loop.worker_refusal` conflated two opposite semantics:
 *  - beta.53 seq-3: worker hallucinated a background watcher, wrote nothing
 *    (bad-faith, genuine refusal).
 *  - beta.54/55 seq-2: worker correctly determined a CONDITIONAL PREMISE was
 *    contradicted per the brief's own rules and produced structured evidence
 *    (good-faith, a correct no-op).
 * Both produced identical `loop.worker_refusal` events. The discriminator
 * (Staging's pipe marker): the worker's explanation references a contradicted
 * premise / invalid finding. This is DIAGNOSTIC ONLY -- it does not change
 * pass/fail (the escalation-to-clarification path is unchanged); it just emits
 * a distinct, greppable audit event so operators can tell the two apart.
 */
const INVALID_PREMISE_RE = /\b(premise\s+(is\s+)?contradict|contradict\w*\s+(the\s+)?premise|premise\s+(is\s+)?(false|invalid|not\s+met|does\s+not\s+hold)|finding\s+(is\s+)?invalid|invalid\s*[:\-]?\s*premise|premise\s+not\s+satisfied|conditional\s+premise)/i;
export function matchesInvalidPremiseSkip(text) {
    const t = (text ?? "").replace(/\s+/g, " ");
    if (!t)
        return false;
    return INVALID_PREMISE_RE.test(t);
}
/**
 * beta.55 (B3): detect that a worker PASSED verification but deviated from the
 * literal sub-task wording -- a judgment call it made and documented (the #858
 * sub-task-2 grc case: "I left the non-empty grc/ dirs in place because deleting
 * them would destroy unrelated code"). This is guess-and-document, which is
 * defensible for an async harness ONLY if it's VISIBLE. We surface it as a
 * first-class `loop.worker_deviation` audit event instead of burying it in the
 * finalMessage prose. Does NOT change pass/fail (the sub-task passed).
 */
const WORKER_DEVIATION_RE = /\b(instead of|rather than|chose (not )?to|decided (not )?to|opted (not )?to|I (did not|didn't|left|kept|skipped|avoided)|deviat|as opposed to|in lieu of|preserv\w* (both|the existing)|took a different approach)\b/i;
export function matchesWorkerDeviation(text) {
    const t = (text ?? "").replace(/\s+/g, " ");
    if (!t)
        return false;
    return WORKER_DEVIATION_RE.test(t);
}
/** @deprecated beta.52 single-clause regex; kept for backward-compat tests. */
const WORKER_PROTOCOL_ASSUMPTION_RE = /\b(await|wait(ing)?\s+for|poll(ing)?\s+for)\b[^.\n]{0,80}\b(monitor|harness|install|build|tsc|ready|completion|background)\b[^.\n]{0,40}\b(event|signal|ready|notif|callback|complet)/i;
void WORKER_PROTOCOL_ASSUMPTION_RE;
/**
 * beta.56 (P0-1): render the previous cycle's adversary review as a corrective
 * dispatch hint for revise-cycle workers.
 *
 * ROOT CAUSE this fixes: on an `adversary_revise` verdict the loop re-ran the
 * SAME sub-task prompts verbatim -- `runWorker({brief, subTask, plan})` carried
 * no findings, so cycle 2 was cycle 1 replayed and the loop structurally could
 * not converge (the immortal-finding treadmill beta.44-49 patched around, the
 * beta.35 "revise no-op" carve-out, and the refusal spiral all trace here).
 * The worker on a revise cycle now sees verdict, summary, and the concrete
 * findings, scoped with an explicit "if none apply to your sub-task, change
 * nothing" instruction so the beta.35 legal-no-op path still works.
 */
export function buildReviseDispatchHint(review) {
    const all = review.findings ?? [];
    const actionable = all.filter((f) => f.severity !== "info");
    const shown = (actionable.length > 0 ? actionable : all).slice(0, 12);
    const lines = shown.map((f) => {
        const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
        return `- [${f.severity}/${f.dimension}] ${f.title}${loc}: ${f.detail}`.slice(0, 600);
    });
    return [
        `REVISION CYCLE: an adversarial reviewer examined the previous cycle's diff and returned verdict "${review.verdict}".`,
        `Reviewer summary: ${(review.summary ?? "").slice(0, 800)}`,
        lines.length > 0 ? `Outstanding findings:` : `(The reviewer returned no itemised findings.)`,
        ...lines,
        ``,
        `Address the findings that fall inside THIS sub-task's files/scope. If none of them apply to this sub-task, make NO changes and end your turn -- do not redo work that is already correct.`,
    ].join("\n");
}
/**
 * beta.42: active stall-watchdog timers, keyed by sessionId. When the
 * re-entrancy guard SKIPS a re-entry (`loop.run_skipped_already_running`), it
 * arms a timer here. beta.40's reclaim was PASSIVE -- it only re-evaluated
 * staleness when something re-called run(); a loop that wedged with no
 * subsequent re-register was never re-checked (Staging beta.40 smoke: session
 * 18a3f0a1 wedged ~5h30m, staleMs read 10 at skip time because updated_at had
 * just been written, and nothing ever re-called run() to notice it go stale).
 * The watchdog fixes that: it re-checks `updated_at` after a delay and, if the
 * tracked loop has made no progress, force-deregisters the stale handle so the
 * next recovery/run can reclaim it, and emits `loop.wedge_detected`.
 */
const stallWatchdogs = new Map();
/** Test/diagnostic helper: clear any armed watchdog for a session. */
export function clearStallWatchdog(sessionId) {
    const t = stallWatchdogs.get(sessionId);
    if (t) {
        clearTimeout(t);
        stallWatchdogs.delete(sessionId);
    }
}
/** True if a loop for this session is currently running in this process. */
export function isSessionLoopRunning(sessionId) {
    return runningSessions.has(sessionId);
}
/** Test/diagnostic helper: snapshot of currently-running session ids. */
export function runningSessionIds() {
    return [...runningSessions];
}
/**
 * beta.42: bound a promise by a timeout. The worker SDK call was previously
 * awaited with NO timeout (loop.ts runOne), so a hung worker (SDK socket
 * stall, or the runtime torn down under the await by a plugin re-register)
 * left the `await` unresolved forever -> the loop froze, `updated_at` stopped,
 * and the hard-deadline check (only evaluated BETWEEN sub-tasks) never ran.
 * That was the true root cause of the ~5h30m silent wedge on the beta.39 +
 * beta.40 ProjectThanos smokes. Racing the worker against a rejecting timeout
 * converts an infinite hang into a bounded, catchable failure that the loop's
 * existing try/catch already handles (marks the sub_task failed, sets
 * failed.err, returns). Returns a tuple so the caller can clear the timer.
 */
export class WorkerTimeoutError extends Error {
    seconds;
    constructor(seconds) {
        super(`worker exceeded worker_timeout_seconds (${seconds}s) with no result`);
        this.seconds = seconds;
        this.name = "WorkerTimeoutError";
    }
}
export async function withTimeout(p, seconds) {
    if (!(seconds > 0))
        return p; // 0/undefined disables the bound (defensive)
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new WorkerTimeoutError(seconds)), seconds * 1000);
    });
    try {
        return await Promise.race([p, timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export class OrchestratorLoop {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Pure state-transition rule (unit-tested).
     */
    static advance(input) {
        if (input.reactions.abort)
            return { nextStatus: "aborted", reason: "user_abort_reaction" };
        if (input.budgetExhausted)
            return { nextStatus: "aborted", reason: "budget_exhausted" };
        if (input.hardTimeout)
            return { nextStatus: "aborted", reason: "hard_timeout" };
        if (input.reactions.shipIt && input.currentStatus === "reviewing") {
            return { nextStatus: "done", reason: "user_ship_it_reaction" };
        }
        switch (input.currentStatus) {
            case "crystallising": return { nextStatus: "planning", reason: "crystallise_ok" };
            case "planning": return { nextStatus: "executing", reason: "plan_ready" };
            case "executing": return { nextStatus: "reviewing", reason: "subtasks_complete" };
            case "reviewing":
                if (input.verdict === "pass")
                    return { nextStatus: "done", reason: "adversary_pass" };
                if (input.verdict === "block")
                    return { nextStatus: "failed", reason: "adversary_block" };
                // beta.57 (P3): was `>= maxCycles - 1`, which shipped one cycle EARLY
                // (max_cycles: 3 ran only 2 execute/review cycles -- the check fired at
                // the END of cycle 2 with cyclesRan=2 >= 3-1). A config that promises N
                // cycles now runs N.
                if (input.cyclesRan >= input.maxCycles) {
                    // beta.35 fix #3: cycles exhausted with a `revise` (NOT `block`)
                    // verdict. `revise` means "improvable", not "broken" -- and on a
                    // repo with no in-loop preview-deploy the adversary structurally
                    // cannot reach `pass` on a UI change (it will always want runtime
                    // evidence it can't get). Rather than throwing away a correct fix
                    // (the old `max_cycles_reached` -> failed path), SHIP the PR with
                    // an honest "shipped without a clean pass" annotation in the body
                    // (renderPrBody #3). The post-ship merge recommendation is derived
                    // from `reachedCleanPass=false`, so it comes out `do_not_merge`
                    // (beta.34 hard gate): the PR exists, but a HUMAN must approve the
                    // merge (via harness_merge_pr, which will refuse and point to the
                    // GitHub UI, or via the UI directly) -- which is exactly the
                    // "you review, then tell me to merge and verify the deploy" flow.
                    // A `block` verdict never reaches here (returned above): a genuine
                    // blocking defect still hard-fails and ships nothing.
                    return { nextStatus: "done", reason: "shipped_max_cycles_revise" };
                }
                return { nextStatus: "executing", reason: "adversary_revise" };
            case "done":
            case "failed":
            case "aborted":
                return { nextStatus: input.currentStatus, reason: "terminal" };
            // beta.55 (B2): a resting pause. advance() never drives INTO or OUT of
            // this state (finaliseAwaitingClarification sets it directly; harness_
            // answer re-drives via loop.run from `planning`), but the switch must be
            // exhaustive -- staying put is the correct no-op.
            case "awaiting_clarification":
                return { nextStatus: input.currentStatus, reason: "awaiting_clarification" };
        }
    }
    setStatus(sessionId, status) {
        this.deps.state.db
            .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
            .run(status, Date.now(), sessionId);
    }
    checkpoint(sessionId, cycle, lastSubTask, sdkSessionId) {
        this.deps.state.db
            .prepare(`UPDATE sessions
         SET current_cycle = ?,
             last_completed_sub_task = COALESCE(?, last_completed_sub_task),
             last_worker_sdk_session = COALESCE(?, last_worker_sdk_session),
             last_checkpoint_at = ?,
             updated_at = ?
         WHERE id = ?`)
            .run(cycle, lastSubTask ?? null, sdkSessionId ?? null, Date.now(), Date.now(), sessionId);
    }
    addCost(sessionId, amount) {
        this.deps.state.db
            .prepare(`UPDATE sessions SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?`)
            .run(amount, Date.now(), sessionId);
    }
    saveReview(sessionId, cycle, report) {
        this.deps.state.db
            .prepare(`INSERT INTO reviews (id, session_id, cycle, verdict, findings, summary, cost_usd, sdk_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(`${sessionId}-r${cycle}`, sessionId, cycle, report.verdict, JSON.stringify(report.findings), report.summary, report.costUsd, report.sdkSessionId ?? null, Date.now());
    }
    /**
     * beta.38: re-entrancy guard. If a loop for this session is already running
     * in this process (plugin re-register mid-run), do NOT start a second one --
     * that races the live loop's worktree and kills the run. Return a distinct
     * `skipped_already_running` outcome so callers (recovery) can log-and-move-on.
     * The guard is registered/cleared here so EVERY entry path (fresh run and
     * recovery auto-resume both call `run()`) is covered and can't be forgotten.
     */
    async run(sessionId, brief) {
        if (runningSessions.has(sessionId)) {
            // beta.40: the guard entry exists -- but is the tracked loop actually
            // ALIVE, or a zombie? `runningSessions` is module-scoped and survives a
            // plugin re-register, but the loop it tracks can be torn down WITH the
            // old runtime on re-register. Staging beta.39 smoke (session 07e4c28a):
            // the guard fired at 11:05:26, then the original loop went silent for
            // 110 min -- the guard permanently blocked recovery from reclaiming a
            // dead loop. So: if the session's last progress (checkpoint / updated_at)
            // is stale beyond `stuck_loop_seconds`, treat the tracked loop as dead,
            // force-clear the stale guard entry, and proceed with THIS run. The
            // threshold is safely larger than a normal long worker SDK call, so a
            // legitimately-busy loop is never reclaimed.
            const prog = this.deps.state.db
                .prepare(`SELECT cycles_ran, cost_usd, last_checkpoint_at, updated_at FROM sessions WHERE id = ?`)
                .get(sessionId);
            const lastProgressMs = Math.max(prog?.last_checkpoint_at ?? 0, prog?.updated_at ?? 0);
            const staleMs = Date.now() - lastProgressMs;
            const stuckThresholdMs = (this.deps.config.loop.stuck_loop_seconds ?? 2700) * 1000;
            const isStuck = lastProgressMs > 0 && staleMs > stuckThresholdMs;
            if (!isStuck) {
                // Live loop (or fresh enough to be presumed live): skip the re-entry.
                this.deps.state.audit("loop.run_skipped_already_running", { sessionId, reason: "a loop for this session is already running in this process", staleMs }, sessionId);
                this.deps.logger.warn("[loop] run() skipped: session loop already running (re-entrant call)", { sessionId, staleMs });
                // beta.42: arm an ACTIVE stall-watchdog. beta.40's reclaim was passive
                // (only re-checked on a subsequent run() call); a wedge with no further
                // re-register was never noticed. Re-check `updated_at` after
                // stall_watchdog_seconds; if the tracked loop made no progress,
                // force-deregister its stale handle so recovery/next-run can reclaim it.
                this.armStallWatchdog(sessionId, lastProgressMs);
                return {
                    status: "skipped_already_running",
                    sessionId,
                    reason: "loop already running in this process",
                    cycles: prog?.cycles_ran ?? 0,
                    totalCostUsd: prog?.cost_usd ?? 0,
                };
            }
            // Zombie loop: reclaim it.
            this.deps.state.audit("loop.run_reclaimed_stuck", {
                sessionId,
                reason: "tracked loop made no progress past stuck_loop_seconds; force-clearing stale guard and re-driving",
                staleMs,
                stuckThresholdMs,
            }, sessionId);
            this.deps.logger.warn("[loop] reclaiming stuck loop (no progress past stuck_loop_seconds); force-clearing guard and restarting", { sessionId, staleMs, stuckThresholdMs });
            runningSessions.delete(sessionId);
        }
        runningSessions.add(sessionId);
        this.ownedSessions.add(sessionId);
        clearStallWatchdog(sessionId); // a live loop is (re)taking ownership
        try {
            return await this.runInner(sessionId, brief);
        }
        finally {
            runningSessions.delete(sessionId);
            this.ownedSessions.delete(sessionId);
            clearStallWatchdog(sessionId);
        }
    }
    /**
     * beta.57 (P1): sessions whose loop THIS OrchestratorLoop instance is
     * currently driving. The module-scoped `runningSessions` registry is shared
     * across runtimes (it deliberately survives a plugin re-register), so a
     * teardown that drains on it waits for OTHER runtimes' loops too -- on a
     * re-register churn the doomed runtime could block up to
     * teardown_drain_seconds for a session it does not own and whose DB handle
     * it is not holding. Teardown should drain only on sessions it owns.
     */
    ownedSessions = new Set();
    ownedRunningSessionIds() {
        return [...this.ownedSessions];
    }
    /**
     * beta.60: instance accessor for the module-level re-entrancy guard set (all
     * in-process running loops, across runtime generations). Used by
     * harness_resume force-unstick to REFUSE unsticking a session that still has
     * a live loop-runner tracked -- so we never yank a genuinely-busy loop out
     * from under itself. A session that wedged with a dead executor will NOT be
     * in this set once the stall-watchdog/reclaim cleared its handle (or if the
     * runtime that ran it was torn down), which is exactly when force is safe.
     */
    runningSessionIds() {
        return runningSessionIds();
    }
    /**
     * beta.42: arm an active stall-watchdog for a session whose re-entry the
     * guard just skipped. After `loop.stall_watchdog_seconds`, re-read the
     * session's progress; if it has NOT advanced past `lastProgressMs` AND the
     * guard entry is still present, the tracked loop is wedged with no external
     * re-entry to reclaim it -- force-deregister the stale handle (so the next
     * recovery/run reclaims it) and emit `loop.wedge_detected`. Idempotent: an
     * existing timer for the session is replaced.
     */
    armStallWatchdog(sessionId, lastProgressMs) {
        const seconds = this.deps.config.loop.stall_watchdog_seconds ?? 90;
        if (!(seconds > 0))
            return;
        clearStallWatchdog(sessionId);
        const timer = setTimeout(() => {
            stallWatchdogs.delete(sessionId);
            try {
                if (!runningSessions.has(sessionId))
                    return; // loop finished/reclaimed already
                const prog = this.deps.state.db
                    .prepare(`SELECT last_checkpoint_at, updated_at FROM sessions WHERE id = ?`)
                    .get(sessionId);
                const nowProgress = Math.max(prog?.last_checkpoint_at ?? 0, prog?.updated_at ?? 0);
                if (nowProgress > lastProgressMs)
                    return; // progressed -- healthy, no action
                // No forward progress since the skip: the tracked loop is wedged and
                // nothing re-entered to reclaim it. Force-deregister so recovery/next
                // run can take over.
                runningSessions.delete(sessionId);
                this.deps.state.audit("loop.wedge_detected", {
                    sessionId,
                    reason: "no forward progress after run_skipped_already_running; stale guard handle force-deregistered",
                    stallWatchdogSeconds: seconds,
                    lastProgressMs,
                }, sessionId);
                this.deps.logger.warn("[loop] wedge detected: stale guard handle force-deregistered by stall-watchdog", {
                    sessionId,
                    stallWatchdogSeconds: seconds,
                });
            }
            catch (err) {
                this.deps.logger.warn("[loop] stall-watchdog check failed", { sessionId, err: String(err) });
            }
        }, seconds * 1000);
        // Don't keep the process alive solely for this timer.
        if (typeof timer.unref === "function")
            timer.unref();
        stallWatchdogs.set(sessionId, timer);
    }
    async runInner(sessionId, brief) {
        const row = this.deps.state.db
            .prepare(`SELECT id, requester, cost_usd, budget_usd, cycles_ran, status FROM sessions WHERE id = ?`)
            .get(sessionId);
        if (!row)
            throw new Error(`session ${sessionId} not found`);
        if (["done", "failed", "aborted"].includes(row.status)) {
            throw new Error(`session ${sessionId} is already terminal (${row.status})`);
        }
        const startedAt = Date.now();
        const hardDeadlineMs = startedAt + this.deps.config.loop.session_hard_timeout_seconds * 1000;
        this.deps.state.audit("loop.start", { sessionId, brief }, sessionId);
        // 1. Planning
        this.setStatus(sessionId, "planning");
        await this.deps.reportProgress?.(sessionId, "planning");
        let plan;
        try {
            // beta.43: bound the lead-planner SDK call by lead_timeout_seconds. The
            // lead await was UNBOUNDED (beta.42 only bounded the worker). A hung
            // planner froze the run with no timeout -- and a healthy long plan was
            // indistinguishable from a wedge, which is exactly what caused the
            // beta.42 smoke misdiagnosis.
            plan = await withTimeout(this.deps.runLead(brief, { requester: row.requester }), this.deps.config.loop.lead_timeout_seconds);
            this.deps.state.db
                .prepare(`UPDATE sessions SET lead_plan_json = ?, repo = ?, branch = ?, worktree_path = ? WHERE id = ?`)
                .run(JSON.stringify(plan), plan.repo, plan.branch, plan.worktreePath, sessionId);
            this.deps.state.audit("loop.plan_ready", { sessionId, subTasks: plan.subTasks.length, risk: plan.riskLevel }, sessionId);
        }
        catch (err) {
            if (err instanceof WorkerTimeoutError) {
                this.deps.state.audit("loop.lead_timeout", { sessionId, lead_timeout_seconds: this.deps.config.loop.lead_timeout_seconds }, sessionId);
            }
            this.deps.state.audit("loop.plan_failed", { sessionId, err: String(err) }, sessionId);
            return this.finaliseFailed(sessionId, `plan_failed: ${String(err)}`, 0, row.cost_usd);
        }
        let cycle = 0;
        let totalCost = row.cost_usd;
        let lastReview;
        // beta.7 fix #2: running record of actual sub-task costs, used to project
        // the cost of upcoming sub-tasks for pre-execution budget gating.
        const subTaskCosts = [];
        // 2. Execute/review cycles
        while (cycle < this.deps.config.loop.max_cycles) {
            cycle += 1;
            this.deps.state.db.prepare(`UPDATE sessions SET cycles_ran = ? WHERE id = ?`).run(cycle, sessionId);
            this.checkpoint(sessionId, cycle);
            // 2a. Executing sub-tasks in dependency order, with bounded concurrency.
            this.setStatus(sessionId, "executing");
            await this.deps.reportProgress?.(sessionId, "executing", { cycle });
            const ordered = topoSortSubTasks(plan.subTasks);
            const concurrency = Math.max(1, this.deps.config.loop.subtask_concurrency ?? 1);
            const inFlight = [];
            const done = new Set();
            const failed = { seq: -1, err: null };
            // beta.55 (B2): when set, the loop pauses in `awaiting_clarification`
            // instead of hard-failing. Carries the ONE question to surface + the
            // paused seq. Checked BEFORE finaliseFailed so the worktree is preserved.
            const clarify = { question: null, seq: -1, subtask: null };
            const runOne = async (st) => {
                // beta.53 (P1b): at most ONE env-wait retry per sub-task.
                let envWaitRetried = false;
                // beta.56 (P0-1): on a revise cycle, the worker MUST see the previous
                // review's findings or it will simply replay cycle 1's work.
                const reviseHint = cycle > 1 && lastReview ? buildReviseDispatchHint(lastReview) : undefined;
                const reactions = await this.deps.readReactions(sessionId);
                if (reactions.abort) {
                    failed.err = "user_abort_reaction";
                    failed.seq = st.seq;
                    return;
                }
                if (Date.now() > hardDeadlineMs) {
                    failed.err = "hard_timeout";
                    failed.seq = st.seq;
                    return;
                }
                if (totalCost > row.budget_usd && !reactions.budgetBump) {
                    failed.err = "budget_exhausted";
                    failed.seq = st.seq;
                    return;
                }
                // beta.7 fix #2: PROJECTED-cost gating. Don't start a sub-task we
                // can't afford. Project = running total + estimated cost of THIS
                // sub-task (from the plan's token estimate, or the running median of
                // actual sub-task costs so far). Abort before burning spend instead
                // of the old post-hoc check that let a $1 budget balloon to $2.10.
                if (!reactions.budgetBump) {
                    const projected = totalCost + this.estimateSubTaskCost(st, subTaskCosts);
                    if (projected > row.budget_usd) {
                        this.deps.state.audit("loop.budget_projection_abort", { sessionId, seq: st.seq, totalCost, projected, budget: row.budget_usd }, sessionId);
                        failed.err = "budget_exhausted";
                        failed.seq = st.seq;
                        return;
                    }
                }
                const subTaskId = `${sessionId}-c${cycle}-s${st.seq}`;
                // beta.19 fix: populate `started_at` on insert. The schema has
                // had this column since inception but nothing wrote to it, so
                // every sub_task row had `started_at IS NULL`. Now set it to the
                // same instant as `created_at` — for restart / recovery paths
                // (INSERT OR REPLACE) this deliberately overwrites any earlier
                // start time, which matches the previous cycle semantics (a
                // re-executed sub-task started NOW, not when it was first
                // scheduled).
                {
                    const now = Date.now();
                    this.deps.state.db.prepare(`INSERT OR REPLACE INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, cost_usd, started_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?, ?)`).run(subTaskId, sessionId, cycle, st.seq, st.title, this.deps.config.models.worker, now, now, now);
                }
                // Capture the worktree HEAD BEFORE the worker runs, so commit_made
                // verification (HEAD != base) is meaningful.
                const subTaskBaseSha = this.deps.worktreeHeadSha ? await this.deps.worktreeHeadSha(plan.worktreePath).catch(() => "") : "";
                // beta.57 (P1): capture the sub-task start time so file_written can
                // reject a file that merely pre-existed (mtime/diff freshness check).
                // Previously hard-coded to 0, which disabled the freshness check and
                // let a stale file vacuously satisfy the contract.
                const subTaskStartedAtMs = Date.now();
                let result;
                try {
                    // beta.42: bound the worker SDK call by worker_timeout_seconds. Without
                    // this, a hung worker await never resolves and wedges the whole loop
                    // silently (no timeout fires -- the hard-deadline check only runs
                    // between sub-tasks). A timeout here rejects, and the existing catch
                    // marks the sub_task failed + fails the run cleanly.
                    result = await withTimeout(this.deps.runWorker({ brief, subTask: st, plan, requester: row.requester, dispatchHint: reviseHint }), this.deps.config.loop.worker_timeout_seconds);
                }
                catch (err) {
                    const isTimeout = err instanceof WorkerTimeoutError;
                    this.deps.state.db.prepare(`UPDATE sub_tasks SET status = 'failed', summary = ?, updated_at = ? WHERE id = ?`).run(`worker threw: ${String(err)}`, Date.now(), subTaskId);
                    if (isTimeout) {
                        this.deps.state.audit("loop.worker_timeout", { sessionId, seq: st.seq, worker_timeout_seconds: this.deps.config.loop.worker_timeout_seconds }, sessionId);
                    }
                    failed.err = isTimeout ? `worker_timeout: ${String(err)}` : `worker_error: ${String(err)}`;
                    failed.seq = st.seq;
                    return;
                }
                totalCost += result.costUsd;
                if (result.costUsd > 0)
                    subTaskCosts.push(result.costUsd);
                this.addCost(sessionId, result.costUsd);
                await this.deps.budget.recordSpend(row.requester, result.costUsd, sessionId);
                this.deps.state.db.prepare(`UPDATE sub_tasks
           SET status = ?, cost_usd = ?, files_touched = ?, commit_sha = ?, sdk_session_id = ?, summary = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`).run(result.status, result.costUsd, JSON.stringify(result.filesChanged), result.commitSha ?? null, result.sdkSessionId ?? null, result.reason ?? null, Date.now(), Date.now(), subTaskId);
                this.checkpoint(sessionId, cycle, subTaskId, result.sdkSessionId);
                // beta.48 (C1): always emit the worker's final message as a
                // breadcrumb, on EVERY sub-task (not just failures). This eliminates
                // the "opaque worker turn" blind spot (session dca2f3b5) where a
                // zero-side-effect end_turn was indistinguishable from a crash in the
                // harness log. Truncated; empty string when the worker produced only
                // tool calls and no concluding text.
                {
                    const fm = (result.finalMessage ?? "").trim();
                    this.deps.state.audit("loop.worker_end_turn", {
                        sessionId,
                        seq: st.seq,
                        cycle,
                        status: result.status,
                        commitSha: result.commitSha ?? null,
                        filesTouched: result.filesChanged,
                        hasFinalMessage: fm.length > 0,
                        finalMessage: fm.slice(0, 4000),
                    }, sessionId);
                }
                // If the worker itself failed/timed out, halt now.
                if (result.status !== "completed") {
                    failed.err = `subtask_${st.seq}_${result.status}: ${result.reason ?? "no reason"}`;
                    failed.seq = st.seq;
                    return;
                }
                // ---- beta.8 fix #1: HARNESS-SIDE verification ----
                // Regardless of the worker's `end_turn: completed`, the harness
                // independently verifies any observable side-effect the sub-task
                // CLAIMS (inferred from its own language, not from the model). This
                // is what catches a confabulated "I pushed / I opened a PR": we hit
                // git / the provider API ourselves. Runs even for `completed`.
                const contract = inferVerifyContract(st);
                if (contract.length > 0 && this.deps.buildVerifyProbes) {
                    const probes = this.deps.buildVerifyProbes({
                        plan, requester: row.requester, worktreePath: plan.worktreePath, baseSha: subTaskBaseSha,
                    });
                    const branchHint = contract.reduce((acc, v) => (v.kind === "branch_pushed" && v.branch ? v.branch : acc), plan.branch);
                    let verification;
                    try {
                        verification = await verifySubTaskOutput(contract, { defaultBranch: branchHint, subTaskStartMs: subTaskStartedAtMs, baseSha: subTaskBaseSha }, probes);
                    }
                    catch (err) {
                        // A probe error is a verification FAILURE, not a pass. Never let
                        // an exception silently green-light a confabulated success.
                        verification = { ok: false, results: [], summary: `probe error: ${String(err)}` };
                    }
                    this.deps.state.audit("loop.subtask_verification", { sessionId, seq: st.seq, ok: verification.ok, contract, summary: verification.summary, results: verification.results }, sessionId);
                    // beta.16 fix #2: also emit the observe-mode breadcrumb when
                    // taskMode is 'observe' and verification passed. Keeps the audit
                    // stream self-describing on observe sub-tasks (previously silent
                    // because verify:[] means no checks fire, and inference filters
                    // out mutation-scope kinds).
                    if (verification.ok && (st.taskMode === "observe" || (contract.length === 0 && st.taskMode !== "mutate"))) {
                        this.emitObserveCompleted(sessionId, st, result, contract);
                    }
                    if (!verification.ok) {
                        // ---- beta.53 (P1b): retry-with-context on an env-wait hallucination ----
                        // Staging beta.52 #858 seq-5: the worker WROTE the aria-label edit
                        // (1145 bytes on disk) but never committed, then ended its turn with
                        // "npm ci is still running. The Monitor will notify me when eslint is
                        // installed. Waiting for that event." -- awaiting a mid-turn event
                        // that does not exist. Rather than terminate the whole run on a
                        // recoverable, well-understood hallucination, re-invoke the sub-task
                        // ONCE with corrective context. Because P2 now captures
                        // `uncommittedFiles`, we can branch the hint: for a PARTIAL-work turn
                        // (wrote-but-didn't-commit) the fix is nearly free -- "you already
                        // wrote X, just commit it"; for a ZERO-work turn -- "there is no such
                        // event, do the work now, skip env verification if the tool is
                        // missing". If the retry ALSO hallucinates (or otherwise fails
                        // verification) we fall through to the normal terminal handling.
                        const failedNow = verification.results.filter((x) => !x.passed);
                        // beta.57 (P1): the retry trigger is now the OBSERVABLE STATE
                        // INVARIANT, not the worker's phrasing. beta.52->53->54 each widened
                        // a prose regex after a new wording escaped it; the state we
                        // actually care about is directly checkable: a mutate-shaped
                        // sub-task ended its turn with NO commit and ONLY local no-change
                        // kinds failing. On cycle 1 that is never a legal outcome, so the
                        // one-shot corrective retry fires unconditionally. On revise cycles
                        // (cycle > 1) a no-commit turn IS often legal (the beta.35 no-op
                        // downgrade below), so there the regex remains as the tiebreaker
                        // between "legal nothing-to-do" and "confabulated wait".
                        const phrasingMatched = matchesAsyncCoordConfabulation(result.finalMessage ?? "");
                        const envWaitOnly = !envWaitRetried &&
                            this.deps.config.loop.env_wait_retry_enabled !== false &&
                            !result.commitSha &&
                            failedNow.length > 0 &&
                            failedNow.every((x) => ENV_WAIT_RETRYABLE_KINDS.has(x.kind)) &&
                            (cycle === 1 || phrasingMatched);
                        if (envWaitOnly) {
                            envWaitRetried = true;
                            const wrote = result.uncommittedFiles ?? [];
                            const hint = wrote.length > 0
                                ? `IMPORTANT: your PREVIOUS turn wrote these files to the worktree but never committed them: ${wrote.join(", ")}. There is NO background watcher, NO "Monitor event", NO completion notification, and NO event stream -- harness dispatch is one-shot and NOTHING will ever notify or resume you. Do NOT wait for any install/build/lint/test to "notify" you. Simply \`git add\` and \`git commit\` the work you already did, complete any remaining success criteria INLINE (run any command -- including the test suite, tsc, or lint -- directly in a single BLOCKING Bash call and read its output in THIS turn; or skip a missing tool and note it in the commit message), and end your turn.`
                                : `IMPORTANT: your PREVIOUS turn ended waiting for something that does not exist (a "Monitor event", a "background watcher", a "completion notification", or similar). The harness has NO such mechanism -- dispatch is one-shot and nothing will notify or resume you. Complete this sub-task NOW without waiting for anything. To run tests/build/lint/install, execute the command DIRECTLY in a single blocking Bash call in THIS turn and read its output; do not background it and do not wait for a signal. If a tool (eslint/tsc/lint) is not installed, run \`npm ci\` INLINE first, OR skip that step and note it in the commit message. Make the required edit, commit it, and end your turn.`;
                            this.deps.state.audit("loop.worker_env_wait_retry", {
                                sessionId, seq: st.seq, cycle,
                                partialWork: wrote.length > 0,
                                uncommittedFiles: wrote,
                                // beta.57: the regex is now telemetry, not the gate.
                                phrasingMatched,
                                priorFinalMessage: (result.finalMessage ?? "").slice(0, 500),
                            }, sessionId);
                            this.deps.logger.warn("[loop] env-wait hallucination detected; retrying sub-task once with corrective context", {
                                sessionId, seq: st.seq, partialWork: wrote.length > 0,
                            });
                            try {
                                const retry = await withTimeout(this.deps.runWorker({
                                    brief, subTask: st, plan, requester: row.requester,
                                    // Compose the revise context (if any) with the corrective hint.
                                    dispatchHint: reviseHint ? `${reviseHint}\n\n${hint}` : hint,
                                }), this.deps.config.loop.worker_timeout_seconds);
                                this.addCost(sessionId, retry.costUsd);
                                await this.deps.budget.recordSpend(row.requester, retry.costUsd, sessionId);
                                totalCost += retry.costUsd;
                                if (retry.costUsd > 0)
                                    subTaskCosts.push(retry.costUsd);
                                let retryVerification;
                                try {
                                    const retryProbes = this.deps.buildVerifyProbes({
                                        plan, requester: row.requester, worktreePath: plan.worktreePath, baseSha: subTaskBaseSha,
                                    });
                                    retryVerification = await verifySubTaskOutput(contract, { defaultBranch: branchHint, subTaskStartMs: subTaskStartedAtMs, baseSha: subTaskBaseSha }, retryProbes);
                                }
                                catch (err) {
                                    retryVerification = { ok: false, results: [], summary: `probe error: ${String(err)}` };
                                }
                                this.deps.state.audit("loop.subtask_verification", { sessionId, seq: st.seq, ok: retryVerification.ok, contract, summary: retryVerification.summary, results: retryVerification.results, retry: true }, sessionId);
                                if (retryVerification.ok) {
                                    this.deps.state.db.prepare(`UPDATE sub_tasks SET status = ?, cost_usd = cost_usd + ?, files_touched = ?, commit_sha = ?, sdk_session_id = ?, summary = ?, completed_at = ?, updated_at = ? WHERE id = ?`).run(retry.status, retry.costUsd, JSON.stringify(retry.filesChanged), retry.commitSha ?? null, retry.sdkSessionId ?? null, `env-wait retry succeeded: ${retryVerification.summary}`, Date.now(), Date.now(), subTaskId);
                                    this.checkpoint(sessionId, cycle, subTaskId, retry.sdkSessionId);
                                    this.deps.logger.info("[loop] env-wait retry SUCCEEDED", { sessionId, seq: st.seq });
                                    done.add(st.seq);
                                    return;
                                }
                                // Retry also failed verification -> fall through using the
                                // retry's result/verification so the terminal report reflects
                                // the second attempt.
                                this.deps.logger.warn("[loop] env-wait retry FAILED verification; terminating", {
                                    sessionId, seq: st.seq, summary: retryVerification.summary,
                                });
                                result = retry;
                                verification = retryVerification;
                            }
                            catch (err) {
                                this.deps.logger.warn("[loop] env-wait retry threw; terminating", { sessionId, seq: st.seq, err: String(err) });
                                // keep original result/verification; fall through to terminal.
                            }
                        }
                        // ---- beta.35 fix #1 + #2: legal no-op on a REVISE cycle ----
                        // On a revise cycle (cycle > 1) the plan's mutate sub-task is
                        // re-run against a base = the worker's current HEAD (the commit it
                        // already produced on cycle 1). If the worker correctly concludes
                        // there is nothing to change (the code already satisfies the
                        // criteria; the adversary's revise findings were about runtime
                        // evidence / PR-description text / accepted nits), it ends with
                        // `end_turn` and NO new commit. The old code then failed the
                        // `commit_made` contract (HEAD == base) and killed the whole
                        // session -- even though the fix was already correct.
                        //
                        // A revise cycle that makes no change is a VALID outcome. So: if
                        // this is a revise cycle, the worker completed cleanly, and the
                        // ONLY failing checks are the "no new commit / no new file change"
                        // kinds (i.e. the effective task-mode is 'observe' for this pass,
                        // #2), downgrade the sub-task to `completed_no_change` and let the
                        // loop proceed to ship. Any OTHER kind of failure (a real
                        // confabulation: claimed a push/PR that didn't happen, wrote a
                        // file that isn't there) still hard-fails -- we do NOT weaken the
                        // trust-but-verify guarantee.
                        const NO_CHANGE_KINDS = new Set(["commit_made", "file_committed", "file_written"]);
                        const failedResults = verification.results.filter((x) => !x.passed);
                        const onlyNoChangeFailures = failedResults.length > 0 &&
                            failedResults.every((x) => NO_CHANGE_KINDS.has(x.kind));
                        const workerMadeNoCommit = !result.commitSha; // worker itself reports no commit
                        if (cycle > 1 && onlyNoChangeFailures && workerMadeNoCommit) {
                            this.deps.state.db.prepare(`UPDATE sub_tasks SET status = 'completed_no_change', summary = ?, updated_at = ? WHERE id = ?`).run(`revise no-op: worker made no change (${verification.summary}); code already satisfies criteria`, Date.now(), subTaskId);
                            this.deps.state.audit("loop.subtask_revise_no_change", {
                                sessionId,
                                seq: st.seq,
                                cycle,
                                taskMode: st.taskMode ?? "unspecified",
                                effectiveTaskMode: "observe",
                                baseRef: subTaskBaseSha ? subTaskBaseSha.slice(0, 12) : "(unknown)",
                                failedKinds: failedResults.map((x) => x.kind),
                                summary: verification.summary,
                            }, sessionId);
                            this.deps.logger.info("[loop] revise cycle no-op accepted (worker had nothing to change)", {
                                sessionId, seq: st.seq, cycle,
                            });
                            done.add(st.seq);
                            return;
                        }
                        // Emit per-kind failure events so failures are greppable and
                        // operators can debug from audit alone.
                        // beta.9: new specific events + backward-compat old event names
                        // both fire so consumers watching old names keep working.
                        for (const r of verification.results.filter((x) => !x.passed)) {
                            // beta.15: include base_ref on commit/file_committed audit events
                            // for debugging clarity. The commit_made check compares HEAD vs
                            // the worker-session-start SHA (`subTaskBaseSha`), not the
                            // branch base. Making this explicit in the audit payload lets
                            // operators tell the difference between "worker didn't commit"
                            // and "no new commits since sub-task started, which is correct
                            // for observation-only sub-tasks".
                            const baseRef = (r.kind === "commit_made" || r.kind === "file_committed")
                                ? { baseRef: subTaskBaseSha ? subTaskBaseSha.slice(0, 12) : "(unknown)", baseSemantics: "worker-session-start" }
                                : {};
                            const payload = { sessionId, seq: st.seq, detail: r.detail, ...baseRef };
                            switch (r.kind) {
                                case "branch_pushed":
                                    // beta.10: fire ONLY the backward-compat name here. The
                                    // beta.9+ contract inference already emits
                                    // `remote_branch_exists` alongside `branch_pushed` for push
                                    // sub-tasks, and that kind fires `remote_branch_verify_failed`
                                    // on its own case. Firing both here caused duplicate
                                    // `remote_branch_verify_failed` events on the beta.10
                                    // smoke test (one from `branch_pushed` -> HTTP 404, one
                                    // from `remote_branch_exists` -> ls-remote empty).
                                    this.deps.state.audit("loop.push_verify_failed", payload, sessionId);
                                    break;
                                case "remote_branch_exists":
                                    this.deps.state.audit("loop.remote_branch_verify_failed", payload, sessionId);
                                    break;
                                case "commit_sha_matches":
                                    this.deps.state.audit("loop.commit_sha_verify_failed", payload, sessionId);
                                    break;
                                case "pr_opened":
                                    this.deps.state.audit("loop.pr_verify_failed", payload, sessionId);
                                    break;
                                case "pr_state":
                                    // backward compat: also fire old pr_verify_failed
                                    this.deps.state.audit("loop.pr_verify_failed", payload, sessionId);
                                    this.deps.state.audit("loop.pr_state_verify_failed", payload, sessionId);
                                    break;
                                case "file_written":
                                    // backward compat name
                                    this.deps.state.audit("loop.file_verify_failed", payload, sessionId);
                                    // new specific name
                                    this.deps.state.audit("loop.file_written_verify_failed", payload, sessionId);
                                    break;
                                case "file_committed":
                                    this.deps.state.audit("loop.file_committed_verify_failed", payload, sessionId);
                                    break;
                                case "file_pushed":
                                    this.deps.state.audit("loop.file_pushed_verify_failed", payload, sessionId);
                                    break;
                                case "file_in_pr":
                                    this.deps.state.audit("loop.file_in_pr_verify_failed", payload, sessionId);
                                    break;
                                case "commit_made":
                                    // backward compat name
                                    this.deps.state.audit("loop.commit_verify_failed", payload, sessionId);
                                    break;
                                default:
                                    // fallback for any future kinds
                                    this.deps.state.audit("loop.verify_failed", { ...payload, kind: r.kind }, sessionId);
                            }
                        }
                        // ---- beta.48 (C1 + C2): reasoned-refusal observability ----
                        // Session dca2f3b5 (beta.47 revise of #858) exposed a blind spot:
                        // a worker can end its turn with `end_turn` + ZERO filesystem
                        // side-effects because it made a REASONED REFUSAL (e.g. "the
                        // sub-task's premise is factually false, renaming would regress
                        // the repo"). The harness saw "0/N checks passed, worker did
                        // nothing" and terminated, throwing away the worker's structured
                        // explanation. The refusal was CORRECT but invisible. Detect the
                        // shape (every failing check is a no-change kind AND the worker
                        // made no commit AND it left a non-empty final message) and
                        // surface that message so operators/downstream see WHY, instead
                        // of an opaque empty turn. NOTE: this does NOT change the pass/
                        // fail decision (the sub-task still fails verification) -- it only
                        // makes the reason observable. We deliberately do NOT auto-accept
                        // the refusal: a worker refusing on a false premise is a signal
                        // that an UPSTREAM artefact (adversary finding / brief) was wrong,
                        // which a human or a future replan loop should resolve.
                        const NO_CHANGE_ONLY = failedResults.length > 0 && failedResults.every((x) => NO_CHANGE_KINDS.has(x.kind));
                        const refusalText = (result.finalMessage ?? "").trim();
                        const looksLikeRefusal = NO_CHANGE_ONLY && !result.commitSha && refusalText.length > 0;
                        // ---- beta.52: distinguish a PROTOCOL-ASSUMPTION failure from a
                        // reasoned refusal. Session fc64d8ea (beta.51 revise of #858) sub-
                        // task 3: the worker ended its turn with 24 words -- "The install
                        // is still completing. I'll await the Monitor event signaling tsc
                        // is ready rather than polling further." -- and ZERO side-effects.
                        // That is NOT a reasoned refusal (it did not dispute the task); it
                        // HALLUCINATED a mid-turn event stream that does not exist in the
                        // one-shot harness protocol, and exited waiting for a signal that
                        // never comes. The beta.52 worker-prompt hardening kills the
                        // behaviour; this tag makes the pattern greppable in metrics so we
                        // can tell "worker was wrong about the harness" apart from "worker
                        // correctly refused a bad task". Does NOT change pass/fail.
                        const looksLikeProtocolAssumption = looksLikeRefusal && matchesAsyncCoordConfabulation(refusalText);
                        if (looksLikeProtocolAssumption) {
                            const firstLine = refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? refusalText.slice(0, 200);
                            this.deps.state.audit("loop.worker_env_wait_hallucination", {
                                sessionId,
                                seq: st.seq,
                                cycle,
                                reasonFirstLine: firstLine.slice(0, 300),
                                finalMessage: refusalText.slice(0, 4000),
                                failedKinds: failedResults.map((x) => x.kind),
                            }, sessionId);
                            this.deps.logger.warn("[loop] worker awaited a non-existent mid-turn event (env-wait hallucination) and did no work", {
                                sessionId, seq: st.seq, reasonFirstLine: firstLine.slice(0, 200),
                            });
                        }
                        if (looksLikeRefusal) {
                            const firstLine = refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? refusalText.slice(0, 200);
                            // beta.58 (Bug B): split the audit event by semantics. A refusal
                            // whose explanation references a contradicted/invalid premise is
                            // a GOOD-FAITH skip, not a bad-faith refusal -- emit a distinct
                            // event so breakdowns are diagnosable without reading the prose.
                            // (Pass/fail is unchanged: both still escalate to clarification.)
                            const invalidPremiseSkip = matchesInvalidPremiseSkip(refusalText) && failedResults.some((x) => x.kind === "commit_made");
                            this.deps.state.audit(invalidPremiseSkip ? "loop.worker_skipped_invalid_premise" : "loop.worker_refusal", {
                                sessionId,
                                seq: st.seq,
                                cycle,
                                reasonFirstLine: firstLine.slice(0, 300),
                                finalMessage: refusalText.slice(0, 4000),
                                failedKinds: failedResults.map((x) => x.kind),
                                summary: verification.summary,
                            }, sessionId);
                            this.deps.logger.warn(invalidPremiseSkip
                                ? "[loop] worker skipped a sub-task on a contradicted premise (good-faith, structured)"
                                : "[loop] worker made a reasoned refusal (zero side-effects + explanation)", { sessionId, seq: st.seq, reasonFirstLine: firstLine.slice(0, 200) });
                        }
                        // beta.48 (C2): fold the refusal first-line into the persisted
                        // summary so harness_progress.headline and the terminal update
                        // show "worker refused: <reason>" rather than a bare
                        // verification-failed string.
                        const failSummary = looksLikeProtocolAssumption
                            ? `worker awaited a non-existent mid-turn event and did no work: ${(refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300)}`
                            : looksLikeRefusal
                                ? `worker refused (no changes made): ${(refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300)}`
                                : `verification failed: ${verification.summary}`;
                        this.deps.state.db.prepare(`UPDATE sub_tasks SET status = 'failed_verification', summary = ?, updated_at = ? WHERE id = ?`).run(failSummary, Date.now(), subTaskId);
                        this.deps.logger.warn("[loop] harness-side verification FAILED (worker confabulated success)", {
                            sessionId, seq: st.seq, costUsd: result.costUsd, summary: verification.summary,
                        });
                        failed.err = `subtask_${st.seq}_failed_verification: ${failSummary}`;
                        failed.seq = st.seq;
                        // ---- beta.55 (B2): escalate a reasoned refusal / surviving
                        // confabulation to a HUMAN instead of hard-failing the run. ----
                        // Precondition: this is a genuine refusal (looksLikeRefusal) that
                        // has ALREADY had its beta.54 async-coord retry (envWaitRetried is
                        // true if a retry was attempted; a refusal that reaches here after
                        // the retry, OR one that never qualified for retry, is a real
                        // blocking ambiguity). Rather than kill the whole run, surface the
                        // worker's OWN explanation as a question and pause resumably. The
                        // worktree is preserved (finaliseAwaitingClarification does NOT
                        // release it) so harness_answer can re-drive from this seq in place.
                        if (looksLikeRefusal &&
                            this.deps.config.loop.clarification_escalation_enabled !== false) {
                            const firstLine = refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? refusalText.slice(0, 200);
                            clarify.question =
                                `Sub-task ${st.seq} ("${st.title}") could not proceed. The worker's explanation: ${firstLine.slice(0, 500)}. ` +
                                    `How should it proceed? (Answer with a decision, or say "skip" to drop this sub-task, or "abort".)`;
                            clarify.seq = st.seq;
                            // beta.58 (D1/D2): capture the paused sub-task's title+intent so a
                            // `skip` answer keys the prohibition by CONTENT (survives a re-plan's
                            // seq renumbering) and can strip the owning finding line.
                            clarify.subtask = { title: st.title, intent: st.intent };
                        }
                        return;
                    }
                }
                else if (st.taskMode === "observe" || (contract.length === 0 && st.taskMode !== "mutate")) {
                    // beta.16 fix #2 + beta.18 fix: emit the observe-mode breadcrumb
                    // when either:
                    //   (a) taskMode is explicitly 'observe', or
                    //   (b) the contract is empty AND taskMode is not explicitly
                    //       'mutate' (defensive for pre-beta.15 plans without
                    //       taskMode where inference just came up empty).
                    //
                    // Beta.16/17 shipped this branch without the `!== "mutate"`
                    // guard, so a mutate sub-task whose inferred contract was empty
                    // (or which took the buildVerifyProbes-absent test path) fired
                    // `loop.subtask_observe_completed` with `taskMode:"mutate"` in
                    // the payload — an incoherent event where the name says
                    // "observe" but the payload admits it's a mutation. The inner
                    // (verification-eligible) branch already had this guard; beta.18
                    // brings this branch in line.
                    this.emitObserveCompleted(sessionId, st, result, []);
                }
                // beta.55 (B3): the sub-task PASSED, but if the worker's own final
                // message signals it deviated from the literal wording (a judgment
                // call), make that a first-class audit signal so "guess-and-document"
                // is auditable rather than buried in prose. Does NOT change pass/fail.
                {
                    const finalMsg = (result.finalMessage ?? "").trim();
                    if (finalMsg && matchesWorkerDeviation(finalMsg)) {
                        const firstLine = finalMsg.split("\n").map((l) => l.trim()).find(Boolean) ?? finalMsg.slice(0, 200);
                        this.deps.state.audit("loop.worker_deviation", { sessionId, seq: st.seq, cycle, summary: firstLine.slice(0, 500), finalMessage: finalMsg.slice(0, 2000) }, sessionId);
                        this.deps.logger.info("[loop] worker deviated from literal wording (passed verification, judgment call)", {
                            sessionId, seq: st.seq, summary: firstLine.slice(0, 200),
                        });
                    }
                }
                done.add(st.seq);
            };
            // Dispatcher: greedily fill up to `concurrency` in-flight, respecting dependsOn.
            let idx = 0;
            while (idx < ordered.length || inFlight.length > 0) {
                if (failed.err)
                    break;
                // Fill
                while (idx < ordered.length &&
                    inFlight.length < concurrency &&
                    (ordered[idx].dependsOn ?? []).every((d) => done.has(d))) {
                    const st = ordered[idx];
                    // beta.60: bound the ENTIRE runOne, not just the worker SDK call.
                    // beta.42 wrapped runWorker in withTimeout, but runOne ALSO awaits
                    // unbounded git/IO before and after the worker (worktreeHeadSha,
                    // readReactions, verifySubTaskOutput probes, budget.recordSpend). A
                    // hang in ANY of those froze the dispatcher at `await
                    // Promise.race(inFlight)` forever with the sub-task row stuck
                    // `running`, sdk_session_id=null, cost_usd=0, and NO worker process
                    // spawned -- the exact b59 PR#858 seq-7 stall (5h30m silent, no
                    // auto-recovery, because nothing re-called run() to arm the
                    // stall-watchdog). Bounding runOne converts any such hang into a
                    // clean SubTaskDeadlineError -> failed.err -> terminal.
                    const p = withTimeout(runOne(st), this.deps.config.loop.subtask_deadline_seconds)
                        .catch((err) => {
                        if (err instanceof WorkerTimeoutError) {
                            this.deps.state.audit("loop.subtask_deadline_exceeded", { sessionId, seq: st.seq, subtask_deadline_seconds: this.deps.config.loop.subtask_deadline_seconds }, sessionId);
                            this.deps.logger.error("[loop] sub-task exceeded subtask_deadline_seconds (dispatch hang, likely a stalled git/IO await before or after the worker); failing the run", { sessionId, seq: st.seq, seconds: this.deps.config.loop.subtask_deadline_seconds });
                            // mark the stuck row failed so it doesn't linger as `running`
                            this.deps.state.db.prepare(`UPDATE sub_tasks SET status = 'failed', summary = ?, updated_at = ? WHERE session_id = ? AND cycle = ? AND seq = ?`).run(`sub-task dispatch exceeded ${this.deps.config.loop.subtask_deadline_seconds}s (stalled IO)`, Date.now(), sessionId, cycle, st.seq);
                            if (!failed.err) {
                                failed.err = `subtask_deadline_exceeded (seq ${st.seq})`;
                                failed.seq = st.seq;
                            }
                        }
                        else {
                            // runOne handles its own errors internally; a throw here is
                            // unexpected -- surface it rather than silently dropping.
                            if (!failed.err) {
                                failed.err = `subtask_dispatch_error: ${String(err)}`;
                                failed.seq = st.seq;
                            }
                        }
                    })
                        .finally(() => {
                        const i = inFlight.indexOf(p);
                        if (i >= 0)
                            inFlight.splice(i, 1);
                    });
                    inFlight.push(p);
                    idx++;
                }
                if (inFlight.length === 0 && idx < ordered.length) {
                    // Blocked -- dependency not met yet and no in-flight to unblock. Data bug.
                    failed.err = `subtask ${ordered[idx].seq} has unresolved dependencies`;
                    failed.seq = ordered[idx].seq;
                    break;
                }
                if (inFlight.length > 0) {
                    await Promise.race(inFlight);
                }
            }
            await Promise.allSettled(inFlight);
            if (failed.err) {
                // beta.55 (B2): a resumable clarification pause takes precedence over a
                // hard-fail. The sub-task DID fail verification (failed.err set), but
                // if we captured a clarification request we pause instead of dying, so
                // a human can unblock the exact sub-task rather than restart the run.
                if (clarify.question) {
                    return this.finaliseAwaitingClarification(sessionId, clarify.question, clarify.seq, cycle, totalCost, clarify.subtask);
                }
                if (failed.err === "user_abort_reaction")
                    return this.finaliseAbort(sessionId, "user_abort_reaction", cycle, totalCost);
                if (failed.err === "hard_timeout")
                    return this.finaliseAbort(sessionId, "hard_timeout", cycle, totalCost);
                if (failed.err === "budget_exhausted")
                    return this.finaliseAbort(sessionId, "budget_exhausted", cycle, totalCost);
                return this.finaliseFailed(sessionId, String(failed.err), cycle, totalCost);
            }
            // 2b. Reviewing
            // beta.7 fix #2 (hard cap inside review): don't start the adversary if
            // we can't afford it. Estimate review cost from the priciest observed
            // sub-task (reviews scan the whole diff, so they scale with work done),
            // falling back to a conservative reserve. Abort at the cycle boundary
            // rather than blowing the budget by ~$0.83 on a review we can't pay for.
            {
                const reactions = await this.deps.readReactions(sessionId);
                const reviewEstimate = this.estimateReviewCost(subTaskCosts);
                if (!reactions.budgetBump && totalCost + reviewEstimate > row.budget_usd) {
                    // beta.8 (adversary point): the adversary was the only actor that
                    // caught the beta.6 confabulation, and beta.7's review-budget abort
                    // HID that failure by skipping review on cost. The observable-side-
                    // effect check is ~$0 in tokens, so run it UNCONDITIONALLY before
                    // aborting. This is the harness's own trust-but-verify guardrail;
                    // it must never be bypassed purely on token budget.
                    await this.runCheapObservableCheck(sessionId, plan, row.requester);
                    this.deps.state.audit("loop.review_budget_abort", { sessionId, cycle, totalCost, reviewEstimate, budget: row.budget_usd }, sessionId);
                    return this.finaliseAbort(sessionId, "budget_exhausted", cycle, totalCost);
                }
            }
            this.setStatus(sessionId, "reviewing");
            await this.deps.reportProgress?.(sessionId, "reviewing", { cycle });
            let runtime;
            try {
                runtime = await this.deps.fetchRuntime?.({ plan, sessionId });
            }
            catch (err) {
                this.deps.logger.warn("[loop] fetchRuntime failed", { err: String(err) });
            }
            // beta.7 fix #1: if no external runtime is available, synthesise a
            // "local" runtime snapshot from this cycle's verification audits so
            // the adversary still gets observable-output ground truth.
            if (!runtime) {
                const localVerification = this.readLocalVerification(sessionId);
                if (localVerification.length > 0) {
                    const anyFailed = localVerification.some((v) => !v.ok);
                    runtime = {
                        provider: "local",
                        status: anyFailed ? "unavailable" : "ok",
                        logsExcerpt: localVerification
                            .map((v) => `sub-task ${v.seq}: ${v.ok ? "VERIFIED" : "FAILED"} — ${v.summary}`)
                            .join("\n"),
                        errorCount: localVerification.filter((v) => !v.ok).length,
                        localVerification,
                    };
                }
            }
            let report;
            try {
                // beta.43: bound the adversary SDK call by adversary_timeout_seconds
                // (previously declared in config but UNENFORCED on this await). A hung
                // reviewer froze the run at the review phase with no timeout.
                report = await withTimeout(this.deps.runAdversary({ brief, plan, runtime, requester: row.requester }), this.deps.config.loop.adversary_timeout_seconds);
            }
            catch (err) {
                if (err instanceof WorkerTimeoutError) {
                    this.deps.state.audit("loop.adversary_timeout", { sessionId, cycle, adversary_timeout_seconds: this.deps.config.loop.adversary_timeout_seconds }, sessionId);
                }
                return this.finaliseFailed(sessionId, `adversary_error: ${String(err)}`, cycle, totalCost);
            }
            totalCost += report.costUsd;
            this.addCost(sessionId, report.costUsd);
            await this.deps.budget.recordSpend(row.requester, report.costUsd, sessionId);
            this.saveReview(sessionId, cycle, report);
            lastReview = report;
            this.deps.state.audit("loop.review", { sessionId, cycle, verdict: report.verdict, findings: report.findings.length }, sessionId);
            const reactions = await this.deps.readReactions(sessionId);
            const decision = OrchestratorLoop.advance({
                currentStatus: "reviewing",
                verdict: report.verdict,
                cyclesRan: cycle,
                maxCycles: this.deps.config.loop.max_cycles,
                reactions,
                budgetExhausted: totalCost > row.budget_usd && !reactions.budgetBump,
                hardTimeout: Date.now() > hardDeadlineMs,
            });
            this.deps.state.audit("loop.transition", { sessionId, from: "reviewing", ...decision }, sessionId);
            if (decision.nextStatus === "done")
                break;
            if (decision.nextStatus === "failed") {
                return this.finaliseFailed(sessionId, decision.reason, cycle, totalCost);
            }
            if (decision.nextStatus === "aborted") {
                return this.finaliseAbort(sessionId, decision.reason, cycle, totalCost);
            }
            // else "executing": continue the outer while
        }
        // 3. Push + PR
        if (!lastReview) {
            return this.finaliseFailed(sessionId, "no_review_produced", cycle, totalCost);
        }
        let prUrl;
        try {
            prUrl = await this.deps.pushBranchAndOpenPr({ plan, brief, reviewReport: lastReview, requester: row.requester });
        }
        catch (err) {
            return this.finaliseFailed(sessionId, `pr_error: ${String(err)}`, cycle, totalCost);
        }
        // beta.34: derive the post-ship MERGE / DO-NOT-MERGE recommendation from
        // the final review + whether we reached a clean pass. Persist it + the PR
        // number for the harness_merge_pr hard gate.
        const reachedCleanPass = lastReview.verdict === "pass";
        const rec = deriveMergeRecommendation({
            review: { verdict: lastReview.verdict, findings: lastReview.findings ?? [] },
            reachedCleanPass,
            ciStatus: undefined, // the merge tool re-checks CI at merge time
        });
        const prNumber = parsePrNumber(prUrl);
        this.deps.state.db
            .prepare(`UPDATE sessions SET final_pr_url = ?, pr_number = ?, merge_recommendation = ?, merge_recommendation_reason = ?, status = 'done', updated_at = ? WHERE id = ?`)
            .run(prUrl, prNumber ?? null, rec.recommendation, rec.reason, Date.now(), sessionId);
        this.deps.state.audit("loop.shipped", { sessionId, prUrl, prNumber, mergeRecommendation: rec.recommendation, reason: rec.reason }, sessionId);
        // beta.16 fix #3 + beta.17 correctness: prune the worktree on
        // `loop.shipped`. Beta.16 emitted the audit event but the underlying
        // release() silently no-op'd because it reconstructed the path from
        // sessionId (a UUID) while the allocator used `pending-<Date.now()>`
        // on-disk ids. Beta.17 threads the actual `worktree_path` from the
        // sessions row into the release call.
        await this.tryReleaseWorktree(sessionId, plan.repo, plan.worktreePath, "shipped");
        return { status: "shipped", sessionId, prUrl, cycles: cycle, totalCostUsd: totalCost };
    }
    /**
     * beta.16 fix #2: helper for emitting the `loop.subtask_observe_completed`
     * audit breadcrumb. Fires exactly once per observe-mode sub-task terminal
     * success. Payload is intentionally similar to `loop.subtask_verification`
     * so downstream consumers can treat the two events uniformly.
     */
    emitObserveCompleted(sessionId, st, result, contract) {
        this.deps.state.audit("loop.subtask_observe_completed", {
            sessionId,
            seq: st.seq,
            taskMode: st.taskMode ?? "unspecified",
            verify_count: contract.length,
            worker_files_touched: result.filesChanged ?? [],
            worker_commit_sha: result.commitSha ?? null,
            worker_end_reason: result.reason ?? null,
            cost_usd: result.costUsd,
        }, sessionId);
    }
    /**
     * beta.16 fix #3 + beta.17 telemetry: best-effort worktree release.
     * Called on all terminal transitions (shipped/aborted/failed). Never
     * throws — worktree cleanup failures are logged, audited, and swallowed
     * so they cannot fail an already-terminal session.
     *
     * beta.17: audit payload now carries `{ok, path, error?}` on both the
     * success and failure events so operators can distinguish
     * event-fired-but-nothing-happened from event-fired-and-succeeded.
     * Beta.16's `loop.worktree_released` was a lie on production because
     * the underlying release() silently no-op'd (see releaseByPath docs).
     */
    async tryReleaseWorktree(sessionId, repoFullName, worktreePath, reason) {
        if (!this.deps.releaseWorktree)
            return;
        try {
            const outcome = await this.deps.releaseWorktree({ sessionId, repoFullName, worktreePath, reason });
            if (outcome.ok) {
                this.deps.state.audit("loop.worktree_released", { sessionId, reason, ok: true, path: outcome.path ?? worktreePath, ...(outcome.error ? { note: outcome.error } : {}) }, sessionId);
            }
            else {
                this.deps.logger.warn("[loop] worktree release reported not-ok", { sessionId, reason, worktreePath, err: outcome.error });
                this.deps.state.audit("loop.worktree_release_failed", { sessionId, reason, ok: false, path: outcome.path ?? worktreePath, error: outcome.error ?? "unknown" }, sessionId);
            }
        }
        catch (err) {
            // The releaseWorktree impl threw synchronously / rejected. Different
            // failure mode from ok:false, but the operator surface is the same.
            this.deps.logger.warn("[loop] worktree release threw", { sessionId, reason, worktreePath, err: String(err) });
            this.deps.state.audit("loop.worktree_release_failed", { sessionId, reason, ok: false, path: worktreePath, error: String(err) }, sessionId);
        }
    }
    /**
     * Pull the latest verification outcome per sub-task from the audit log,
     * to feed the adversary as local runtime data (beta.7 fix #1).
     */
    /**
     * beta.8: cheap, unconditional final observable check. Independently asks
     * the provider whether the branch exists on origin (the single most
     * important fact: did anything actually reach the remote?). Runs even when
     * the review budget is exhausted, because it costs ~$0 in tokens and is
     * the harness's last line of defence against a confabulated "it shipped".
     * Records loop.cheap_observable_check with the result.
     */
    async runCheapObservableCheck(sessionId, plan, requester) {
        if (!this.deps.buildVerifyProbes)
            return;
        try {
            const probes = this.deps.buildVerifyProbes({ plan, requester, worktreePath: plan.worktreePath, baseSha: "" });
            const branch = await probes.remoteBranchExists(plan.branch);
            this.deps.state.audit("loop.cheap_observable_check", { sessionId, branch: plan.branch, remoteBranchExists: branch.exists, detail: branch.detail }, sessionId);
            if (!branch.exists) {
                this.deps.logger.warn("[loop] cheap observable check: branch NOT on remote at abort time", {
                    sessionId, branch: plan.branch, detail: branch.detail,
                });
            }
        }
        catch (err) {
            this.deps.logger.warn("[loop] cheap observable check errored", { sessionId, err: String(err) });
        }
    }
    readLocalVerification(sessionId) {
        const rows = this.deps.state.db
            .prepare(`SELECT payload FROM audit_log
         WHERE session_id = ? AND event = 'loop.subtask_verification'
         ORDER BY created_at ASC`)
            .all(sessionId);
        const bySeq = new Map();
        for (const r of rows) {
            try {
                const p = JSON.parse(r.payload);
                if (typeof p.seq === "number")
                    bySeq.set(p.seq, { seq: p.seq, ok: !!p.ok, summary: String(p.summary ?? "") });
            }
            catch {
                // ignore malformed audit rows
            }
        }
        return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    }
    /**
     * beta.7 fix #2: project the cost of an upcoming sub-task. Prefer the
     * running median of ACTUAL costs (empirical, per-session), because token
     * estimates from the lead are notoriously optimistic. Fall back to the
     * plan's token estimate via the price table, then to a conservative
     * per-task reserve so we never project zero.
     */
    estimateSubTaskCost(st, observed) {
        if (observed.length > 0)
            return median(observed);
        if (st.estimatedTokens > 0) {
            return estimateSubTaskCost(this.deps.config.models.worker, st.estimatedTokens, this.deps.config.models.price_overrides);
        }
        return 0.25; // conservative reserve when we have nothing to go on
    }
    /**
     * beta.7 fix #2: estimate adversary review cost. Reviews scan the whole
     * diff, so cost scales with the work done: use the max observed sub-task
     * cost as a proxy, with a conservative floor.
     */
    estimateReviewCost(observed) {
        const floor = 0.5;
        if (observed.length === 0)
            return floor;
        return Math.max(floor, Math.max(...observed));
    }
    finaliseAbort(sessionId, reason, cycles, totalCostUsd) {
        this.setStatus(sessionId, "aborted");
        this.deps.state.audit("loop.aborted", { sessionId, reason }, sessionId);
        // beta.16 fix #3: release worktree on abort too. Best-effort; we don't
        // await inside the return path because callers assume finaliseAbort is
        // synchronous. Instead, kick off the release and let it settle on the
        // event loop; the failure path is logged and audited inside
        // tryReleaseWorktree.
        this.scheduleWorktreeReleaseForSession(sessionId, "aborted");
        return { status: "aborted", sessionId, reason, cycles, totalCostUsd };
    }
    /**
     * beta.16 fix #3 + beta.17 correctness: schedule a best-effort worktree
     * release for a session that has already reached a terminal status.
     * Looks up both `repo` and `worktree_path` from the sessions row so the
     * release call gets the actual on-disk path (not a reconstruction).
     * Never throws.
     */
    scheduleWorktreeReleaseForSession(sessionId, reason) {
        if (!this.deps.releaseWorktree)
            return;
        try {
            const row = this.deps.state.db
                .prepare(`SELECT repo, worktree_path FROM sessions WHERE id = ?`)
                .get(sessionId);
            if (row?.repo && row?.worktree_path) {
                void this.tryReleaseWorktree(sessionId, row.repo, row.worktree_path, reason);
            }
            else if (row?.repo) {
                // No worktree_path yet (session died before allocation completed):
                // there's nothing to release, but audit the skip so the stream
                // stays self-describing.
                this.deps.state.audit("loop.worktree_release_skipped", { sessionId, reason, reason_skipped: "no worktree_path on session row (likely died pre-allocation)" }, sessionId);
            }
        }
        catch (err) {
            this.deps.logger.warn("[loop] scheduleWorktreeReleaseForSession failed to look up session row", { sessionId, err: String(err) });
        }
    }
    /**
     * beta.16 fix #3: build a `LoopOutcome` for a hard-failed session and
     * release the worktree. Centralises the six failure-return sites so we
     * cannot forget to release the worktree on new failure paths.
     */
    finaliseFailed(sessionId, reason, cycles, totalCostUsd) {
        this.setStatus(sessionId, "failed");
        this.scheduleWorktreeReleaseForSession(sessionId, "failed");
        return { status: "failed", sessionId, reason, cycles, totalCostUsd };
    }
    /**
     * beta.55 (B2): pause the session for a human decision. Persists the
     * question + the paused sub-task seq and sets status `awaiting_clarification`.
     * CRITICAL: does NOT release the worktree (unlike finaliseFailed/Abort) so
     * harness_answer can re-drive the loop from the paused seq in place. The
     * worktree-heal protect set (beta.45) + recovery both treat
     * `awaiting_clarification` as resumable, so a stray re-register or restart
     * won't reap the worktree or auto-fail the pause.
     */
    finaliseAwaitingClarification(sessionId, question, seq, cycles, totalCostUsd, subtask) {
        this.setStatus(sessionId, "awaiting_clarification");
        this.deps.state.db.prepare(`UPDATE sessions SET clarification_question = ?, clarification_seq = ?, clarification_answer = NULL, clarification_subtask = ?, updated_at = ? WHERE id = ?`).run(question, seq, subtask ? JSON.stringify(subtask) : null, Date.now(), sessionId);
        this.deps.state.audit("loop.clarification_requested", { sessionId, seq, question: question.slice(0, 1000), cycle: cycles }, sessionId);
        this.deps.logger.warn("[loop] paused for clarification (awaiting_clarification); worktree preserved", {
            sessionId, seq, question: question.slice(0, 200),
        });
        // Deliberately NO scheduleWorktreeReleaseForSession -- the worktree must
        // survive so the answered resume continues in place.
        return { status: "awaiting_clarification", sessionId, question, seq, cycles, totalCostUsd };
    }
}
/** Median of a non-empty numeric array. */
function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
/**
 * Kahn's-algorithm topological sort of sub-tasks by `dependsOn`.
 * Stable: preserves original seq order among independent tasks.
 * Throws on cycles.
 */
export function topoSortSubTasks(subTasks) {
    const bySeq = new Map(subTasks.map((s) => [s.seq, s]));
    const remainingDeps = new Map();
    const dependents = new Map();
    for (const s of subTasks) {
        const deps = (s.dependsOn ?? []).filter((d) => bySeq.has(d));
        remainingDeps.set(s.seq, deps.length);
        for (const d of deps) {
            if (!dependents.has(d))
                dependents.set(d, []);
            dependents.get(d).push(s.seq);
        }
    }
    const ready = subTasks
        .filter((s) => (remainingDeps.get(s.seq) ?? 0) === 0)
        .map((s) => s.seq)
        .sort((a, b) => a - b);
    const out = [];
    while (ready.length > 0) {
        const next = ready.shift();
        out.push(bySeq.get(next));
        for (const dep of dependents.get(next) ?? []) {
            const left = (remainingDeps.get(dep) ?? 0) - 1;
            remainingDeps.set(dep, left);
            if (left === 0) {
                // Insert-in-order to keep stable ordering
                const pos = ready.findIndex((r) => r > dep);
                if (pos === -1)
                    ready.push(dep);
                else
                    ready.splice(pos, 0, dep);
            }
        }
    }
    if (out.length !== subTasks.length) {
        throw new Error(`sub-task dependency cycle detected (only sorted ${out.length}/${subTasks.length})`);
    }
    return out;
}
//# sourceMappingURL=loop.js.map