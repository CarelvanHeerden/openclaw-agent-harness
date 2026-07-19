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
/** True if a loop for this session is currently running in this process. */
export function isSessionLoopRunning(sessionId) {
    return runningSessions.has(sessionId);
}
/** Test/diagnostic helper: snapshot of currently-running session ids. */
export function runningSessionIds() {
    return [...runningSessions];
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
                if (input.cyclesRan >= input.maxCycles - 1) {
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
        try {
            return await this.runInner(sessionId, brief);
        }
        finally {
            runningSessions.delete(sessionId);
        }
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
            plan = await this.deps.runLead(brief, { requester: row.requester });
            this.deps.state.db
                .prepare(`UPDATE sessions SET lead_plan_json = ?, repo = ?, branch = ?, worktree_path = ? WHERE id = ?`)
                .run(JSON.stringify(plan), plan.repo, plan.branch, plan.worktreePath, sessionId);
            this.deps.state.audit("loop.plan_ready", { sessionId, subTasks: plan.subTasks.length, risk: plan.riskLevel }, sessionId);
        }
        catch (err) {
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
            const runOne = async (st) => {
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
                let result;
                try {
                    result = await this.deps.runWorker({ brief, subTask: st, plan, requester: row.requester });
                }
                catch (err) {
                    this.deps.state.db.prepare(`UPDATE sub_tasks SET status = 'failed', summary = ?, updated_at = ? WHERE id = ?`).run(`worker threw: ${String(err)}`, Date.now(), subTaskId);
                    failed.err = `worker_error: ${String(err)}`;
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
                        verification = await verifySubTaskOutput(contract, { defaultBranch: branchHint, subTaskStartMs: 0, baseSha: subTaskBaseSha }, probes);
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
                        this.deps.state.db.prepare(`UPDATE sub_tasks SET status = 'failed_verification', summary = ?, updated_at = ? WHERE id = ?`).run(`verification failed: ${verification.summary}`, Date.now(), subTaskId);
                        this.deps.logger.warn("[loop] harness-side verification FAILED (worker confabulated success)", {
                            sessionId, seq: st.seq, costUsd: result.costUsd, summary: verification.summary,
                        });
                        failed.err = `subtask_${st.seq}_failed_verification: ${verification.summary}`;
                        failed.seq = st.seq;
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
                    const p = runOne(ordered[idx]).finally(() => {
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
                report = await this.deps.runAdversary({ brief, plan, runtime, requester: row.requester });
            }
            catch (err) {
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