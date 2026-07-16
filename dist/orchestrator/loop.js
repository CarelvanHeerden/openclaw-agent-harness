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
                if (input.cyclesRan >= input.maxCycles - 1)
                    return { nextStatus: "failed", reason: "max_cycles_reached" };
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
    async run(sessionId, brief) {
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
            this.setStatus(sessionId, "failed");
            this.deps.state.audit("loop.plan_failed", { sessionId, err: String(err) }, sessionId);
            return { status: "failed", sessionId, reason: `plan_failed: ${String(err)}`, cycles: 0, totalCostUsd: row.cost_usd };
        }
        let cycle = 0;
        let totalCost = row.cost_usd;
        let lastReview;
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
                const subTaskId = `${sessionId}-c${cycle}-s${st.seq}`;
                this.deps.state.db.prepare(`INSERT OR REPLACE INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, cost_usd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)`).run(subTaskId, sessionId, cycle, st.seq, st.title, this.deps.config.models.worker, Date.now(), Date.now());
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
                this.addCost(sessionId, result.costUsd);
                await this.deps.budget.recordSpend(row.requester, result.costUsd, sessionId);
                this.deps.state.db.prepare(`UPDATE sub_tasks
           SET status = ?, cost_usd = ?, files_touched = ?, commit_sha = ?, sdk_session_id = ?, summary = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`).run(result.status, result.costUsd, JSON.stringify(result.filesChanged), result.commitSha ?? null, result.sdkSessionId ?? null, result.reason ?? null, Date.now(), Date.now(), subTaskId);
                this.checkpoint(sessionId, cycle, subTaskId, result.sdkSessionId);
                // beta.7 fix #1: audit verification outcome + wasted spend, and
                // surface it as local runtime data for the adversary (closing the
                // "runtime: no runtime data" gap for observable-output sub-tasks).
                if (result.verification) {
                    this.deps.state.audit("loop.subtask_verification", {
                        sessionId, seq: st.seq, ok: result.verification.ok,
                        summary: result.verification.summary,
                        results: result.verification.results,
                        wastedSpendUsd: result.wastedSpend ? result.costUsd : 0,
                    }, sessionId);
                    if (result.wastedSpend) {
                        this.deps.logger.warn("[loop] wasted spend: SDK success but verification failed", {
                            sessionId, seq: st.seq, costUsd: result.costUsd, summary: result.verification.summary,
                        });
                    }
                }
                // A sub-task that FAILED verification (or otherwise) must not be
                // treated as satisfied: do not mark it done, and stop the cycle so
                // the failure is not silently swallowed.
                if (result.status !== "completed") {
                    failed.err = `subtask_${st.seq}_${result.status}: ${result.reason ?? "no reason"}`;
                    failed.seq = st.seq;
                    return;
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
                this.setStatus(sessionId, "failed");
                return { status: "failed", sessionId, reason: String(failed.err), cycles: cycle, totalCostUsd: totalCost };
            }
            // 2b. Reviewing
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
                this.setStatus(sessionId, "failed");
                return { status: "failed", sessionId, reason: `adversary_error: ${String(err)}`, cycles: cycle, totalCostUsd: totalCost };
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
                this.setStatus(sessionId, "failed");
                return { status: "failed", sessionId, reason: decision.reason, cycles: cycle, totalCostUsd: totalCost };
            }
            if (decision.nextStatus === "aborted") {
                return this.finaliseAbort(sessionId, decision.reason, cycle, totalCost);
            }
            // else "executing": continue the outer while
        }
        // 3. Push + PR
        if (!lastReview) {
            this.setStatus(sessionId, "failed");
            return { status: "failed", sessionId, reason: "no_review_produced", cycles: cycle, totalCostUsd: totalCost };
        }
        let prUrl;
        try {
            prUrl = await this.deps.pushBranchAndOpenPr({ plan, brief, reviewReport: lastReview, requester: row.requester });
        }
        catch (err) {
            this.setStatus(sessionId, "failed");
            return { status: "failed", sessionId, reason: `pr_error: ${String(err)}`, cycles: cycle, totalCostUsd: totalCost };
        }
        this.deps.state.db.prepare(`UPDATE sessions SET final_pr_url = ?, status = 'done', updated_at = ? WHERE id = ?`).run(prUrl, Date.now(), sessionId);
        this.deps.state.audit("loop.shipped", { sessionId, prUrl }, sessionId);
        return { status: "shipped", sessionId, prUrl, cycles: cycle, totalCostUsd: totalCost };
    }
    /**
     * Pull the latest verification outcome per sub-task from the audit log,
     * to feed the adversary as local runtime data (beta.7 fix #1).
     */
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
    finaliseAbort(sessionId, reason, cycles, totalCostUsd) {
        this.setStatus(sessionId, "aborted");
        this.deps.state.audit("loop.aborted", { sessionId, reason }, sessionId);
        return { status: "aborted", sessionId, reason, cycles, totalCostUsd };
    }
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