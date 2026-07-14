/**
 * Slack -> harness dispatcher.
 *
 * The dispatcher is the glue between the Slack listener (pure routing +
 * event ingestion) and the orchestrator loop (heavy async work).
 *
 * Responsibilities:
 *   1. Insert a `sessions` row on `start_new_session`, respecting the
 *      UNIQUE(slack_channel, slack_thread) constraint.
 *   2. Kick off `crystallisePrompt()` for the first user message.
 *   3. On successful brief, hand to orchestrator loop (fire-and-forget;
 *      Slack replies are pushed by the loop's `reportProgress`).
 *   4. On `continue_session`, accept follow-up messages (currently: log +
 *      react so users know we saw them; a real conversational refinement
 *      pass is future work).
 *
 * The dispatcher owns the "session-level" try/catch that reports failures
 * back to Slack so the user isn't left staring at a silent thread.
 */
import { randomUUID } from "node:crypto";
export class Dispatcher {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Called when `routeMessage()` returns `start_new_session`. Creates the
     * session row (UNIQUE constraint enforces uniqueness), reacts to the
     * origin message with an "on it" emoji, then crystallises and hands off.
     */
    async startNewSession(evt) {
        const sessionId = randomUUID();
        try {
            this.deps.state.db
                .prepare(`INSERT INTO sessions (
             id, slack_thread, slack_channel, requester, requester_gh,
             repo, branch, worktree_path, status, created_at, updated_at,
             budget_usd, cost_usd, cycles_ran
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'crystallising', ?, ?, ?, 0, 0)`)
                .run(sessionId, evt.ts, evt.channel, evt.user, this.deps.config.pat_routing.overrides[evt.user]?.["_gh_user"] ?? evt.user, "", // repo — resolved by lead planner
            "", // branch — same
            "", // worktree — same
            Date.now(), Date.now(), this.deps.config.budgets.session_default_usd);
        }
        catch (err) {
            if (String(err).includes("UNIQUE") || String(err).includes("SQLITE_CONSTRAINT")) {
                this.deps.logger.info("[dispatcher] session already exists for this thread; ignoring duplicate start", { thread: evt.ts });
                return;
            }
            throw err;
        }
        await this.deps.slackReact(evt.channel, evt.ts, "eyes").catch(() => { });
        this.deps.state.audit("dispatcher.session_started", { sessionId, user: evt.user }, sessionId);
        // Fire-and-forget the actual work
        void this.runSession(sessionId, evt).catch((err) => {
            this.deps.logger.error("[dispatcher] session crashed", { sessionId, err: String(err) });
            this.deps.slackReply(evt.channel, evt.ts, `:boom: harness session ${sessionId} crashed: ${String(err).slice(0, 400)}`).catch(() => { });
        });
    }
    async runSession(sessionId, evt) {
        // 1. Crystallise
        const cResult = await this.deps.crystallise(evt.text);
        if (cResult.kind === "reject") {
            this.deps.state.db.prepare(`UPDATE sessions SET status = 'aborted', updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
            await this.deps.slackReply(evt.channel, evt.ts, cResult.intent === "unsafe"
                ? `:no_entry: I can't do that (unsafe): ${cResult.reason}`
                : `:speech_balloon: That doesn't look like a dev task to me. Ignoring.`);
            return;
        }
        if (cResult.kind === "clarify") {
            // Keep the session alive in "crystallising" state; user's next reply will
            // be delivered via continueSession() below.
            await this.deps.slackReply(evt.channel, evt.ts, `:thinking_face: ${cResult.question}`);
            return;
        }
        // 2. Persist crystallised brief and reply with the plan seed
        this.deps.state.db
            .prepare(`UPDATE sessions SET crystallised_prompt = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(cResult.brief), Date.now(), sessionId);
        await this.deps.slackReply(evt.channel, evt.ts, `:brain: Understood: *${cResult.brief.title}*\n> ${cResult.brief.motivation}\nAcceptance criteria:\n${cResult.brief.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n_Planning…_`);
        // 3. Run orchestrator loop
        const outcome = await this.deps.loop.run(sessionId, cResult.brief);
        // 4. Report outcome
        switch (outcome.status) {
            case "shipped":
                await this.deps.slackReply(evt.channel, evt.ts, `:tada: PR opened: ${outcome.prUrl}\nCycles: ${outcome.cycles} — Cost: $${outcome.totalCostUsd.toFixed(2)}`);
                break;
            case "failed":
                await this.deps.slackReply(evt.channel, evt.ts, `:x: Session failed after ${outcome.cycles} cycle(s): ${outcome.reason}\nCost so far: $${outcome.totalCostUsd.toFixed(2)}`);
                break;
            case "aborted":
                await this.deps.slackReply(evt.channel, evt.ts, `:octagonal_sign: Session aborted: ${outcome.reason}\nCycles: ${outcome.cycles} — Cost: $${outcome.totalCostUsd.toFixed(2)}`);
                break;
        }
    }
    /**
     * Called for follow-up messages inside an existing thread's session. Right
     * now we simply log + react. Conversational refinement (mid-flight scope
     * changes, override reactions delivered as messages) lands next.
     */
    async continueSession(sessionId, evt) {
        this.deps.state.audit("dispatcher.follow_up", { sessionId, textLen: evt.text.length }, sessionId);
        await this.deps.slackReact(evt.channel, evt.ts, "eyes").catch(() => { });
    }
}
//# sourceMappingURL=dispatcher.js.map