/**
 * Runtime tool registration for openclaw-agent-harness.
 *
 * These are the tools OpenClaw exposes to callers (Slack users via
 * commands, other plugins, or cron jobs). They intentionally do NOT
 * include the "run a task" surface -- that entry point is the Slack
 * listener. These tools are for inspection, admin, and cron jobs.
 */
import { buildHarnessHelp } from "./help-content.js";
import { getCurrentRuntime } from "../runtime-registry.js";
import { pruneRetention } from "../state/retention.js";
import { buildProgressSnapshot } from "../orchestrator/progress.js";
import { findingText, isConditionalFinding, removeOwningFindingLines } from "../orchestrator/finding-hygiene.js";
import { guidanceAcceptanceLine, normaliseGuidance } from "./revise-guidance.js";
import { OnboardingSlack, checkOnboardConsistency, checkRepoAccess, onboardRouteService, resolveOnboardVaultService, validateGitToken, } from "../slack/onboarding.js";
import { acceptedHosts, parseOrgUrl } from "../auth/org-url.js";
import { checkTokenIdentity } from "../auth/identity.js";
import { RouteOverlay, normaliseOrg } from "../auth/route-overlay.js";
import { measureParaphraseDrift, readRequestFile } from "./brief-source.js";
import { BRIEF_CONFIRMATION_KIND, BRIEF_CONFIRMATION_SEQ, decideBriefConfirmation, isBriefConfirmationPause, parseConfirmationReply, renderBriefConfirmation, } from "./brief-confirmation.js";
import { isTimeExtensionPause, listenerLooksAlive, readTimeExtensionWaitUntil } from "../orchestrator/time-extension.js";
function toDispose(x) {
    return () => {
        if (typeof x === "function")
            x();
        else if (x && typeof x === "object") {
            if (typeof x.dispose === "function")
                x.dispose();
            else if (typeof x.unregister === "function")
                x.unregister();
        }
    };
}
export function registerHarnessTools(api, runtime) {
    const disposers = [];
    /**
     * Resolve the LIVE runtime for tool execution.
     *
     * Prefer the current module-level runtime (updated on every (re-)register)
     * over the `runtime` captured when this tool was registered. After a
     * re-register the captured generation is torn down and its state DB is
     * closed; touching `liveDb()` from a stale closure throws the
     * `node:sqlite` "database is not open" error. Reading the live runtime
     * means we always hit an OPEN handle.
     */
    const liveRuntime = () => getCurrentRuntime() ?? runtime;
    /**
     * Live, guaranteed-open DB handle for tool queries. Throws a clear,
     * actionable error (rather than the opaque sqlite one) if we somehow land
     * on a closed generation — e.g. mid-teardown before the live runtime is
     * published.
     */
    const liveDb = () => {
        const rt = liveRuntime();
        // `isOpen` is part of the StateStore contract, but guard defensively:
        // a state provider (or test stub) that predates the open-guard should
        // be treated as open rather than crashing.
        const isOpen = typeof rt.state.isOpen === "function" ? rt.state.isOpen() : true;
        if (!isOpen) {
            throw new Error("harness state DB is not open (plugin is re-registering); retry in a moment");
        }
        return rt.state.db;
    };
    const liveState = () => liveRuntime().state;
    const liveConfig = () => liveRuntime().config;
    /**
     * Shared session-start path for BOTH agent-orchestrated tools
     * (`harness_run`, `harness_start_session`). Inserts the session row and
     * fires the orchestrator loop.
     *
     * Slack channel/thread are OPTIONAL. When omitted (the agent-orchestrated
     * case, where there may be no Slack thread to post into) we synthesise a
     * unique `agent:<sessionId>` thread key so the UNIQUE(slack_thread)
     * constraint is still satisfied and progress is simply not pushed to
     * Slack -- the agent gets the sessionId back and polls `harness_status` /
     * `harness_session_get` instead.
     */
    function startSessionFromBrief(params) {
        if (!liveConfig().slack.authorised_users.includes(params.requester)) {
            return { ok: false, unauthorised: true, reason: `Requester ${params.requester} is not in slack.authorised_users` };
        }
        // beta.57 (P3): enforce the advertised budget cap. The tool descriptions
        // have always promised "capped at budgets.session_hard_ceiling_usd", but
        // the raw value was inserted unchecked -- a budgetUsd of 10000 sailed
        // straight into sessions.budget_usd and the loop enforced against it.
        const ceiling = liveConfig().budgets?.session_hard_ceiling_usd;
        const requestedBudget = params.budgetUsd ?? liveConfig().budgets?.session_default_usd ?? 50;
        const effectiveBudget = typeof ceiling === "number" && ceiling > 0 ? Math.min(requestedBudget, ceiling) : requestedBudget;
        if (effectiveBudget < requestedBudget) {
            liveState().audit("tool.run.budget_clamped", { requester: params.requester, requested: requestedBudget, clamped: effectiveBudget, ceiling });
        }
        // beta.78 (Feature 1): daily-aware budget RECOMMENDATION. Soft default --
        // the run proceeds at `effectiveBudget`; this note nudges the user if the
        // recommended/default budget looks low against remaining daily headroom.
        const rec = recommendBudget(params.requester, params.budgetUsd);
        // beta.81 (Track A / A3): emit an UNCONDITIONAL `tool.run.budget_estimate`
        // audit on EVERY run. The beta.78 `tool.run.budget_recommendation` was
        // `if(rec.note)`-gated on DAILY-cap pressure only, so with a generous (or
        // unset) daily cap it NEVER fired -- Staging proved zero hits ever, and
        // "was budget surfaced?" was unanswerable from the log. This always fires
        // with the session ESTIMATE + cap + daily context. `estimated` is the
        // harness-owned session cost estimate (= recommendBudget's `recommended`,
        // the daily-aware capped session estimate).
        liveState().audit("tool.run.budget_estimate", {
            requester: params.requester,
            estimated: rec.recommended,
            cap: effectiveBudget,
            dailySoFar: rec.dailySoFar,
            dailyMax: rec.dailyMax,
        });
        if (rec.note) {
            liveState().audit("tool.run.budget_recommendation", {
                requester: params.requester, effectiveBudget, recommended: rec.recommended,
                dailySoFar: rec.dailySoFar, dailyMax: rec.dailyMax, remainingDaily: rec.remainingDaily,
            });
        }
        const sessionId = globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const slackChannel = params.slackChannel ?? "";
        // Synthesise a unique thread key when the agent supplies none.
        const slackThread = params.slackThread ?? `agent:${sessionId}`;
        // beta.29: the UNIQUE index on (slack_channel, slack_thread) makes a
        // thread a singleton. But a TERMINAL prior session (done/failed/aborted)
        // should NOT permanently lock its thread -- otherwise every failed run
        // leaves its thread unusable and retries in-thread are impossible
        // (Staging ProjectThanos: session 781a9532 failed at worktree-add, then
        // the retry was rejected as duplicateThread). Free the thread iff the
        // only prior session on it is terminal. If a NON-terminal (active)
        // session exists, we still block (a real duplicate).
        if (slackThread) {
            const prior = liveDb()
                .prepare(`SELECT id, status FROM sessions WHERE slack_channel = ? AND slack_thread = ?`)
                .all(slackChannel, slackThread);
            const TERMINAL = new Set(["done", "failed", "aborted"]);
            const active = prior.find((p) => !TERMINAL.has(p.status));
            if (active) {
                return { ok: false, duplicateThread: true, reason: `Session ${active.id} is already active (status=${active.status}) for thread ${slackThread}` };
            }
            if (prior.length > 0) {
                // All prior sessions on this thread are terminal -- release the
                // thread slot so the retry can take it.
                //
                // beta.57 (P3): RE-KEY instead of DELETE. Deleting the prior row
                // destroyed real state: a 'done' session with an OPEN PR lost its
                // pr-watcher tracking (merge/close never noticed, worktree never
                // released) and its revise lineage (harness_list_revisable /
                // harness_revise resolve by session row). Re-keying the thread to a
                // unique tombstone frees the UNIQUE(slack_channel, slack_thread) slot
                // while preserving the rows.
                const retire = liveDb().prepare(`UPDATE sessions SET slack_thread = 'retired:' || id || ':' || slack_thread, updated_at = ?
            WHERE slack_channel = ? AND slack_thread = ? AND status IN ('done','failed','aborted')`);
                const info = retire.run(Date.now(), slackChannel, slackThread);
                liveState().audit("tool.run.thread_reclaimed", { channel: slackChannel, thread: slackThread, retired: info.changes, priorIds: prior.map((p) => p.id) });
            }
        }
        // beta.120 (brief fidelity): decide BEFORE the insert whether a human sees
        // the brief first. Crystallising has already happened and cost cents; every
        // expensive thing (planning, workers, review, CI) is still ahead of us, so
        // this is the last cheap moment to catch a brief that says `scheduledAt`
        // where the user wrote `performedAt`.
        const briefCfg = liveConfig().brief;
        const decision = decideBriefConfirmation({
            // Safety fallback must match the runtime/schema default. A partial or
            // legacy config must not silently bypass operator review for low-risk
            // work merely because the `brief` block or this field is absent.
            mode: (briefCfg?.confirm_before_spend ?? "always"),
            riskLevel: params.brief.riskLevel,
            minRisk: (briefCfg?.confirm_min_risk ?? "high"),
            waived: params.confirmWaived,
        });
        const confirmationQuestion = decision.confirm
            ? renderBriefConfirmation({
                brief: params.brief,
                estimatedUsd: rec.recommended,
                effectiveBudget,
                sourcePath: params.sourcePath,
                // beta.122: so a verbatim relay carries the REAL id. See
                // RenderConfirmationInput.sessionId.
                sessionId,
                hardTimeoutSeconds: liveConfig().loop?.session_hard_timeout_seconds,
            })
            : "";
        try {
            liveDb()
                .prepare(`INSERT INTO sessions (
             id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
             status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran, estimated_usd,
             clarification_question, clarification_seq, clarification_subtask
           ) VALUES (?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`)
                .run(sessionId, slackThread, slackChannel, params.requester, params.requester, decision.confirm ? "awaiting_clarification" : "planning", JSON.stringify(params.brief), Date.now(), Date.now(), effectiveBudget, 
            // beta.81 (Track A / A1): persist the harness-owned session estimate
            // so harness_progress / terminal / loop.start surface it reliably.
            rec.recommended, decision.confirm ? confirmationQuestion : null, decision.confirm ? BRIEF_CONFIRMATION_SEQ : null, decision.confirm ? JSON.stringify({ kind: BRIEF_CONFIRMATION_KIND }) : null);
        }
        catch (err) {
            if (String(err).includes("UNIQUE") || String(err).includes("SQLITE_CONSTRAINT")) {
                return { ok: false, duplicateThread: true, reason: `Session already exists for thread ${slackThread}` };
            }
            throw err;
        }
        liveState().audit(params.auditEvent, { sessionId, requester: params.requester }, sessionId);
        if (decision.confirm) {
            liveState().audit("tool.run.awaiting_brief_confirmation", { sessionId, requester: params.requester, reason: decision.reason, riskLevel: params.brief.riskLevel ?? null, effectiveBudget, fromFile: params.sourcePath ?? null }, sessionId);
            return { ok: true, sessionId, awaitingConfirmation: true, question: confirmationQuestion, budgetNote: rec.note, effectiveBudget, recommendedBudget: rec.recommended, estimatedUsd: rec.recommended };
        }
        void liveRuntime().loop.run(sessionId, params.brief).catch((err) => {
            api.logger.error(`[${params.auditEvent}] loop crashed`, { sessionId, err: String(err) });
        });
        return { ok: true, sessionId, budgetNote: rec.note, effectiveBudget, recommendedBudget: rec.recommended, estimatedUsd: rec.recommended };
    }
    /**
     * beta.78 (Feature 1): compute a daily-aware budget recommendation. Pure-ish
     * (reads config + the persistent daily ledger). `requested` is the user's
     * explicit budgetUsd (undefined = use the session default). Returns the
     * recommended budget and an optional human note when remaining daily is low.
     */
    function recommendBudget(user, requested) {
        const cfg = liveConfig().budgets;
        const sessionDefault = cfg?.session_default_usd ?? 50;
        const ceiling = cfg?.session_hard_ceiling_usd;
        const dailyMax = cfg?.daily_max_usd ?? 0;
        let dailySoFar = 0;
        try {
            dailySoFar = liveRuntime().budget.getDailySpend(user);
        }
        catch { /* ledger unavailable -> treat as 0 */ }
        const remainingDaily = dailyMax > 0 ? Math.max(0, dailyMax - dailySoFar) : Number.POSITIVE_INFINITY;
        // Recommend the requested amount, else the session default, capped by the
        // session hard ceiling AND by remaining daily headroom.
        let recommended = requested ?? sessionDefault;
        if (typeof ceiling === "number" && ceiling > 0)
            recommended = Math.min(recommended, ceiling);
        if (Number.isFinite(remainingDaily))
            recommended = Math.min(recommended, remainingDaily);
        let note;
        if (dailyMax > 0) {
            const pct = Math.min(100, Math.round((dailySoFar / dailyMax) * 100));
            if (remainingDaily <= 0) {
                note =
                    `You've used 100% of today's budget ($${dailySoFar.toFixed(2)} / $${dailyMax.toFixed(2)}). ` +
                        `This run may stop almost immediately — drop :moneybag: to override the daily cap, or wait for the UTC reset.`;
            }
            else if (remainingDaily < (requested ?? sessionDefault)) {
                note =
                    `Heads up: you've used ${pct}% of today's budget ` +
                        `($${dailySoFar.toFixed(2)} / $${dailyMax.toFixed(2)}), only ~$${remainingDaily.toFixed(2)} left today. ` +
                        `Recommended budget for this run capped at $${recommended.toFixed(2)}. If that's low, reply with a higher budget or drop :moneybag: to override the cap.`;
            }
        }
        return { recommended, note, dailySoFar, dailyMax, remainingDaily };
    }
    // beta.108: a capability list a HUMAN can ask for.
    //
    // Every other tool is addressed to the calling agent -- users never type
    // `harness_revise`, they say "fix the findings" and the agent picks. That
    // works only when the agent's read of the tool descriptions is complete, and
    // it leaves a person with no way to find out what is on offer. Asking "what
    // can you do with this repo?" had no answer. This gives one, in the user's
    // language rather than in tool names.
    disposers.push(toDispose(api.registerTool({
        name: "harness_help",
        description: "Explain what the harness can do, in plain language, for a HUMAN. Use when someone asks what the harness is, what it can do, how to start a change, what happens after a PR is opened, what the reactions/budget controls are, or when they seem stuck about what to ask for next. Returns `capabilities` (grouped, user-facing) and `tools` (the machine names behind them). Relay the capabilities, not the tool names -- users do not invoke tools, you do.",
        parameters: {
            type: "object",
            properties: {
                topic: {
                    type: "string",
                    enum: ["all", "starting", "during", "after", "budget"],
                    description: "Narrow the answer: starting a change, controlling a run in flight, what to do once a PR exists, or how budgets/caps work. Default 'all'.",
                },
            },
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const topic = String(input?.topic ?? "all");
            const help = buildHarnessHelp(topic);
            return {
                content: [{ type: "text", text: JSON.stringify(help) }],
                details: { ok: true, topic },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_status",
        description: "Return harness runtime status: active sessions, monthly spend per user, model config.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: (_callId, _params) => {
            const sessions = liveDb()
                .prepare(`SELECT id, status, requester, repo, branch, cycles_ran, cost_usd,
                      datetime(created_at/1000,'unixepoch') AS created
               FROM sessions
               WHERE status NOT IN ('done','failed','aborted')
               ORDER BY created_at DESC`)
                .all();
            const month = new Date().toISOString().slice(0, 7);
            const spend = liveDb()
                .prepare(`SELECT user, spent_usd, session_count
               FROM budgets_monthly WHERE month = ?
               ORDER BY spent_usd DESC`)
                .all(month);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            activeSessions: sessions,
                            monthlySpend: spend,
                            effectiveBackendRoutes: liveRuntime().effectiveBackendRoutes ?? [],
                            channel: liveConfig().slack.channel,
                            reposAllowed: liveConfig().repos.allowed,
                        }, null, 2),
                    },
                ],
                details: {
                    ok: true,
                    activeSessionCount: sessions.length,
                },
            };
        },
    })));
    // beta.37: poll-model progress. The harness is tool-driven and must not post
    // to Slack itself. The calling OpenClaw agent polls THIS tool on an interval
    // (e.g. every 30-60s) and relays each new update to Slack in its own voice,
    // stopping when `terminal` is true. All data is read straight from the
    // sessions / sub_tasks / audit_log tables the loop already writes -- no new
    // hot-path writes. Returns a `headline` string the agent can post verbatim.
    disposers.push(toDispose(api.registerTool({
        name: "harness_progress",
        description: "Poll live progress for a harness run started by harness_run / harness_start_session. Returns the current phase, per-sub-task N/M status, running cost vs budget, recent lifecycle events, PR/deploy state, ms-since-last-event, a ready-to-post `headline` line, and (beta.108) `worklog`: one line per sub-task saying what it actually did. Poll on an interval (~30-60s) and relay `headline` plus `worklog` to the user, stopping when `terminal` is true -- EDIT your previous progress message in place rather than posting a new one each poll, so a 30-sub-task run is one living message and not 30 notifications. When the run is terminal the headline carries the merge recommendation; relay it verbatim, because a `do_not_merge` PR that reads as plain 'Done' will get merged by mistake. Note: when a Slack bot token is configured the harness ALSO posts progress natively (beta.77); in that mode you need not re-post, only answer questions. Use this right after kicking off a run so the user gets feedback instead of silence.",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", description: "The sessionId returned by harness_run / harness_start_session." },
                eventLimit: { type: "number", minimum: 1, maximum: 50, description: "How many recent audit events to include in the tail (default 12)." },
            },
            required: ["sessionId"],
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const opts = (input ?? {});
            const sessionId = String(opts.sessionId ?? "").trim();
            if (!sessionId) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "sessionId is required" }) }],
                    details: { ok: false },
                };
            }
            // beta.63 (Part A): pass the configured stall window so the snapshot
            // can flag `stalled: true` + `msSinceProgress` -- a poller SEES a
            // wedge instead of it looking identical to legit long work.
            const stallSeconds = liveConfig().loop.session_stall_seconds ?? 1800;
            // beta.64 (P1-5): pass the first-token watchdog window as the inner-turn
            // SDK-activity stall threshold so harness_progress.stalled flips true
            // during a mid-turn hang (not just between transitions).
            const sdkActivityStallSeconds = liveConfig().loop.sdk_first_token_timeout_seconds ?? 90;
            const snapshot = buildProgressSnapshot(liveDb(), sessionId, opts.eventLimit ?? 12, stallSeconds, sdkActivityStallSeconds);
            return {
                content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
                details: {
                    ok: snapshot.ok,
                    found: snapshot.found,
                    terminal: snapshot.terminal,
                    phase: snapshot.phase,
                    headline: snapshot.headline,
                    stalled: snapshot.stalled,
                    msSinceProgress: snapshot.msSinceProgress,
                    msSinceLastSdkActivity: snapshot.msSinceLastSdkActivity,
                },
            };
        },
    })));
    // beta.63 (Part B): harness_logs -- return the tail of a session's durable
    // interaction-log JSONL so an operator can read the SDK/state trail WITHOUT
    // shell / container access. The log lives outside the worktree so it survives
    // a worktree release + restart. Secrets are redacted on write, so the tail is
    // safe to surface. A trailing `sdk_request` with no matching `sdk_response`
    // is the exact stall signature.
    disposers.push(toDispose(api.registerTool({
        name: "harness_logs",
        description: "Read the tail of a harness session's durable interaction log (structured JSONL written OUTSIDE the git worktree). Returns the last N events: every SDK/LLM call (sdk_request/sdk_response with role, model, promptChars/promptTail, finishReason, costUsd, durationMs), every state_transition, verify_probe, refusal/env-wait/deviation, and stall/recovery event. Use this to diagnose a run that harness_progress shows as stalled -- a trailing sdk_request with no matching sdk_response is the exact hang point. Secrets are redacted on write.",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", description: "The sessionId whose interaction log to tail." },
                limit: { type: "number", minimum: 1, maximum: 1000, description: "How many trailing events to return (default 100)." },
            },
            required: ["sessionId"],
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const opts = (input ?? {});
            const sessionId = String(opts.sessionId ?? "").trim();
            if (!sessionId) {
                return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "sessionId is required" }) }], details: { ok: false } };
            }
            const ilog = liveRuntime().interactionLog;
            if (!ilog || !ilog.enabled) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ ok: false, enabled: false, reason: "interaction log is disabled (log.interaction_log_enabled=false)" }) }],
                    details: { ok: false, enabled: false },
                };
            }
            const tail = ilog.readSessionTail(sessionId, opts.limit ?? 100);
            const result = { ok: true, found: tail.found, file: tail.file, totalLines: tail.totalLines, returned: tail.events.length, events: tail.events };
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: { ok: true, found: tail.found, returned: tail.events.length, totalLines: tail.totalLines },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_retention_prune",
        description: "Prune the harness audit log per retention policy. Safe to invoke daily from cron.",
        parameters: {
            type: "object",
            properties: {
                auditRetentionDays: { type: "number", minimum: 7, maximum: 3650 },
            },
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const opts = (input ?? {});
            const result = pruneRetention(liveState(), {
                auditRetentionDays: opts.auditRetentionDays ?? liveConfig().storage.audit_retention_days,
                pruneTerminalSessions: liveConfig().storage.prune_terminal_sessions,
                pruneTerminalSessionsDays: liveConfig().storage.prune_terminal_sessions_days,
            });
            return {
                content: [
                    { type: "text", text: `Pruned ${result.auditRowsDeleted} audit rows (cutoff ${result.cutoffDay}).` },
                ],
                details: { ok: true, ...result },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_session_get",
        description: "Get full details of a harness session by id.",
        parameters: {
            type: "object",
            properties: { sessionId: { type: "string", minLength: 1 } },
            required: ["sessionId"],
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const { sessionId } = input;
            const session = liveDb()
                .prepare(`SELECT * FROM sessions WHERE id = ?`)
                .get(sessionId);
            if (!session) {
                return {
                    content: [{ type: "text", text: `No session ${sessionId}` }],
                    details: { ok: false, notFound: true },
                };
            }
            const subTasks = liveDb()
                .prepare(`SELECT * FROM sub_tasks WHERE session_id = ? ORDER BY seq ASC`)
                .all(sessionId);
            const reviews = liveDb()
                .prepare(`SELECT * FROM reviews WHERE session_id = ? ORDER BY cycle ASC`)
                .all(sessionId);
            const audit = liveDb()
                .prepare(`SELECT event, payload, datetime(created_at/1000,'unixepoch') AS ts
               FROM audit_log WHERE session_id = ? ORDER BY id ASC LIMIT 200`)
                .all(sessionId);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ session, subTasks, reviews, audit }, null, 2),
                    },
                ],
                details: { ok: true, sessionId },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_cancel",
        description: "Cancel an in-flight harness session by setting an abort flag the loop reads on its next checkpoint.",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", minLength: 1 },
                reason: { type: "string", maxLength: 500 },
                invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker. REQUIRED; must be in slack.authorised_users." },
            },
            required: ["sessionId", "invokedBy"],
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const { sessionId, reason, invokedBy } = input;
            // beta.57 (P2): invokedBy is REQUIRED. It used to be optional and
            // only checked when present, so omitting it skipped authorisation
            // entirely on a privileged (session-killing) tool.
            if (!invokedBy || !liveConfig().slack.authorised_users.includes(invokedBy)) {
                return { content: [{ type: "text", text: `Invoker ${invokedBy ?? "(missing)"} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const row = liveDb().prepare(`SELECT status, reactions_json FROM sessions WHERE id = ?`).get(sessionId);
            if (!row)
                return { content: [{ type: "text", text: `No session ${sessionId}` }], details: { ok: false, notFound: true } };
            if (["done", "failed", "aborted"].includes(row.status)) {
                return { content: [{ type: "text", text: `Session ${sessionId} is already terminal (${row.status})` }], details: { ok: false, alreadyTerminal: true, status: row.status } };
            }
            const parsed = row.reactions_json ? JSON.parse(row.reactions_json) : {};
            parsed.abort = true;
            liveDb().prepare(`UPDATE sessions SET reactions_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(parsed), Date.now(), sessionId);
            liveState().audit("tool.cancel", { sessionId, reason: reason ?? "tool-invoked", invokedBy: invokedBy ?? null }, sessionId);
            return { content: [{ type: "text", text: `Abort flag set on ${sessionId}. The loop will terminate at its next checkpoint.` }], details: { ok: true, sessionId } };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_merge_pr",
        description: "Merge the pull request a completed harness session opened, then verify the deployment. HARD SAFETY GATE: the harness only merges when its post-ship recommendation is 'merge'. If the recommendation is 'do_not_merge' (or CI is failing), it REFUSES and the user must merge from the GitHub UI — the harness cannot be told to override. Use after a session reaches 'done' with a PR, when the user has approved the merge. On a Vercel-enabled repo it polls the deployment for the merge commit and reports READY/ERROR (with build logs on error).",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", minLength: 1, description: "The harness session whose PR to merge." },
                invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker. REQUIRED; must be in slack.authorised_users." },
                repairBudgetUsd: { type: "number", minimum: 0, description: "Optional override (USD) for the post-merge deploy-repair budget on Vercel projects. Defaults to budgets.daily_max_usd * vercel.deploy_repair.budget_ratio." },
            },
            required: ["sessionId", "invokedBy"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { sessionId, invokedBy, repairBudgetUsd } = input;
            const res = await liveRuntime().mergePr({ sessionId, invokedBy, repairBudgetUsd });
            return { content: [{ type: "text", text: res.message }], details: res };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_upload_logs",
        description: "Attach runtime logs to a session manually. Use when the target repo does NOT deploy to Vercel (Cloudflare, AWS, on-prem) or when the Vercel bridge is disabled. The adversary reads the most recent upload for a session and treats it as runtime evidence with provider=\"manual\".",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", minLength: 1 },
                uploadedBy: { type: "string", minLength: 1, description: "Slack user id of the uploader (must be in authorised_users)" },
                status: { type: "string", enum: ["ok", "build_failed", "no_deploy_yet", "unavailable"] },
                logsExcerpt: { type: "string", minLength: 1, description: "Raw log text. Capped at 16KB; extra characters truncated." },
                source: { type: "string", description: "Free-form label, e.g. 'prod nginx access log' or 'AWS CloudWatch /aws/lambda/foo'" },
                errorCount: { type: "number", minimum: 0 },
                deploymentUrl: { type: "string" },
            },
            required: ["sessionId", "uploadedBy", "status", "logsExcerpt"],
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const p = input;
            if (!liveConfig().slack.authorised_users.includes(p.uploadedBy)) {
                return { content: [{ type: "text", text: `Uploader ${p.uploadedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const sess = liveDb().prepare(`SELECT id, status FROM sessions WHERE id=?`).get(p.sessionId);
            if (!sess?.id) {
                return { content: [{ type: "text", text: `Unknown session ${p.sessionId}` }], details: { ok: false, notFound: true } };
            }
            const CAP = 16 * 1024;
            const excerpt = p.logsExcerpt.length > CAP ? p.logsExcerpt.slice(0, CAP) + "\n[...truncated at 16KB]" : p.logsExcerpt;
            liveDb()
                .prepare(`INSERT INTO runtime_uploads (session_id, uploaded_by, source, status, logs_excerpt, error_count, deployment_url, uploaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(p.sessionId, p.uploadedBy, p.source ?? null, p.status, excerpt, p.errorCount ?? null, p.deploymentUrl ?? null, Date.now());
            liveState().audit("runtime.upload", { uploadedBy: p.uploadedBy, status: p.status, bytes: excerpt.length, source: p.source }, p.sessionId);
            return { content: [{ type: "text", text: `Uploaded ${excerpt.length} bytes of runtime logs for ${p.sessionId} (status=${p.status}). Adversary will pick this up on the next cycle.` }], details: { ok: true, bytes: excerpt.length } };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_start_session",
        description: [
            "Start a harness session from a STRUCTURED brief (skips the classifier/crystalliser). Use this when you have already refined the request into title + motivation + acceptance criteria. For a raw natural-language request, use harness_run instead. Slack channel/thread are optional; when omitted, progress is not posted to Slack and you poll harness_status / harness_session_get for the outcome.",
            "AUTOMATIC PROGRESS (REQUIRED): the harness NEVER posts to Slack itself. AFTER this returns ok:true, you MUST immediately begin surfacing progress: poll harness_progress with the returned sessionId every ~45s and relay its headline to the user, stopping when terminal is true. The success result carries a details.feedback directive with the exact poll target, interval, field, and stop condition -- follow it. Prefer scheduling a ~45s cron that calls harness_progress and posts each new headline. Do NOT fire-and-forget and leave the user in silence.",
            "",
            // beta.22: same OKF forwarding rule as harness_run.
            "OKF forwarding: if your context contains `Relevant Knowledge (OKF)` blocks that relate to the brief, include them under `brief.relevantConcepts` using the same shape documented on `harness_run`. Optional; omit when there are no relevant blocks.",
        ].join("\n"),
        parameters: {
            type: "object",
            properties: {
                requester: { type: "string", minLength: 1, description: "Slack user id of the requester (must be in slack.authorised_users)" },
                slackChannel: { type: "string", minLength: 1, description: "Optional. Slack channel to post progress into." },
                slackThread: { type: "string", minLength: 1, description: "Optional. Thread ts to reply into. Omit for agent-orchestrated runs with no Slack thread." },
                brief: {
                    type: "object",
                    required: ["title", "motivation", "acceptanceCriteria"],
                    properties: {
                        title: { type: "string", minLength: 3 },
                        motivation: { type: "string", minLength: 10 },
                        acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 3 } },
                        filesLikelyTouched: { type: "array", items: { type: "string" } },
                        outOfScope: { type: "array", items: { type: "string" } },
                        // beta.21: pass-through OKF concept refs on a pre-built brief.
                        relevantConcepts: {
                            type: "array",
                            description: "Optional. OKF concept references relevant to this brief. Each item: { id, path?, summary?, tags?, content? }. See harness_run docs for semantics.",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string", minLength: 1 },
                                    path: { type: "string" },
                                    summary: { type: "string" },
                                    tags: { type: "array", items: { type: "string" } },
                                    content: { type: "string" },
                                },
                                required: ["id"],
                                additionalProperties: false,
                            },
                        },
                        repoHint: { type: "string" },
                        branchHint: {
                            type: "string",
                            description: "Optional branch name hint. NOT authoritative: the harness namespaces all branches under 'harness/' and slugifies the hint, so the actual branch may differ (e.g. 'smoke/x' -> 'harness/smoke-x'). Read the resolved branch from harness_status or harness_session_get after planning.",
                        },
                        riskLevel: { type: "string", enum: ["low", "medium", "high"] },
                    },
                },
                budgetUsd: {
                    type: "number",
                    minimum: 0.05,
                    description: "Optional per-session budget override (USD). Minimum 0.05; sub-$1 budgets are valid for plan-only dry runs. Capped at budgets.session_hard_ceiling_usd and remaining monthly budget.",
                },
            },
            required: ["requester", "brief"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { requester, slackChannel, slackThread, brief, budgetUsd } = input;
            const briefFull = {
                title: brief.title,
                motivation: brief.motivation,
                acceptanceCriteria: brief.acceptanceCriteria,
                filesLikelyTouched: brief.filesLikelyTouched ?? [],
                outOfScope: brief.outOfScope ?? [],
                relevantConcepts: brief.relevantConcepts,
                repoHint: brief.repoHint,
                branchHint: brief.branchHint,
                riskLevel: (brief.riskLevel ?? "low"),
            };
            const res = startSessionFromBrief({
                requester, brief: briefFull, slackChannel, slackThread, budgetUsd,
                auditEvent: "tool.start_session",
            });
            if (!res.ok) {
                return { content: [{ type: "text", text: res.reason }], details: { ok: false, unauthorised: res.unauthorised, duplicateThread: res.duplicateThread } };
            }
            // beta.120: a caller-built brief is MORE exposed to paraphrase drift
            // than harness_run's, not less -- the caller wrote the acceptance
            // criteria itself. Same gate.
            if (res.awaitingConfirmation === true) {
                return {
                    content: [{ type: "text", text: res.question }],
                    details: {
                        ok: true,
                        sessionId: res.sessionId,
                        awaitingConfirmation: true,
                        question: res.question,
                        estimatedUsd: res.estimatedUsd,
                        effectiveBudget: res.effectiveBudget,
                        feedback: {
                            instruction: "STOP and show `question` to the user verbatim before anything is spent. Do NOT confirm on their behalf. Relay their reply to harness_answer with this sessionId.",
                            answerWith: "harness_answer",
                            args: { sessionId: res.sessionId, answer: "<the user's reply, verbatim>" },
                        },
                    },
                };
            }
            const feedback = {
                poll: "harness_progress",
                args: { sessionId: res.sessionId },
                intervalSeconds: 45,
                relayField: "headline",
                until: "terminal",
                instruction: "Poll harness_progress with this sessionId every ~45s and relay its `headline` (or a rephrase) to the user until `terminal` is true. Prefer scheduling a 45s cron so progress surfaces across turns. Do not fire-and-forget -- the harness does NOT post to Slack itself.",
            };
            return { content: [{ type: "text", text: `Session ${res.sessionId} started. Surface progress automatically: poll harness_progress (sessionId ${res.sessionId}) every ~45s and relay \`headline\` until terminal. The harness will not post to Slack itself.` }], details: { ok: true, sessionId: res.sessionId, feedback } };
        },
    })));
    // ---- harness_run: the PRIMARY agent entry point ----
    //
    // Takes a raw natural-language request, runs the SAME classify -> refine
    // pipeline the Slack listener uses, and either (a) starts a session and
    // returns its id, (b) returns a clarifying question for the agent to put
    // back to the user, or (c) rejects (not a dev task / unsafe). This is how
    // the OpenClaw agent orchestrates the harness end to end.
    disposers.push(toDispose(api.registerTool({
        name: "harness_run",
        description: [
            "PRIMARY entry point. Hand the harness a raw natural-language coding request; it classifies + crystallises it into a brief and starts a session (plan -> parallel workers -> adversarial review -> PR). Returns either a started sessionId, a clarifying question to relay to the user, or a rejection. Use this instead of harness_start_session unless you have already built a structured brief. Slack channel/thread are optional; omit them for pure agent-orchestrated runs and poll harness_status for the outcome.",
            "",
            // beta.120: the b119 take-2 smoke lost the feature between the
            // user's file and this parameter. The caller had a 10,710-byte
            // spec and sent a ~40-line summary it wrote itself; `performedAt`
            // became `scheduledAt` and five model fields vanished. The harness
            // built the summary faithfully, twice, at ~$18 and ~2h each. The
            // crystalliser was never the problem -- the same file read off
            // disk crystallises with every field intact.
            "PASS THE USER'S WORDS VERBATIM. `request` must be the user's request text IN FULL, exactly as they wrote it. If the user supplied a spec, a markdown file, a ticket body or a long message, pass ALL of it, byte for byte. Do NOT summarise it, do NOT condense it into acceptance criteria, do NOT rename or invent field names, and do NOT 'tidy up' the structure. Crystallising the request into a brief is THIS TOOL'S job and it is good at it; a paraphrase silently changes what gets built, and neither you nor the user will see the substitution until a PR arrives hours later. Length is not a problem -- a 10KB spec is normal and welcome. If you are tempted to shorten it, don't.",
            "IF THE REQUEST CAME FROM A FILE, pass `requestPath` (absolute) INSTEAD of retyping it and the harness reads the bytes itself. This is the safest option and is strongly preferred whenever a path exists. You may pass both: the file always wins, and the harness records how far your `request` text drifted from it.",
            "AUTOMATIC PROGRESS (REQUIRED): the harness NEVER posts to Slack itself. AFTER this returns ok:true, you MUST immediately begin surfacing progress: poll harness_progress with the returned sessionId every ~45s and relay its headline to the user, stopping when terminal is true. The success result carries a details.feedback directive with the exact poll target, interval, field, and stop condition -- follow it. Prefer scheduling a ~45s cron that calls harness_progress and posts each new headline, so progress surfaces even across turns. Do NOT fire-and-forget and leave the user in silence.",
            "",
            // beta.22: explicit OKF forwarding instruction. The OKF plugin
            // surfaces "Relevant Knowledge" blocks in your (the calling
            // agent's) context. Beta.21 wired the pass-through, beta.22
            // teaches YOU to use it. Beta.23 will add a plugin-side hook
            // that enforces this deterministically.
            "REQUIRED WHEN OKF CONTEXT IS PRESENT: if your current turn's context contains one or more `Relevant Knowledge (OKF)` blocks whose subject matter overlaps this request (retry logic, an integration, a documented workflow, etc.), you MUST forward them as `relevantConcepts` on this tool call. Each block gives you an `ID`, an optional description, and links; map them like this:",
            "  - `id`: the block's `ID:` value (e.g. `services/retry`, `workflows/gmail-sync`).",
            "  - `path`: if the block references a file in the target repo, include it here (repo-relative). Omit otherwise.",
            "  - `summary`: the block's one-line description.",
            "  - `tags`: the block's `Tags:` list, verbatim.",
            "  - `content`: OPTIONAL. If you can read the concept file itself and its size is under a few thousand chars, include the full markdown here — this is the biggest quality lever on large (10K+ LOC) repos because the worker starts primed instead of exploring the tree blind.",
            "Do NOT invent concept ids the OKF context did not surface. Do NOT forward OKF blocks whose subject is clearly unrelated to the request (e.g. an unrelated infrastructure concept when the request is a docs typo fix) — forward only what's genuinely relevant.",
            "If your context contains NO OKF blocks, or none are relevant, omit `relevantConcepts` entirely. Do not pass an empty array.",
        ].join("\n"),
        parameters: {
            type: "object",
            properties: {
                requester: { type: "string", minLength: 1, description: "Slack user id of the requester (must be in slack.authorised_users)" },
                request: {
                    type: "string",
                    minLength: 10,
                    description: "The user's coding request, VERBATIM AND COMPLETE. Copy their text exactly -- full spec, all sections, all field names. Never summarise, condense into acceptance criteria, or reword: the harness crystallises it for you, and a paraphrase silently builds a different feature. Optional only when `requestPath` is given.",
                },
                requestPath: {
                    type: "string",
                    minLength: 1,
                    description: "beta.120. Optional but PREFERRED when the request came from a file: an absolute path to the user's specification. The harness reads the bytes itself, which removes any chance of the text being paraphrased in transit. The file must sit inside a configured `brief.request_file_roots` directory. If both this and `request` are supplied, the file wins.",
                },
                slackChannel: { type: "string", minLength: 1, description: "Optional. Slack channel to post progress into." },
                slackThread: { type: "string", minLength: 1, description: "Optional. Thread ts to reply into." },
                budgetUsd: {
                    type: "number",
                    minimum: 0.05,
                    description: "Optional per-session budget override (USD). Minimum 0.05; sub-$1 budgets are valid for plan-only dry runs. Capped at budgets.session_hard_ceiling_usd and remaining monthly budget.",
                },
                // beta.21: OKF concept pass-through.
                relevantConcepts: {
                    type: "array",
                    description: "Optional. OKF concept references the OpenClaw agent's context enrichment surfaced as relevant to this request. The harness does NOT crawl OKF itself; this is the pass-through so concepts propagate into the crystallised brief, the lead plan's file hints, and the worker system prompts. Each item: { id, path?, summary?, tags?, content? }. Content is bounded at ~4KB per concept in worker prompts (auto-truncated).",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string", minLength: 1, description: "OKF concept id (e.g. 'services/retry')." },
                            path: { type: "string", description: "Optional relative path in the target repo where the concept file lives." },
                            summary: { type: "string", description: "Human-facing one-line summary." },
                            tags: { type: "array", items: { type: "string" }, description: "OKF tags; used by the lead as heuristic out-of-scope hints." },
                            content: { type: "string", description: "Optional concept file body (markdown). Injected into the worker prompt when the sub-task touches this concept's path." },
                        },
                        required: ["id"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["requester"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { requester, request, requestPath, slackChannel, slackThread, budgetUsd, relevantConcepts } = input;
            if (!liveConfig().slack.authorised_users.includes(requester)) {
                return { content: [{ type: "text", text: `Requester ${requester} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            // beta.120 (brief fidelity): prefer bytes on disk over a calling
            // agent's retelling of them. When both arrive, the file wins and the
            // drift is measured into the audit log -- on the b119 take-2 smoke
            // that record would have shown a 0.19 size ratio and a dropped
            // `performedAt`, which is the entire bug in one event.
            let effectiveRequest = typeof request === "string" ? request : "";
            let requestSourcePath;
            if (typeof requestPath === "string" && requestPath.trim().length > 0) {
                const read = readRequestFile(requestPath.trim(), {
                    allowedRoots: liveConfig().brief?.request_file_roots ?? [],
                    maxBytes: liveConfig().brief?.request_file_max_bytes ?? 262144,
                });
                if (!read.ok) {
                    liveState().audit("tool.run.request_file_rejected", { requester, requestPath, code: read.code });
                    // Fall back to the supplied text only if there IS usable text;
                    // otherwise this is a hard, actionable failure.
                    if (effectiveRequest.trim().length < 10) {
                        return {
                            content: [{ type: "text", text: `${read.message}\n\nEither fix the path, configure brief.request_file_roots, or pass the full text as \`request\`.` }],
                            details: { ok: false, requestFileError: true, code: read.code },
                        };
                    }
                }
                else {
                    if (effectiveRequest.trim().length >= 10) {
                        const drift = measureParaphraseDrift(read.text, effectiveRequest);
                        liveState().audit("tool.run.paraphrase_discarded", {
                            requester,
                            path: read.resolvedPath,
                            fileBytes: drift.fileBytes,
                            paraphraseBytes: drift.paraphraseBytes,
                            ratio: drift.ratio,
                            material: drift.material,
                            droppedTerms: drift.droppedTerms,
                        });
                    }
                    effectiveRequest = read.text;
                    requestSourcePath = read.resolvedPath;
                    liveState().audit("tool.run.request_from_file", { requester, path: read.resolvedPath, bytes: read.bytes });
                }
            }
            if (effectiveRequest.trim().length < 10) {
                return {
                    content: [{ type: "text", text: "Supply the user's request as `request` (verbatim, in full) or point `requestPath` at their spec file." }],
                    details: { ok: false, missingRequest: true },
                };
            }
            let cResult;
            try {
                cResult = await liveRuntime().crystallise(effectiveRequest, relevantConcepts);
            }
            catch (err) {
                // beta.24: log the error inline in the message string so it
                // survives log-parsers that strip the meta object. Staging's
                // beta.23 smoke lost the crystallise error entirely to that
                // stripping -- we saw `crystallise failed` with no reason for
                // hours because the reason was in `meta.err` and the log line
                // only rendered the message. Repeat the meta anyway for
                // downstream consumers that DO read structured fields.
                const reason = String(err);
                api.logger.error(`[tool.run] crystallise failed: ${reason}`, { requester, err: reason });
                return { content: [{ type: "text", text: `Crystallisation failed: ${reason}` }], details: { ok: false, crystalliseError: true } };
            }
            if (cResult.kind === "reject") {
                liveState().audit("tool.run.rejected", { requester, intent: cResult.intent, reason: cResult.reason });
                return { content: [{ type: "text", text: `Request rejected (${cResult.intent}): ${cResult.reason}` }], details: { ok: false, rejected: true, intent: cResult.intent, reason: cResult.reason } };
            }
            if (cResult.kind === "clarify") {
                return { content: [{ type: "text", text: `Needs clarification: ${cResult.question}` }], details: { ok: false, needsClarification: true, question: cResult.question } };
            }
            // beta.25 preflight: if the brief pins a concrete repo, verify we
            // have everything (routing + name + email + token) for THIS
            // requester before starting a run. Fail up front with an
            // actionable ask rather than dying mid-run on a missing email or
            // an unauthorised requester. When repoHint is a glob or absent,
            // the lead picks the repo and allocateWorktree enforces the same
            // checks (with clear errors) at that point.
            const repoHint = cResult.brief.repoHint;
            if (repoHint && repoHint.includes("/") && !repoHint.includes("*")) {
                const pf = await liveRuntime().preflight({ requester, repoFullName: repoHint });
                if (!pf.ok) {
                    liveState().audit("tool.run.preflight_incomplete", { requester, repo: repoHint, missing: pf.missing, provenance: pf.provenance });
                    return {
                        content: [{ type: "text", text: pf.message }],
                        details: { ok: false, preflightIncomplete: true, missing: pf.missing, repo: repoHint },
                    };
                }
            }
            const res = startSessionFromBrief({
                requester, brief: cResult.brief, slackChannel, slackThread, budgetUsd,
                auditEvent: "tool.run",
                sourcePath: requestSourcePath,
            });
            if (!res.ok) {
                return { content: [{ type: "text", text: res.reason }], details: { ok: false, unauthorised: res.unauthorised, duplicateThread: res.duplicateThread } };
            }
            // beta.120: paused for a human to confirm the brief. Nothing has been
            // spent beyond crystallisation and nothing will be until an answer
            // arrives, so the caller must PUT THE QUESTION TO THE USER rather
            // than poll or answer on their behalf.
            if (res.awaitingConfirmation === true) {
                return {
                    content: [{ type: "text", text: res.question }],
                    details: {
                        ok: true,
                        sessionId: res.sessionId,
                        awaitingConfirmation: true,
                        question: res.question,
                        brief: cResult.brief,
                        estimatedUsd: res.estimatedUsd,
                        effectiveBudget: res.effectiveBudget,
                        feedback: {
                            instruction: "STOP and show `question` to the user verbatim -- it is the brief the harness is about to build, and this is the last cheap moment to catch a misunderstanding. Do NOT confirm on the user's behalf, do NOT poll harness_progress yet, and do NOT start another run. When they reply, call harness_answer with this sessionId and their reply as `answer`: an approval starts the run, anything else is folded in as a correction first.",
                            answerWith: "harness_answer",
                            args: { sessionId: res.sessionId, answer: "<the user's reply, verbatim>" },
                        },
                    },
                };
            }
            const feedback = {
                poll: "harness_progress",
                args: { sessionId: res.sessionId },
                intervalSeconds: 45,
                relayField: "headline",
                until: "terminal",
                instruction: "Poll harness_progress with this sessionId every ~45s and relay its `headline` (or a rephrase) to the user until `terminal` is true. Prefer scheduling a 45s cron so progress surfaces across turns. Do not fire-and-forget -- the harness does NOT post to Slack itself.",
            };
            // beta.78 (Feature 1): prepend the daily-aware budget note (if any)
            // so the agent relays the recommendation/low-headroom nudge to the
            // user. Soft default -- the run already started at effectiveBudget.
            // beta.81 (Track A / A1): ALSO surface the harness-owned SESSION
            // ESTIMATE up front, UNCONDITIONALLY (independent of the daily-cap
            // note, which only fires under daily-cap pressure). This is the
            // "Estimated ~$X for this change; session cap $Y" line Carel asked
            // for -- persisted on the session row + echoed here so it surfaces
            // even if the agent never relays the note. Soft: the run already
            // started at effectiveBudget.
            const estimateLine = `Estimated ~$${res.estimatedUsd.toFixed(2)} for this change; session cap $${res.effectiveBudget.toFixed(2)}.`;
            const budgetLine = res.budgetNote ? `${res.budgetNote}\n\n` : "";
            return {
                content: [{ type: "text", text: `${budgetLine}${estimateLine} Session ${res.sessionId} started for "${cResult.brief.title}". Surface progress automatically: poll harness_progress (sessionId ${res.sessionId}) every ~45s and relay \`headline\` until terminal. The harness will not post to Slack itself.` }],
                details: { ok: true, sessionId: res.sessionId, brief: cResult.brief, feedback, budgetNote: res.budgetNote ?? null, effectiveBudget: res.effectiveBudget, recommendedBudget: res.recommendedBudget, estimatedUsd: res.estimatedUsd },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_health",
        description: "Return a health snapshot: DB reachable, schema OK, config well-formed, effective model routes/auth resolvable, credentials configured. Pass { deep: true } to probe the configured backends.",
        parameters: {
            type: "object",
            properties: {
                deep: {
                    type: "boolean",
                    description: "If true, perform a minimal live SDK call to verify the Anthropic key authenticates (catches expired/invalid keys, not just missing ones). Costs a few tokens.",
                },
            },
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { deep } = (input ?? {});
            const checks = [];
            // DB reachable?
            try {
                liveDb().prepare(`SELECT 1`).get();
                checks.push({ name: "db_reachable", ok: true });
            }
            catch (err) {
                checks.push({ name: "db_reachable", ok: false, detail: String(err) });
            }
            // Schema tables present?
            const need = ["sessions", "sub_tasks", "reviews", "budgets_daily", "budgets_monthly", "audit_log"];
            for (const t of need) {
                const row = liveDb()
                    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
                    .get(t);
                checks.push({ name: `table_${t}`, ok: !!row?.name });
            }
            // Config: minimally-valid?
            // beta.57 (P3) made slack.channel conditional on listener mode.
            // beta.133 removed that mode, so an empty channel is simply correct
            // config: there is nothing to listen on, and the channel is only an
            // outbound posting target.
            checks.push({
                name: "config_slack_channel",
                ok: true,
                detail: liveConfig().slack.channel || "(not required: outbound posting only)",
            });
            checks.push({ name: "config_authorised_users", ok: liveConfig().slack.authorised_users.length > 0 });
            checks.push({ name: "config_repos_allowed", ok: liveConfig().repos.allowed.length > 0 });
            const effectiveRoutes = liveRuntime().effectiveBackendRoutes ?? [];
            const needsAnthropic = effectiveRoutes.length === 0 ||
                effectiveRoutes.some((route) => route.backend === "claude-code");
            checks.push({
                name: "effective_backend_routes",
                ok: true,
                detail: effectiveRoutes.length > 0 ? JSON.stringify(effectiveRoutes) : "legacy route metadata unavailable",
            });
            // Resolve Anthropic only when an effective role actually uses it.
            const auth = liveConfig().models.auth ?? {};
            let apiKey;
            if (needsAnthropic) {
                try {
                    const resolver = liveRuntime().anthropicApiKey;
                    apiKey = typeof resolver === "function" ? await resolver() : undefined;
                }
                catch (err) {
                    checks.push({ name: "model_auth_resolvable", ok: false, detail: String(err) });
                }
                if (apiKey !== undefined || !checks.some((c) => c.name === "model_auth_resolvable")) {
                    const src = auth.credential_service
                        ? `vault:${auth.credential_service}`
                        : `env:${auth.api_key_env || "ANTHROPIC_API_KEY"}`;
                    checks.push({
                        name: "model_auth_resolvable",
                        ok: !!apiKey,
                        detail: apiKey ? `resolved via ${src}` : `no key from ${src} (SDK will fall back to /login and fail headless)`,
                    });
                }
            }
            else {
                checks.push({ name: "model_auth_resolvable", ok: true, detail: "Anthropic not required by effective routes" });
            }
            // Optional deep check: a tiny live SDK call proves the key actually
            // authenticates (catches expired/invalid keys, not just missing).
            if (deep) {
                try {
                    await liveRuntime().ensureBackendReady?.();
                    checks.push({ name: "configured_backend_probe", ok: true });
                }
                catch (err) {
                    checks.push({ name: "configured_backend_probe", ok: false, detail: String(err) });
                }
                if (!needsAnthropic) {
                    checks.push({ name: "model_auth_live_ping", ok: true, detail: "covered by configured backend probe" });
                }
                else if (!apiKey) {
                    checks.push({ name: "model_auth_live_ping", ok: false, detail: "skipped: no key to test" });
                }
                else {
                    try {
                        const { runClassifierSdk } = await import("../adapters/claude-code.js");
                        await runClassifierSdk({
                            model: liveConfig().models.classifier,
                            userText: "ping",
                            timeoutSeconds: 30,
                            apiKey,
                        });
                        checks.push({ name: "model_auth_live_ping", ok: true, detail: "SDK authenticated" });
                    }
                    catch (err) {
                        const msg = String(err);
                        const isAuth = /not logged in|\/login|401|unauthor|authentication/i.test(msg);
                        checks.push({
                            name: "model_auth_live_ping",
                            ok: false,
                            detail: isAuth ? `auth rejected: ${msg.slice(0, 160)}` : `ping failed (non-auth): ${msg.slice(0, 160)}`,
                        });
                    }
                }
            }
            // GitHub auth: can we resolve a token for the target repo? A missing
            // token means the FIRST session dies at plan phase with a vault
            // "not found" error -- so this is FATAL, same rationale as model auth.
            let gitRes;
            let ghToken;
            try {
                const resFn = liveRuntime().gitResolutionFor;
                gitRes = typeof resFn === "function" ? resFn() : undefined;
                const tokFn = liveRuntime().gitToken;
                if (typeof tokFn === "function" && gitRes) {
                    ghToken = await tokFn(gitRes);
                }
            }
            catch { /* resolution failed -> ghToken stays undefined */ }
            {
                const src = gitRes ? `vault:${gitRes.credentialService}` : "(no service resolvable)";
                const envName = gitRes?.apiKeyEnv ?? "GH_TOKEN";
                checks.push({
                    name: "git_credential_resolvable",
                    ok: !!ghToken,
                    detail: ghToken
                        ? `[${gitRes?.provider}] resolved via ${src} or env:${envName}`
                        : `no token from ${src} or env:${envName} (plan phase will fail)`,
                });
            }
            // Optional deep check: verify the token actually authenticates,
            // provider-aware (GitHub GET /user, GitLab GET /user).
            if (deep) {
                if (!ghToken || !gitRes) {
                    checks.push({ name: "git_credential_live_ping", ok: false, detail: "skipped: no token to test" });
                }
                else {
                    try {
                        const isGitlab = gitRes.provider === "gitlab";
                        const url = isGitlab ? `${gitRes.apiBase}/user` : `${gitRes.apiBase}/user`;
                        const headers = isGitlab
                            ? { "PRIVATE-TOKEN": ghToken, "User-Agent": "openclaw-agent-harness" }
                            : { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "User-Agent": "openclaw-agent-harness" };
                        const resp = await fetch(url, { headers });
                        if (resp.ok) {
                            const who = (await resp.json().catch(() => ({})));
                            checks.push({ name: "git_credential_live_ping", ok: true, detail: `[${gitRes.provider}] authenticated as ${who.login ?? who.username ?? "(unknown)"}` });
                        }
                        else {
                            checks.push({ name: "git_credential_live_ping", ok: false, detail: `[${gitRes.provider}] API ${resp.status} ${resp.statusText}` });
                        }
                    }
                    catch (err) {
                        checks.push({ name: "git_credential_live_ping", ok: false, detail: `[${gitRes.provider}] ping failed (network): ${String(err).slice(0, 160)}` });
                    }
                }
            }
            // beta.110: vault health, reported EXPLICITLY. A vault that will not
            // open fails every credential lookup, and inferring that from a
            // "token not found" sends the operator hunting for a missing entry
            // when the real fault is the key. Fatal, same rationale as git auth.
            {
                const vaultErr = liveRuntime().vaultError;
                let detail = vaultErr ?? "open";
                if (!vaultErr) {
                    try {
                        detail = `open (${liveRuntime().vault.list().length} credential(s) stored)`;
                    }
                    catch (err) {
                        detail = `open, but listing failed: ${String(err)}`;
                    }
                }
                checks.push({ name: "credential_vault_open", ok: !vaultErr, detail });
            }
            // Credentials: are we set to talk to Slack/Vercel? (informational, not fatal)
            checks.push({ name: "slack_credential_service_set", ok: !!liveConfig().slack.credential_service });
            checks.push({ name: "vercel_enabled", ok: !!liveConfig().vercel?.enabled });
            const overall = checks
                .filter((c) => c.name.startsWith("table_") ||
                c.name === "db_reachable" ||
                c.name.startsWith("config_") ||
                c.name === "model_auth_resolvable" ||
                c.name === "model_auth_live_ping" ||
                c.name === "git_credential_resolvable" ||
                c.name === "git_credential_live_ping" ||
                c.name === "credential_vault_open")
                .every((c) => c.ok);
            return {
                content: [
                    {
                        type: "text",
                        text: `Health: ${overall ? "OK" : "DEGRADED"}\n` +
                            checks.map((c) => `${c.ok ? ":white_check_mark:" : ":x:"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("\n"),
                    },
                ],
                details: { ok: overall, checks },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_telemetry",
        description: "Return cost + activity telemetry: monthly ledger, session-level cost breakdown, model mix.",
        parameters: {
            type: "object",
            properties: {
                month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "YYYY-MM. Defaults to current month." },
                user: { type: "string", description: "Optional user id filter" },
            },
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const { month, user } = (input ?? {});
            const targetMonth = month ?? new Date().toISOString().slice(0, 7);
            const monthlyRows = user
                ? liveDb().prepare(`SELECT month, user, spent_usd, session_count FROM budgets_monthly WHERE month = ? AND user = ?`).all(targetMonth, user)
                : liveDb().prepare(`SELECT month, user, spent_usd, session_count FROM budgets_monthly WHERE month = ? ORDER BY spent_usd DESC`).all(targetMonth);
            const dailyRows = user
                ? liveDb().prepare(`SELECT day, user, spent_usd FROM budgets_daily WHERE day LIKE ? AND user = ? ORDER BY day DESC`).all(`${targetMonth}%`, user)
                : liveDb().prepare(`SELECT day, user, spent_usd FROM budgets_daily WHERE day LIKE ? ORDER BY day DESC`).all(`${targetMonth}%`);
            const sessionRows = user
                ? liveDb().prepare(`SELECT id, status, requester, repo, cost_usd, cycles_ran, datetime(created_at/1000,'unixepoch') AS created FROM sessions WHERE requester = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 100`).all(user, monthStart(targetMonth))
                : liveDb().prepare(`SELECT id, status, requester, repo, cost_usd, cycles_ran, datetime(created_at/1000,'unixepoch') AS created FROM sessions WHERE created_at >= ? ORDER BY created_at DESC LIMIT 100`).all(monthStart(targetMonth));
            const totals = {
                monthUsd: monthlyRows.reduce((a, r) => a + (r.spent_usd || 0), 0),
                sessions: sessionRows.length,
                shipped: sessionRows.filter((s) => s.status === "done").length,
                failed: sessionRows.filter((s) => s.status === "failed").length,
                aborted: sessionRows.filter((s) => s.status === "aborted").length,
                active: sessionRows.filter((s) => !["done", "failed", "aborted", "interrupted"].includes(s.status)).length,
            };
            return {
                content: [{ type: "text", text: JSON.stringify({ month: targetMonth, totals, effectiveBackendRoutes: liveRuntime().effectiveBackendRoutes ?? [], monthly: monthlyRows, daily: dailyRows, sessions: sessionRows }, null, 2) }],
                details: { ok: true, month: targetMonth, totals },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_resume",
        description: "Resume an interrupted harness session. Requires the session to be in 'interrupted' or 'resumable' state. " +
            "beta.60: pass force:true to UNSTICK a session whose record says 'executing', 'planning', or 'reviewing' but has NO live " +
            "loop-runner (dead executor) -- e.g. the b59 seq-7 transition stall where the row sat 'executing' with no " +
            "worker process for hours, OR the beta.63 late-stage stall (harness_progress shows stalled:true) where the " +
            "session went quiet at/after the last sub-task deadline but before finalize. force is REFUSED if a live " +
            "loop-runner still owns the session (use harness_cancel instead).",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", minLength: 1 },
                invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker. REQUIRED; must be in slack.authorised_users." },
                force: { type: "boolean", description: "beta.60: unstick an 'executing'/'planning' session that has no live loop-runner (dead executor). Refused if a runner is still alive." },
            },
            required: ["sessionId", "invokedBy"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { sessionId, invokedBy, force } = input;
            // beta.57 (P2): invokedBy is REQUIRED (was optional-and-skippable).
            if (!invokedBy || !liveConfig().slack.authorised_users.includes(invokedBy)) {
                return { content: [{ type: "text", text: `Invoker ${invokedBy ?? "(missing)"} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const row = liveDb().prepare(`SELECT status, crystallised_prompt FROM sessions WHERE id = ?`).get(sessionId);
            if (!row)
                return { content: [{ type: "text", text: `No session ${sessionId}` }], details: { ok: false, notFound: true } };
            const RESUMABLE = ["interrupted", "resumable"];
            // beta.60: force-unstick path. A session can end up `executing`/`planning`
            // with its sub-task row stuck `running` but NO live loop-runner (the b59
            // PR#858 seq-7 stall: dispatcher wedged on an unbounded git/IO await, or
            // the runtime was torn down under it). harness_resume previously REFUSED
            // ("Cannot resume ... in status executing") with no escape hatch, so the
            // only recovery was cancel-and-rebuild, discarding real committed work.
            // With force:true we allow re-driving from planning IFF no live runner
            // owns the session -- checking runningSessionIds() so we never yank a
            // session out from under a genuinely-busy in-process loop.
            if (!RESUMABLE.includes(row.status)) {
                if (!force) {
                    return { content: [{ type: "text", text: `Cannot resume ${sessionId} in status ${row.status}. If the executor is dead (no live loop-runner), retry with force:true.` }], details: { ok: false, badStatus: row.status } };
                }
                if (["done", "failed", "aborted"].includes(row.status)) {
                    return { content: [{ type: "text", text: `Cannot force-resume ${sessionId}: it is terminal (${row.status}). Use harness_revise to start a fresh revise.` }], details: { ok: false, terminal: true, badStatus: row.status } };
                }
                const liveRunners = liveRuntime().loop.runningSessionIds();
                if (liveRunners.includes(sessionId)) {
                    return { content: [{ type: "text", text: `Refusing to force-resume ${sessionId}: a live loop-runner still owns it (status ${row.status}). It is genuinely running, not stuck. Use harness_cancel to stop it.` }], details: { ok: false, liveRunner: true, badStatus: row.status } };
                }
                liveState().audit("tool.resume_forced", { sessionId, wasStatus: row.status, invokedBy }, sessionId);
            }
            if (!row.crystallised_prompt) {
                return { content: [{ type: "text", text: `Session ${sessionId} has no crystallised brief; cannot resume.` }], details: { ok: false, missingBrief: true } };
            }
            const brief = JSON.parse(row.crystallised_prompt);
            liveDb().prepare(`UPDATE sessions SET status = 'planning', updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
            liveState().audit("tool.resume", { sessionId, wasStatus: row.status, invokedBy: invokedBy ?? null }, sessionId);
            // Fire-and-forget: loop takes over from planning
            void liveRuntime().loop.run(sessionId, brief).catch((err) => {
                api.logger.error("[tool.resume] loop.run failed", { sessionId, err: String(err) });
            });
            return { content: [{ type: "text", text: `Session ${sessionId} resumed. Watch the Slack thread for progress.` }], details: { ok: true, sessionId } };
        },
    })));
    // ---- beta.55 (B2): harness_answer -- resume a session paused in
    // `awaiting_clarification` by folding the human's decision into the brief
    // and re-driving the loop. This is the HUMAN-IN-THE-LOOP resume path: when a
    // worker refuses/confabulates a sub-task even after the beta.54 retry, the
    // loop pauses (not fails) and surfaces its question via harness_progress; the
    // agent relays it and calls harness_answer with the user's reply.
    // beta.56 (P0-3): this registration was `toDispose(api.registerTool(...))`
    // with the disposer DISCARDED (never pushed), so harness_answer leaked
    // across every plugin re-register: stale-generation duplicate on the next
    // register, never unregistered on teardown.
    disposers.push(toDispose(api.registerTool({
        name: "harness_answer",
        description: "Answer a harness session that is paused in 'awaiting_clarification' and resume it. " +
            "The answer is folded into the brief as a directive and the loop re-drives, building on any " +
            "work already committed. Special answers: 'abort' (or 'cancel') terminates the session; 'skip' " +
            "instructs the loop to DROP the blocked sub-task and never attempt it again; beta.122's 'accept' " +
            "(or 'keep-commit') says the commit is fine and only the plan's contract path was wrong, so the " +
            "work is kept and stays in scope for review. Relay the operator's choice verbatim -- 'skip' and " +
            "'accept' are opposites and picking the wrong one silently changes what gets built. " +
            "beta.120: also answers a pre-spend brief confirmation (harness_run returned awaitingConfirmation). " +
            "There, an approval ('confirm', 'yes', 'go ahead', ...) starts the run as-is and ANY other reply is " +
            "folded in as an authoritative correction to the brief first. Pass the user's reply verbatim and " +
            "never approve on their behalf.",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", minLength: 1 },
                answer: { type: "string", minLength: 1, description: "The human's decision for the paused sub-task." },
                invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker. REQUIRED; must be in slack.authorised_users." },
            },
            required: ["sessionId", "answer", "invokedBy"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { sessionId, answer, invokedBy } = input;
            // beta.57 (P2): invokedBy is REQUIRED -- this tool injects human text
            // into the brief and re-drives spend, so it must be authorised.
            if (!invokedBy || !liveConfig().slack.authorised_users.includes(invokedBy)) {
                return { content: [{ type: "text", text: `Invoker ${invokedBy ?? "(missing)"} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const row = liveDb()
                .prepare(`SELECT status, crystallised_prompt, lead_plan_json, clarification_question, clarification_seq, clarification_subtask,
                    clarification_heartbeat_at, final_pr_url, pr_number, branch, cost_usd
               FROM sessions WHERE id = ?`)
                .get(sessionId);
            if (!row)
                return { content: [{ type: "text", text: `No session ${sessionId}` }], details: { ok: false, notFound: true } };
            if (row.status !== "awaiting_clarification") {
                return { content: [{ type: "text", text: `Session ${sessionId} is not awaiting clarification (status ${row.status})` }], details: { ok: false, badStatus: row.status } };
            }
            if (!row.crystallised_prompt) {
                return { content: [{ type: "text", text: `Session ${sessionId} has no crystallised brief; cannot resume.` }], details: { ok: false, missingBrief: true } };
            }
            const trimmed = answer.trim();
            const seq = row.clarification_seq ?? -1;
            liveDb().prepare(`UPDATE sessions SET clarification_answer = ?, updated_at = ? WHERE id = ?`).run(trimmed, Date.now(), sessionId);
            liveState().audit("loop.clarification_answered", { sessionId, seq, answerLen: trimmed.length, invokedBy: invokedBy ?? null }, sessionId);
            // beta.129: a wall-clock question is answered by a loop that never left.
            // It is sitting at the review boundary polling this very column, so the
            // write above IS the answer. Re-driving loop.run here would start a
            // second run against the same worktree and the same branch.
            if (isTimeExtensionPause(row.clarification_subtask)) {
                const waitUntilMs = readTimeExtensionWaitUntil(row.clarification_subtask);
                // beta.132: the window says what the loop INTENDED, not whether it is
                // still there. Session 2b4c1d33 answered 28 seconds into a 5-minute
                // window and was told the run would pick it up; the process holding
                // the question had already exited, and $11.07 of finished work sat on
                // a branch nobody came back for.
                const alive = listenerLooksAlive(row.clarification_heartbeat_at);
                if (alive) {
                    const windowOpen = Date.now() < waitUntilMs;
                    liveState().audit("tool.answer_time_extension", { sessionId, answerLen: trimmed.length, invokedBy: invokedBy ?? null, waitUntilMs, windowOpen }, sessionId);
                    // A live loop owns this session. Even with the window a moment
                    // expired it is mid-shutdown and about to ship, so writing a
                    // verdict from here would race its own -- the answer is recorded
                    // and the loop decides.
                    return {
                        content: [{
                                type: "text",
                                text: windowOpen
                                    ? `Recorded. The run is still waiting at its review boundary and will pick this up within a few seconds.`
                                    : `Recorded, but the wait window has just closed and the run is already shipping what it has. It may not act on this.`,
                            }],
                        details: { ok: true, sessionId, timeExtensionAnswered: true, windowOpen },
                    };
                }
                // Nobody is listening. The ordinary resume from here is a FULL
                // re-plan -- a fresh lead call and scout ($6.24 on average across
                // this repo's own history), the cycle counter reset to 1, and every
                // sub-task re-run against a branch that already carries their
                // commits. That is a worse outcome than the one the question was
                // trying to avoid, so it is not what happens.
                //
                // Everything of value is already on the remote when a PR exists, so
                // the honest move is to finish the ship the dead loop was in the
                // middle of: exactly what would have happened had the operator
                // replied "ship", or said nothing at all.
                const prUrl = (row.final_pr_url ?? "").trim();
                liveState().audit("tool.answer_time_extension_listener_lost", {
                    sessionId, answerLen: trimmed.length, invokedBy: invokedBy ?? null,
                    waitUntilMs, windowWasOpen: Date.now() < waitUntilMs,
                    heartbeatAt: row.clarification_heartbeat_at ?? null,
                    hasPr: Boolean(prUrl),
                }, sessionId);
                if (prUrl) {
                    liveDb()
                        .prepare(`UPDATE sessions SET status = 'done', merge_recommendation = 'needs_human_review',
                        merge_recommendation_reason = ?, clarification_question = NULL, clarification_seq = NULL,
                        clarification_subtask = NULL, clarification_heartbeat_at = NULL, updated_at = ?
                  WHERE id = ?`)
                        .run(`The run that asked for more time is no longer running, so the extension could not be used. ` +
                        `The branch is pushed and the PR is open, but the CI repair it wanted the time FOR never ran -- ` +
                        `treat CI on this PR as unfixed. Nothing was lost and nothing was re-spent.`, Date.now(), sessionId);
                    return {
                        content: [{
                                type: "text",
                                text: `The run that asked this question is gone, so the extra time could not be used.\n\n` +
                                    `Nothing is lost: the branch is pushed and ${prUrl} is open. What did NOT happen is the CI ` +
                                    `repair the run wanted the time for, so CI on that PR is still as red as it was.\n\n` +
                                    `Marked needs_human_review. Re-running would have re-planned from scratch and re-spent the ` +
                                    `lead and scout, so it was not done automatically -- use harness_revise if you want the fix attempted.`,
                            }],
                        details: { ok: true, sessionId, listenerLost: true, shipped: true, prUrl },
                    };
                }
                // No PR means the question came from the review boundary, before any
                // push, so there is nothing on the remote to point at. Keep the
                // worktree (b129's flag stops the next boot reaping it) and say where
                // the commits are rather than inventing a ship.
                liveDb()
                    .prepare(`UPDATE sessions SET status = 'aborted', worktree_preserved = 1, clarification_question = NULL,
                      clarification_seq = NULL, clarification_subtask = NULL, clarification_heartbeat_at = NULL,
                      updated_at = ? WHERE id = ?`)
                    .run(Date.now(), sessionId);
                return {
                    content: [{
                            type: "text",
                            text: `The run that asked this question is gone, so the extra time could not be used, and it had not ` +
                                `pushed yet — there is no PR to point at.\n\n` +
                                `Its worktree has been preserved rather than reaped, so the commits on branch ` +
                                `${(row.branch ?? "").trim() || "(unrecorded)"} are still there. Resuming was not done ` +
                                `automatically because it would have re-planned from scratch and re-spent the lead and scout.`,
                        }],
                    details: { ok: true, sessionId, listenerLost: true, shipped: false, worktreePreserved: true },
                };
            }
            // 'abort'/'cancel' -> terminate the session cleanly (release worktree).
            if (/^(abort|cancel)\b/i.test(trimmed)) {
                liveDb().prepare(`UPDATE sessions SET status = 'aborted', updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
                liveState().audit("tool.answer_aborted", { sessionId, seq }, sessionId);
                return { content: [{ type: "text", text: `Session ${sessionId} aborted per your instruction.` }], details: { ok: true, sessionId, aborted: true } };
            }
            const brief = JSON.parse(row.crystallised_prompt);
            const q = row.clarification_question ?? `sub-task ${seq}`;
            // beta.120 (brief fidelity): this pause happened BEFORE any planning or
            // worker spend, so there is no blocked sub-task to phrase around and no
            // worktree to preserve. An approval starts the run untouched; anything
            // else is a correction to the brief itself.
            if (isBriefConfirmationPause(row.clarification_subtask)) {
                // beta.122: a budget named in the reply is an instruction to the
                // SESSION, not a change to the spec. b121 filed "Confirm, Budget $40"
                // as an authoritative acceptance criterion and ran at $10 regardless.
                const parsed = parseConfirmationReply(trimmed);
                const approved = parsed.approves;
                let budgetApplied;
                if (typeof parsed.budgetUsd === "number") {
                    // The advertised ceiling still binds -- this is the operator asking
                    // for more room, not an escape from the operator's own cap.
                    const ceiling = liveConfig().budgets?.session_hard_ceiling_usd;
                    const applied = typeof ceiling === "number" && ceiling > 0 ? Math.min(parsed.budgetUsd, ceiling) : parsed.budgetUsd;
                    liveDb().prepare(`UPDATE sessions SET budget_usd = ?, updated_at = ? WHERE id = ?`).run(applied, Date.now(), sessionId);
                    budgetApplied = applied;
                    liveState().audit("tool.answer_brief_budget_set", { sessionId, requested: parsed.budgetUsd, applied, clampedByCeiling: applied < parsed.budgetUsd }, sessionId);
                }
                // beta.123: the time half of the same sentence. b122 read the money
                // out of "confirm, budget $40 with a time budget of 3 hours" and left
                // the hours in the remainder, which both lost the instruction and
                // demoted a plain approval to a correction.
                let timeoutApplied;
                if (typeof parsed.timeoutSeconds === "number") {
                    liveDb()
                        .prepare(`UPDATE sessions SET hard_timeout_seconds = ?, updated_at = ? WHERE id = ?`)
                        .run(parsed.timeoutSeconds, Date.now(), sessionId);
                    timeoutApplied = parsed.timeoutSeconds;
                    liveState().audit("tool.answer_brief_timeout_set", { sessionId, seconds: parsed.timeoutSeconds, configured: liveConfig().loop?.session_hard_timeout_seconds }, sessionId);
                }
                if (!approved) {
                    brief.acceptanceCriteria = Array.isArray(brief.acceptanceCriteria) ? brief.acceptanceCriteria : [];
                    brief.acceptanceCriteria.push(
                    // Only the non-budget part is a statement about the work.
                    `OPERATOR CORRECTION TO THIS BRIEF (given before any work began, after reviewing the crystallised version): ${parsed.remainder || trimmed}. This supersedes anything above that contradicts it -- the operator is describing what they actually asked for, so treat it as the authoritative reading.`);
                }
                liveDb()
                    .prepare(`UPDATE sessions SET crystallised_prompt = ?, status = 'planning', clarification_question = NULL, clarification_subtask = NULL, updated_at = ? WHERE id = ?`)
                    .run(JSON.stringify(brief), Date.now(), sessionId);
                liveState().audit(approved ? "tool.answer_brief_confirmed" : "tool.answer_brief_corrected", { sessionId, answerLen: trimmed.length, invokedBy: invokedBy ?? null, budgetApplied: budgetApplied ?? null, timeoutApplied: timeoutApplied ?? null }, sessionId);
                void liveRuntime().loop.run(sessionId, brief).catch((err) => {
                    api.logger.error("[tool.answer] loop.run failed", { sessionId, err: String(err) });
                });
                return {
                    content: [{
                            type: "text",
                            text: `${approved
                                ? `Brief confirmed; session ${sessionId} is running.`
                                : `Correction folded into the brief; session ${sessionId} is running with it.`}${budgetApplied !== undefined ? ` Budget set to $${budgetApplied.toFixed(2)}.` : ""}${timeoutApplied !== undefined ? ` Wall clock set to ${(timeoutApplied / 3600).toFixed(timeoutApplied % 3600 === 0 ? 0 : 1)}h.` : ""} Poll harness_progress every ~45s and relay \`headline\` until terminal.`,
                        }],
                    details: { ok: true, sessionId, resumed: true, briefConfirmed: approved, briefCorrected: !approved, budgetUsd: budgetApplied ?? null, hardTimeoutSeconds: timeoutApplied ?? null },
                };
            }
            // Fold the decision into the brief so the re-plan honours it. For a
            // 'skip' answer we phrase it as an out-of-scope directive; otherwise as
            // an acceptance-criteria directive pinned to the blocked sub-task.
            // beta.122: `accept` keeps the work; `skip` forbids it. Until now the
            // prompt offered only `skip`, described as the former and implemented
            // as the latter. On the b121 smoke the migration SQL was committed and
            // correct -- only the contract path named a directory -- and `skip`
            // stripped the requirement from the brief so the re-plan built no
            // migration at all. `accept` records that the work is already done
            // WITHOUT removing it from what the adversary reviews against.
            const acceptsCommittedWork = /^accept\b/i.test(trimmed) || /^keep(-|\s)?commit\b/i.test(trimmed);
            if (acceptsCommittedWork) {
                let paused = {};
                try {
                    if (row.clarification_subtask)
                        paused = JSON.parse(row.clarification_subtask);
                }
                catch { /* ignore */ }
                const what = ((paused.title ?? "") || (paused.intent ?? "")).trim();
                const expectedPaths = new Set((paused.expectedPaths ?? []).filter((p) => typeof p === "string" && !!p.trim()));
                const actualPaths = (paused.actualPaths ?? []).filter((p) => typeof p === "string" && !!p.trim());
                // Persist what "the contract path was wrong" means. Without this,
                // the stored plan is resumed unchanged and the same stale path
                // reappears on every revise cycle, forcing the operator to accept the
                // identical mismatch repeatedly. Accepted actual paths become the
                // task's declared scope; only the disproven path checks are removed.
                if (row.lead_plan_json && (expectedPaths.size > 0 || actualPaths.length > 0)) {
                    try {
                        const storedPlan = JSON.parse(row.lead_plan_json);
                        const task = storedPlan.subTasks?.find((candidate) => candidate.seq === seq);
                        if (task) {
                            task.filesLikelyTouched = [
                                ...(task.filesLikelyTouched ?? []).filter((p) => !expectedPaths.has(p)),
                                ...actualPaths,
                            ].filter((p, i, all) => all.indexOf(p) === i);
                            task.verify = (task.verify ?? []).filter((probe) => !probe.path || !expectedPaths.has(probe.path));
                            liveDb()
                                .prepare(`UPDATE sessions SET lead_plan_json = ?, updated_at = ? WHERE id = ?`)
                                .run(JSON.stringify(storedPlan), Date.now(), sessionId);
                            liveState().audit("tool.answer_contract_paths_persisted", { sessionId, seq, removed: [...expectedPaths], added: actualPaths }, sessionId);
                        }
                    }
                    catch (err) {
                        return {
                            content: [{ type: "text", text: `Could not persist the accepted contract correction: ${String(err)}` }],
                            details: { ok: false, planUpdateFailed: true, sessionId },
                        };
                    }
                }
                brief.acceptanceCriteria = Array.isArray(brief.acceptanceCriteria) ? brief.acceptanceCriteria : [];
                brief.acceptanceCriteria.push(what
                    ? `ALREADY DONE (operator-confirmed): "${what.slice(0, 300)}" was completed and COMMITTED on this branch; the plan's contract path for it was wrong, not the work. Do not redo it and do not plan it again. It remains in scope for review -- the change must still be present and correct in the final diff.`
                    : `ALREADY DONE (operator-confirmed): the previously-blocked sub-task ${seq} was completed and committed on this branch. Do not redo it; it remains in scope for review.`);
                // beta.135: accepting a correct commit settles THIS contract
                // disagreement; it is not a request for the lead to replace the
                // feature plan. Mark the paused ledger row complete and tell runInner
                // to load the existing plan, where the remaining sub-tasks are still
                // present. The old full re-plan reduced the policy-Drive smoke's
                // five-step plan to one observe step and silently dropped the actual
                // export implementation.
                liveDb().prepare(`UPDATE sub_tasks
                SET status = 'completed',
                    summary = ?,
                    completed_at = COALESCE(completed_at, ?),
                    updated_at = ?
              WHERE session_id = ? AND seq = ?
                AND cycle = (SELECT MAX(cycle) FROM sub_tasks WHERE session_id = ? AND seq = ?)`).run(`operator accepted committed work; the plan contract path was wrong${what ? ` (${what.slice(0, 200)})` : ""}`, Date.now(), Date.now(), sessionId, seq, sessionId, seq);
                brief.resumeExistingPlan = true;
                liveState().audit("tool.answer_contract_accepted", { sessionId, seq, what: what.slice(0, 120) }, sessionId);
            }
            else if (/^skip\b/i.test(trimmed)) {
                // beta.58 (D1/D2): DURABLE skip. The prior beta.55 form phrased the
                // prohibition by seq number and only appended to outOfScope -- but
                // harness_answer re-drives via a FULL re-plan (status='planning' ->
                // loop.run) which RENUMBERS seqs AND re-derives sub-tasks from the
                // finding lines still present in acceptanceCriteria. So "sub-task 2"
                // bound to nothing and the lead re-emitted the same work. Fix: key the
                // prohibition by the paused sub-task's CONTENT (title/intent) and
                // physically STRIP the owning finding line(s) from acceptanceCriteria
                // so the lead never re-derives it. Content survives renumbering.
                let paused = {};
                try {
                    if (row.clarification_subtask)
                        paused = JSON.parse(row.clarification_subtask);
                }
                catch { /* ignore */ }
                const pausedTitle = (paused.title ?? "").trim();
                const pausedIntent = (paused.intent ?? "").trim();
                brief.outOfScope = Array.isArray(brief.outOfScope) ? brief.outOfScope : [];
                brief.outOfScope.push(pausedTitle || pausedIntent
                    ? `Do NOT perform the following work under ANY circumstances -- the operator explicitly skipped it: "${(pausedTitle || pausedIntent).slice(0, 300)}". Do not re-plan, rephrase, or promote it to an unconditional step.`
                    : `Do NOT attempt the previously-blocked sub-task ${seq}. The operator chose to skip it.`);
                // Strip any acceptanceCriteria finding line whose text overlaps the
                // paused sub-task's title/intent (the finding the sub-task addressed),
                // so a re-plan can't re-derive the same mutate from a still-present line.
                if (Array.isArray(brief.acceptanceCriteria) && (pausedTitle || pausedIntent)) {
                    const removed = removeOwningFindingLines(brief.acceptanceCriteria, pausedTitle, pausedIntent);
                    brief.acceptanceCriteria = removed.kept;
                    if (removed.dropped.length) {
                        liveState().audit("tool.answer_finding_stripped", { sessionId, seq, droppedLines: removed.dropped.length }, sessionId);
                    }
                }
            }
            else {
                brief.acceptanceCriteria = Array.isArray(brief.acceptanceCriteria) ? brief.acceptanceCriteria : [];
                brief.acceptanceCriteria.push(`OPERATOR CLARIFICATION (for the previously-blocked sub-task ${seq}): In response to "${q.slice(0, 300)}", the operator decided: ${trimmed}. Follow this decision exactly; do not re-raise the same question.`);
            }
            // beta.101: mark this as a clarification re-drive BEFORE persisting, so
            // both this resume and any later crash-recovery re-drive allocate with
            // preserveLocalBranch. The re-plan below allocates a NEW worktree; the
            // pre-b101 allocation reset the session branch to origin/<base> and
            // silently orphaned every commit the run had already made (b100 smoke,
            // session 3c6c1608 lost six). See CrystallisedBrief.resumeFromClarification.
            brief.resumeFromClarification = true;
            // Persist the amended brief so a subsequent restart/recovery re-drives
            // WITH the clarification baked in.
            liveDb().prepare(`UPDATE sessions SET crystallised_prompt = ?, status = 'planning', updated_at = ? WHERE id = ?`)
                .run(JSON.stringify(brief), Date.now(), sessionId);
            liveState().audit("tool.answer_resumed", { sessionId, seq, skip: /^skip\b/i.test(trimmed) }, sessionId);
            void liveRuntime().loop.run(sessionId, brief).catch((err) => {
                api.logger.error("[tool.answer] loop.run failed", { sessionId, err: String(err) });
            });
            return {
                content: [{ type: "text", text: `Answer recorded for session ${sessionId}; resuming. Poll harness_progress for status.` }],
                details: { ok: true, sessionId, resumed: true, seq },
            };
        },
    })));
    // ---- beta.78 (Feature 4): per-user credential onboarding (DM flow) ----
    //
    // Authorised users onboard their OWN git token privately. Two actions:
    //   - action:"start": open a DM to the user with paste instructions (keeps
    //     the token request out of any public channel). Returns the DM channel.
    //   - action:"submit": store a pasted token in the vault as git-pat:<userid>
    //     (validated via GET /user first), then delete the bot's own prompt and
    //     confirm in DM (asking the user to delete their token message -- a bot
    //     token cannot delete a user's message).
    //
    // SLACK-APP CAVEAT: the `/harness-onboard` slash command must be added to
    // the Slack app manifest and reinstalled before Slack routes it; the command
    // handler then calls this tool. Documented in the README.
    disposers.push(toDispose(api.registerTool({
        name: "harness_onboard",
        description: "Per-user git credential onboarding and management (DM flow). One person can hold DIFFERENT tokens for different orgs, so credentials are keyed by provider+org: " +
            "action:'list' shows what the requester has configured (never any secret); " +
            "action:'add' takes an orgUrl (e.g. https://github.com/acme) plus a token, validates it, and stores BOTH the secret and the routing entry that makes it readable; " +
            "action:'replace' swaps the token for an org already configured; " +
            "action:'remove' deletes one (needs confirm:true). " +
            "action:'start' opens a private DM so the token is pasted out of any public channel — pass orgUrl to name the org up front, or omit it and the DM asks which provider and org the token is for; the reply is then stored with action:'add'. " +
            "action:'submit' (with legacy:true) is the legacy single-token flow for flat setups that resolve through default_service_pattern. " +
            "ONLY users in slack.authorised_users may onboard. The raw token must NEVER be posted to a public channel.",
        parameters: {
            type: "object",
            properties: {
                requester: { type: "string", minLength: 1, description: "Slack user id being onboarded. Must be in slack.authorised_users." },
                action: {
                    type: "string",
                    enum: ["start", "submit", "list", "add", "replace", "remove"],
                    description: "'list' shows configured credentials; 'add'/'replace'/'remove' manage one org; 'start' opens the DM prompt; 'submit' is the legacy flat flow.",
                },
                token: { type: "string", description: "For 'add', 'replace' and 'submit': the git token to validate + store. Never pass this in a public channel." },
                orgUrl: { type: "string", description: "For 'add', 'replace' and 'remove': the org or repo URL, e.g. https://github.com/acme. States the provider as well as the org." },
                confirm: { type: "boolean", description: "For 'remove': must be true to actually delete. A first call without it reports what would be removed." },
                commitName: { type: "string", description: "Optional git author name for commits made on this person's behalf. Defaults to the provider account's name." },
                commitEmail: { type: "string", description: "Optional git author email. Defaults to the provider account's email, or its noreply address." },
                provider: { type: "string", description: "Git provider. Only needed for the legacy flat flow; 'add' and 'start' read it from orgUrl. Defaults to pat_routing.default_provider." },
                legacy: { type: "boolean", description: "Opt in to the legacy flat single-token flow, which stores ONE token per person rather than one per org. Only for flat deployments that resolve through default_service_pattern." },
                promptTs: { type: "string", description: "The ts of the bot's DM prompt to delete after storing." },
                dmChannel: { type: "string", description: "The DM channel id (from action:'start') to post confirmation + delete the prompt in." },
            },
            required: ["requester", "action"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { requester, action, token, orgUrl, confirm, commitName, commitEmail, provider, promptTs, dmChannel, legacy } = input;
            if (!liveConfig().slack.authorised_users.includes(requester)) {
                liveState().audit("tool.onboard.unauthorised", { requester });
                return { content: [{ type: "text", text: `Requester ${requester} is not in slack.authorised_users; onboarding refused.` }], details: { ok: false, unauthorised: true } };
            }
            // Routes this tool writes. Falls back to a fresh view over the same
            // database, so a runtime assembled without one still works.
            const overlay = liveRuntime().routeOverlay ?? new RouteOverlay(liveState().db);
            const providerApiBase = (p) => liveConfig().pat_routing?.providers?.[p]?.api_base ??
                (p === "gitlab" ? "https://gitlab.com/api/v4" : "https://api.github.com");
            /**
             * A config-defined entry for this requester in this org. The overlay
             * is read BENEATH config, so writing a row where config already
             * answers would store a token that nothing reads -- refuse instead of
             * reporting a success that has no effect.
             */
            const configRouteFor = (p, org) => {
                const orgs = liveConfig().pat_routing?.[p];
                const node = orgs?.[org] ?? orgs?.[org.toLowerCase()];
                if (!node)
                    return undefined;
                for (const [person, entry] of Object.entries(node)) {
                    if (entry?.slack_user_id === requester)
                        return { person };
                }
                return undefined;
            };
            /** A concrete allowed repo in this org, so reach can actually be tested. */
            const allowedRepoIn = (org) => liveConfig().repos.allowed.find((r) => !r.includes("*") && r.split("/")[0]?.toLowerCase() === org.toLowerCase());
            /** Slack is best-effort for the management actions; absent, they still work. */
            const tryOnboardSlack = async () => {
                const cs = liveConfig().slack.credential_service;
                if (!cs)
                    return null;
                try {
                    return new OnboardingSlack({ slackToken: await liveRuntime().creds.getToken(cs), logger: api.logger });
                }
                catch {
                    return null;
                }
            };
            const describeRoute = (r) => {
                const who = r.providerLogin ? ` as \`${r.providerLogin}\`` : "";
                if (!r.tokenExpiresAt)
                    return `• \`${r.provider}\` / \`${r.org}\`${who}`;
                const days = Math.floor((r.tokenExpiresAt - Date.now()) / 86_400_000);
                const when = new Date(r.tokenExpiresAt).toISOString().slice(0, 10);
                const note = days < 0 ? ` — :x: EXPIRED ${when}` : days <= 14 ? ` — :warning: expires ${when} (${days}d)` : ` — expires ${when}`;
                return `• \`${r.provider}\` / \`${r.org}\`${who}${note}`;
            };
            // ---------------------------------------------------------------
            // list: what this person has configured. Never a secret, and never
            // anyone else's routes -- the lookup is keyed on the caller.
            // ---------------------------------------------------------------
            if (action === "list") {
                const routes = overlay.listForRequester(requester);
                liveState().audit("tool.onboard.list", { requester, count: routes.length });
                if (routes.length === 0) {
                    return {
                        content: [{ type: "text", text: "You have no git credentials configured yet. Send me the URL of an org you want to add (for example `https://github.com/acme`) and I'll open a private DM for the token." }],
                        details: { ok: true, routes: [] },
                    };
                }
                const stored = new Set(liveRuntime().vault.list().map((c) => c.service));
                const lines = routes.map((r) => {
                    const missing = stored.has(r.vaultService) ? "" : " — :x: the stored token is missing; use `replace`";
                    return describeRoute(r) + missing;
                });
                return {
                    content: [{ type: "text", text: `You have ${routes.length} git credential(s) configured:\n${lines.join("\n")}\n\nYou can \`add\` another org, \`replace\` a token, or \`remove\` one.` }],
                    details: {
                        ok: true,
                        routes: routes.map((r) => ({
                            provider: r.provider, org: r.org, person: r.person,
                            providerLogin: r.providerLogin ?? null, tokenExpiresAt: r.tokenExpiresAt ?? null,
                            vaultService: r.vaultService, secretPresent: stored.has(r.vaultService),
                            createdAt: r.createdAt, updatedAt: r.updatedAt,
                        })),
                    },
                };
            }
            // ---------------------------------------------------------------
            // remove: two-step, because it destroys a credential.
            // ---------------------------------------------------------------
            if (action === "remove") {
                const parsed = parseOrgUrl(orgUrl, liveConfig().pat_routing?.providers);
                if (!parsed.ok) {
                    return { content: [{ type: "text", text: `Which org should I remove? ${parsed.error}.` }], details: { ok: false, badOrgUrl: parsed.error } };
                }
                const { provider: p, org } = parsed.value;
                const existing = overlay.lookup(p, org, requester);
                if (!existing) {
                    return { content: [{ type: "text", text: `You have nothing configured for \`${p}\` / \`${org}\`, so there is nothing to remove.` }], details: { ok: false, notConfigured: true, provider: p, org } };
                }
                if (confirm !== true) {
                    return {
                        content: [{ type: "text", text: `This will delete your \`${p}\` token for \`${org}\`${existing.providerLogin ? ` (\`${existing.providerLogin}\`)` : ""}. Sessions for that org will stop working until you add one again. Confirm to proceed.` }],
                        details: { ok: false, needsConfirm: true, provider: p, org: existing.org, person: existing.person },
                    };
                }
                // Route first, then secret. This order can only ever leave an
                // unreferenced secret behind; the reverse leaves a route pointing
                // at a vault entry that is gone, which is the hour-late failure at
                // clone that this whole area exists to prevent.
                overlay.remove(p, existing.org, existing.person);
                let secretDeleted = false;
                try {
                    secretDeleted = liveRuntime().vault.delete(existing.vaultService);
                }
                catch (err) {
                    liveState().audit("tool.onboard.remove_vault_failed", { requester, provider: p, org: existing.org, error: String(err) });
                }
                liveState().audit("tool.onboard.removed", { requester, provider: p, org: existing.org, person: existing.person, secretDeleted });
                const slack = await tryOnboardSlack();
                if (slack && dmChannel)
                    await slack.postDm(dmChannel, `:wastebasket: Removed your \`${p}\` credential for \`${org}\`.`);
                return {
                    content: [{ type: "text", text: `Removed your \`${p}\` credential for \`${org}\`. If that token is no longer used anywhere else, revoke it at the provider too — deleting it here does not.` }],
                    details: { ok: true, removed: true, provider: p, org: existing.org, person: existing.person, secretDeleted },
                };
            }
            // ---------------------------------------------------------------
            // add / replace: store the secret AND the routing entry that makes
            // it readable. Writing only the secret is what left a token in the
            // vault under a name no session ever looked up.
            // ---------------------------------------------------------------
            if (action === "add" || action === "replace") {
                const parsed = parseOrgUrl(orgUrl, liveConfig().pat_routing?.providers);
                if (!parsed.ok) {
                    return {
                        content: [{ type: "text", text: `I need the org URL to know which provider and org this token is for. ${parsed.error}. Send something like \`https://github.com/acme\`.` }],
                        details: { ok: false, badOrgUrl: parsed.error },
                    };
                }
                const { provider: p, org } = parsed.value;
                const orgKey = normaliseOrg(org);
                if (!token || token.trim().length < 8) {
                    return { content: [{ type: "text", text: `No valid token supplied for \`${p}\` / \`${org}\`. Paste it in the private DM, never in a channel.` }], details: { ok: false, badToken: true } };
                }
                const existing = overlay.lookup(p, orgKey, requester);
                if (action === "add" && existing) {
                    return {
                        content: [{ type: "text", text: `You already have a \`${p}\` credential for \`${org}\`${existing.providerLogin ? ` (\`${existing.providerLogin}\`)` : ""}. Use \`replace\` to swap the token, or \`remove\` first.` }],
                        details: { ok: false, alreadyConfigured: true, provider: p, org: orgKey },
                    };
                }
                if (action === "replace" && !existing) {
                    return {
                        content: [{ type: "text", text: `You have no \`${p}\` credential for \`${org}\` to replace. Use \`add\` instead.` }],
                        details: { ok: false, notConfigured: true, provider: p, org: orgKey },
                    };
                }
                const shadowed = configRouteFor(p, orgKey);
                if (shadowed) {
                    // Config is read first, so a row written here would never be
                    // reached. Saying "stored" would be a lie with a green tick.
                    liveState().audit("tool.onboard.config_shadow", { requester, provider: p, org: orgKey, person: shadowed.person });
                    return {
                        content: [{ type: "text", text: `An operator has already configured \`${p}\` / \`${org}\` for you as \`${shadowed.person}\` in \`pat_routing\`. Hand-written config is read first, so anything I stored here would never be used. Ask them to update that entry instead.` }],
                        details: { ok: false, configShadow: true, provider: p, org: orgKey, person: shadowed.person },
                    };
                }
                const apiBase = providerApiBase(p);
                const valid = await validateGitToken(token.trim(), apiBase);
                if (!valid.ok) {
                    liveState().audit("tool.onboard.token_invalid", { requester, provider: p, org: orgKey, error: valid.error });
                    const slack = await tryOnboardSlack();
                    if (slack && dmChannel)
                        await slack.postDm(dmChannel, `:x: That token didn't validate (${valid.error ?? "unknown"}). Please try again with a valid token.`);
                    return { content: [{ type: "text", text: `Token failed validation (${valid.error ?? "unknown"}); NOT stored.` }], details: { ok: false, invalidToken: true, error: valid.error } };
                }
                // The token says who it belongs to, which is the only thing here
                // that does not come from the caller. `requester` is an argument on
                // an agent-relayed call, so without this someone could store THEIR
                // token under SOMEONE ELSE'S id and that person's commits would
                // push with it.
                const verdict = checkTokenIdentity(existing?.providerLogin, valid.login);
                if (!verdict.ok) {
                    liveState().audit("tool.onboard.identity_mismatch", {
                        requester, provider: p, org: orgKey, recorded: verdict.recorded, presented: verdict.presented ?? null,
                    });
                    return { content: [{ type: "text", text: verdict.message }], details: { ok: false, identityMismatch: true, kind: verdict.kind, recorded: verdict.recorded } };
                }
                // `GET /user` proves the token is live, not that it can see this
                // org. A PAT scoped to the wrong org passes validation and then
                // fails at clone, an hour later, which is the failure mode this
                // whole area exists to move forward.
                const probeRepo = allowedRepoIn(orgKey);
                if (probeRepo) {
                    const reach = await checkRepoAccess(token.trim(), apiBase, probeRepo);
                    if (reach.reach === "denied") {
                        liveState().audit("tool.onboard.no_reach", { requester, provider: p, org: orgKey, repo: probeRepo, status: reach.status ?? null });
                        return {
                            content: [{ type: "text", text: `That token is valid${valid.login ? ` (\`${valid.login}\`)` : ""} but cannot see \`${probeRepo}\` (HTTP ${reach.status}). A fine-grained token has to grant access to \`${org}\` specifically. Nothing was stored — check the token's resource owner and repository access, then try again.` }],
                            details: { ok: false, noReach: true, repo: probeRepo, status: reach.status ?? null },
                        };
                    }
                }
                const person = existing?.person ?? valid.login ?? requester;
                const vaultService = existing?.vaultService ?? onboardRouteService(p, orgKey, person);
                const name = commitName ?? existing?.commitName ?? valid.name ?? person;
                const email = commitEmail ?? existing?.commitEmail ?? valid.email ??
                    (p === "github" ? `${person}@users.noreply.github.com` : `${person}@users.noreply.gitlab.com`);
                // Secret first, route second. If the route write fails the secret
                // is merely unreferenced; the reverse publishes a route pointing at
                // a vault entry that does not exist.
                try {
                    liveRuntime().vault.set(vaultService, token.trim(), {
                        type: "token",
                        notes: `${p} token for Slack user ${requester} in ${orgKey}; onboarded via harness_onboard`,
                    });
                }
                catch (err) {
                    return { content: [{ type: "text", text: `Vault store failed (${String(err)}).` }], details: { ok: false, vaultThrew: String(err) } };
                }
                try {
                    overlay.upsert({
                        provider: p, org: orgKey, person, slackUserId: requester,
                        commitName: name, commitEmail: email, vaultService,
                        providerLogin: valid.login, tokenExpiresAt: valid.expiresAt,
                    });
                }
                catch (err) {
                    // Only safe to undo on `add`: on `replace` the route already
                    // exists and now points at the token just written, so deleting
                    // the entry would destroy a working credential to tidy up
                    // metadata.
                    if (action === "add") {
                        try {
                            liveRuntime().vault.delete(vaultService);
                        }
                        catch { /* leave the orphan; nothing points at it */ }
                    }
                    liveState().audit("tool.onboard.route_write_failed", { requester, provider: p, org: orgKey, error: String(err) });
                    return { content: [{ type: "text", text: `Stored the token but could not record the routing entry (${String(err)}), so nothing would read it. Nothing was left half-configured.` }], details: { ok: false, routeThrew: String(err) } };
                }
                const slack = await tryOnboardSlack();
                if (slack && dmChannel && promptTs)
                    await slack.deleteOwnMessage(dmChannel, promptTs);
                const expiryNote = valid.expiresAt ? ` It expires on ${new Date(valid.expiresAt).toISOString().slice(0, 10)}.` : "";
                if (slack && dmChannel) {
                    await slack.postDm(dmChannel, `:white_check_mark: Stored your \`${p}\` token for \`${org}\`${valid.login ? ` (validated as \`${valid.login}\`)` : ""}.${expiryNote}` +
                        `\n:warning: Please DELETE your message above containing the raw token — I can't delete your messages, only my own.` +
                        (action === "replace" ? `\n:key: The previous token is no longer used here; revoke it at the provider.` : ""));
                }
                liveState().audit(action === "add" ? "tool.onboard.route_added" : "tool.onboard.route_replaced", {
                    requester, provider: p, org: orgKey, person, vaultService, login: valid.login ?? null, expiresAt: valid.expiresAt ?? null,
                });
                const others = overlay.listForRequester(requester);
                const rest = others.filter((r) => !(r.provider === p && r.org === orgKey));
                const more = rest.length > 0
                    ? ` You also have ${rest.map((r) => `\`${r.org}\``).join(", ")} configured.`
                    : "";
                return {
                    content: [{
                            type: "text",
                            text: `${action === "add" ? "Added" : "Replaced"} your \`${p}\` credential for \`${org}\`` +
                                `${valid.login ? `, validated as \`${valid.login}\`` : ""}.${expiryNote}${more}` +
                                (action === "replace" ? " Revoke the old token at the provider — removing it here does not." : "") +
                                " Send another org URL if you have more to add.",
                        }],
                    details: {
                        ok: true, action, provider: p, org: orgKey, person, vaultService,
                        login: valid.login ?? null, tokenExpiresAt: valid.expiresAt ?? null,
                        identity: verdict.kind, otherOrgs: rest.map((r) => r.org),
                    },
                };
            }
            const credService = liveConfig().slack.credential_service;
            if (!credService) {
                return { content: [{ type: "text", text: "Onboarding needs slack.credential_service (a bot token) configured to open a DM." }], details: { ok: false, noSlackToken: true } };
            }
            let slackToken;
            try {
                slackToken = await liveRuntime().creds.getToken(credService);
            }
            catch (err) {
                return { content: [{ type: "text", text: `Could not resolve the Slack bot token from vault (${String(err)}).` }], details: { ok: false, slackTokenError: true } };
            }
            const onboard = new OnboardingSlack({ slackToken, logger: api.logger });
            // This person has already been onboarded per org, so a flat token
            // would be a second, differently-keyed credential for the same
            // human -- and whichever one a session happened to read would decide
            // whose commits went out. That is the conflict worth refusing.
            //
            // Deliberately NOT "does this deployment use pointers": a flat name
            // that happens to equal the pointer is read perfectly well, and the
            // consistency gate below already decides that question precisely.
            // Refusing on the deployment's shape would take away a setup that
            // works.
            const alreadyPerOrg = overlay.listForRequester(requester).length > 0;
            // ---------------------------------------------------------------
            // start: open the private DM. Per-org unless legacy is asked for.
            //
            // The old prompt said "reply with your token" and computed one vault
            // name from `onboard_service_pattern` before it knew which provider
            // or org the token was for. A person in two orgs -- or on both
            // GitHub and GitLab -- has no way to answer that question, and the
            // single name it had already chosen would have the second token
            // overwrite the first. So the DM now establishes provider and org
            // FIRST, and the reply is handed to `add`, which derives the vault
            // name from all three and writes the routing entry with it.
            // ---------------------------------------------------------------
            if (action === "start" && !legacy) {
                // A URL is the one input that states provider and org together, so
                // when it is given the DM can name exactly what is being onboarded
                // instead of asking a question already answered. A bad one is
                // refused BEFORE the DM: asking for a token and then rejecting the
                // org it was for wastes a live secret in a chat log.
                let named;
                if (orgUrl) {
                    const parsed = parseOrgUrl(orgUrl, liveConfig().pat_routing?.providers);
                    if (!parsed.ok) {
                        return {
                            content: [{ type: "text", text: `I can't tell which provider and org that is. ${parsed.error}. Send something like \`https://github.com/acme\`.` }],
                            details: { ok: false, badOrgUrl: parsed.error },
                        };
                    }
                    named = { provider: parsed.value.provider, org: parsed.value.org, orgKey: normaliseOrg(parsed.value.org) };
                }
                const dm = await onboard.openDm(requester);
                if (!dm.ok || !dm.value) {
                    return { content: [{ type: "text", text: `Could not open a DM with <@${requester}> (${dm.error ?? "unknown"}).` }], details: { ok: false, dmError: dm.error } };
                }
                const configured = overlay.listForRequester(requester);
                const already = configured.length > 0
                    ? `\n\nYou already have ${configured.map((r) => `\`${r.provider}\`/\`${r.org}\``).join(", ")} configured.`
                    : "";
                let body;
                let vaultPreview;
                if (named) {
                    const existing = overlay.lookup(named.provider, named.orgKey, requester);
                    // The person is part of the key, and until a token is validated
                    // the provider login is not known -- so an existing route can be
                    // named exactly, and a new one only in shape. Showing the shape
                    // is still worth it: it is what makes "one name per org" visible
                    // rather than something the operator has to take on trust.
                    vaultPreview = existing?.vaultService ?? onboardRouteService(named.provider, named.orgKey, "<your-login>");
                    body =
                        `:wave: Let's set up your \`${named.provider}\` token for \`${named.org}\`.\n\n` +
                            `Reply in THIS DM with a token that can reach \`${named.org}\` on \`${named.provider}\`. ` +
                            `I'll store it as \`${vaultPreview}\` — the name includes the provider and the org, so this ` +
                            `token will not disturb any other org you've set up.${already}\n\n` +
                            (existing ? `:repeat: This will REPLACE the token you already have for \`${named.org}\`.\n\n` : "") +
                            `:lock: Never paste your token in a public channel.`;
                }
                else {
                    // No URL: ask, rather than defaulting to GitHub and whatever
                    // `default_service_pattern` produces. The providers offered are
                    // the ones this deployment actually has, so a GitHub-only
                    // deployment does not invite a GitLab token it cannot route.
                    const offered = [...new Set(acceptedHosts(liveConfig().pat_routing?.providers).values())];
                    const choices = offered.length > 0 ? offered.map((p) => `\`${p}\``).join(" or ") : "`github` or `gitlab`";
                    body =
                        `:wave: Let's set up a git token so the harness can act as you.\n\n` +
                            `First, tell me which org this token is for. Reply in THIS DM with:\n` +
                            `1. the provider — ${choices}\n` +
                            `2. the org, ideally as a URL like \`https://github.com/acme\`\n` +
                            `3. a token that can reach that org\n\n` +
                            `:key: A separate token is needed for EACH org you work in — they are stored one per ` +
                            `provider and org, so adding a second org never overwrites the first. Repeat this for ` +
                            `as many orgs as you need.${already}\n\n` +
                            `:lock: Never paste your token in a public channel.`;
                }
                const prompt = await onboard.postDm(dm.value, body);
                liveState().audit("tool.onboard.started", {
                    requester, dmChannel: dm.value, flow: "per_org",
                    provider: named?.provider ?? null, org: named?.orgKey ?? null,
                });
                return {
                    content: [{
                            type: "text",
                            text: named
                                ? `Opened an onboarding DM with <@${requester}> for \`${named.provider}\`/\`${named.org}\`. When they reply with the token, call harness_onboard action:'add' with the same orgUrl and that token.`
                                : `Opened an onboarding DM with <@${requester}>. Ask them which provider and org the token is for, then call harness_onboard action:'add' with that orgUrl and the token.`,
                        }],
                    details: {
                        ok: true, dmChannel: dm.value, promptTs: prompt.value ?? null, flow: "per_org",
                        provider: named?.provider ?? null, org: named?.orgKey ?? null,
                        vaultService: vaultPreview ?? null,
                        configured: configured.map((r) => r.org),
                    },
                };
            }
            if (!legacy && alreadyPerOrg) {
                const configured = overlay.listForRequester(requester);
                liveState().audit("tool.onboard.flat_refused", { requester, action, configured: configured.length });
                return {
                    content: [{
                            type: "text",
                            text: `You already have per-org credentials configured (${configured.map((r) => `\`${r.provider}\`/\`${r.org}\``).join(", ")}). ` +
                                `The flat flow stores ONE token for you across every org, so it would sit alongside those under a ` +
                                `different name and whichever a session read would decide which of your tokens went out. ` +
                                `Use action:'add' with the org URL and the token instead. Pass legacy:true if you really mean the flat flow.`,
                        }],
                    details: { ok: false, flatRefused: true, configured: configured.map((r) => r.org) },
                };
            }
            // The provider the LEGACY flat flow is storing for. `add` reads this
            // from the org URL, which states it; the flat flow has no URL, so it
            // is either stated explicitly or taken from the deployment's own
            // default rather than assumed to be GitHub.
            const flatProvider = provider ?? liveConfig().pat_routing?.default_provider ?? "github";
            const vaultService = resolveOnboardVaultService(requester, {
                pattern: liveConfig().pat_routing?.onboard_service_pattern,
                provider: flatProvider,
            });
            // beta.133: refuse to store a token under a name nothing reads. The
            // two patterns default to `git-pat:{userid}` and `github-{owner}`,
            // which cannot agree, and the old failure was silent: the vault kept
            // the token, the tool reported success, and the run died at clone.
            //
            // The name a session reads is NOT always `credentialService`. Where
            // routing resolves through a hierarchy or overlay entry the token
            // comes from a pointer, and `credentialService` is a synthetic label
            // the router never looks anything up by. Comparing against it there
            // refuses correct setups, and "aligning the patterns" as the refusal
            // advises then stores the token under a name that still is not read --
            // the same silent failure, one level down. A pointer at an env var or
            // a literal reads no vault name at all, which is not a mismatch but an
            // absence, so it contributes nothing and can leave the verdict
            // undetermined.
            {
                const resFn = liveRuntime().gitResolutionFor;
                // Only repos on the provider being onboarded can say anything about
                // the name this token will be read by. A GitLab token compared
                // against the names GitHub repos resolve to is guaranteed to look
                // like a mismatch, and the refusal then tells the operator to
                // "align the patterns" -- advice that would break the GitHub side
                // to satisfy a comparison that was never valid. Where no repo on
                // this provider is allow-listed yet the list comes back empty,
                // which `checkOnboardConsistency` reports as undetermined rather
                // than as a refusal.
                const expected = resFn
                    ? liveConfig().repos.allowed.map((r) => {
                        const res = resFn(r, requester);
                        if (!res)
                            return "";
                        if (res.provider !== flatProvider)
                            return "";
                        if (res.tokenSource)
                            return res.vaultPointer ?? "";
                        return res.credentialService;
                    })
                    : [];
                const consistency = checkOnboardConsistency(vaultService, expected);
                if (!consistency.ok) {
                    liveState().audit("tool.onboard.pattern_mismatch", { requester, writing: consistency.writing, expected: consistency.expected });
                    return {
                        content: [{
                                type: "text",
                                text: `Onboarding would store the token as \`${consistency.writing}\`, but sessions look up ` +
                                    `${consistency.expected.map((e) => `\`${e}\``).join(" or ")}. Nothing would ever read it, and the ` +
                                    `run would fail at clone instead of here. Set pat_routing.onboard_service_pattern (or ` +
                                    `default_service_pattern) so the two agree, then retry. Both understand {userid}.`,
                            }],
                        details: { ok: false, patternMismatch: true, writing: consistency.writing, expected: consistency.expected },
                    };
                }
            }
            // The legacy flat prompt, reached only via legacy:true. It names one
            // vault entry for the person rather than one per org, which is why it
            // has to be asked for rather than fallen into.
            if (action === "start") {
                const dm = await onboard.openDm(requester);
                if (!dm.ok || !dm.value) {
                    return { content: [{ type: "text", text: `Could not open a DM with <@${requester}> (${dm.error ?? "unknown"}).` }], details: { ok: false, dmError: dm.error } };
                }
                const prompt = await onboard.postDm(dm.value, `:wave: Let's onboard your \`${flatProvider}\` token so the harness can act as you.\n\n` +
                    `Reply in THIS DM with your token (it stays private; the operator never sees it). ` +
                    `Once stored, I'll delete my prompt and confirm. It will be saved in the vault as \`${vaultService}\`.\n\n` +
                    `:information_source: This is the flat single-token setup: ONE token for you across every org. ` +
                    `If you work in more than one org, ask for per-org onboarding instead.\n\n` +
                    `:lock: Never paste your token in a public channel.`);
                liveState().audit("tool.onboard.started", { requester, dmChannel: dm.value, vaultService, flow: "flat" });
                return {
                    content: [{ type: "text", text: `Opened a LEGACY flat onboarding DM with <@${requester}>. Ask them to paste their token in that DM, then submit it via harness_onboard action:'submit' with legacy:true.` }],
                    details: { ok: true, dmChannel: dm.value, promptTs: prompt.value ?? null, vaultService, flow: "flat" },
                };
            }
            // action === "submit"
            if (!token || token.trim().length < 8) {
                return { content: [{ type: "text", text: "No valid token supplied for submit." }], details: { ok: false, badToken: true } };
            }
            const gitRes = liveRuntime().gitResolutionFor?.(undefined);
            const apiBase = gitRes?.apiBase ?? (provider === "gitlab" ? "https://gitlab.com/api/v4" : "https://api.github.com");
            const valid = await validateGitToken(token.trim(), apiBase);
            if (!valid.ok) {
                liveState().audit("tool.onboard.token_invalid", { requester, error: valid.error });
                if (dmChannel)
                    await onboard.postDm(dmChannel, `:x: That token didn't validate (${valid.error ?? "unknown"}). Please try again with a valid token.`);
                return { content: [{ type: "text", text: `Token failed validation (${valid.error ?? "unknown"}); NOT stored.` }], details: { ok: false, invalidToken: true, error: valid.error } };
            }
            // beta.110: store straight into the harness-owned vault. This used to
            // go out through memory-hybrid's `credential_store` tool; it is now a
            // library call on a vault nothing else can address.
            try {
                liveRuntime().vault.set(vaultService, token.trim(), {
                    type: "token",
                    notes: `git token for Slack user ${requester}; onboarded via harness_onboard`,
                });
            }
            catch (err) {
                return { content: [{ type: "text", text: `Vault store failed (${String(err)}).` }], details: { ok: false, vaultThrew: String(err) } };
            }
            // Best-effort: delete our own prompt + confirm. The bot CANNOT delete
            // the user's token message, so ask them to remove it themselves.
            if (dmChannel && promptTs)
                await onboard.deleteOwnMessage(dmChannel, promptTs);
            if (dmChannel) {
                await onboard.postDm(dmChannel, `:white_check_mark: Stored your ${provider ?? "github"} token as \`${vaultService}\`` +
                    (valid.login ? ` (validated as \`${valid.login}\`)` : "") +
                    `. :warning: Please DELETE your message above that contains the raw token — I can't delete your messages, only my own.`);
            }
            liveState().audit("tool.onboard.stored", { requester, vaultService, login: valid.login ?? null });
            return {
                content: [{ type: "text", text: `Onboarded <@${requester}>: token validated${valid.login ? ` as ${valid.login}` : ""} and stored as ${vaultService}. Asked them to delete their token message.` }],
                details: { ok: true, vaultService, login: valid.login ?? null },
            };
        },
    })));
    // A session is "revisable" iff it shipped a PR that isn't merge-ready.
    // status='done' (shipped), pr_number present, and merge_recommendation is
    // anything other than 'merge' (do_not_merge, or null when shipped at max
    // cycles without a clean pass).
    function listRevisableRows() {
        return liveDb()
            .prepare(`SELECT id, repo, branch, pr_number, final_pr_url, merge_recommendation,
                merge_recommendation_reason, crystallised_prompt, created_at
           FROM sessions
          WHERE status = 'done'
            AND pr_number IS NOT NULL
            AND (merge_recommendation IS NULL OR merge_recommendation != 'merge')
          ORDER BY created_at DESC
          LIMIT 50`)
            .all();
    }
    // Load the LATEST review's findings for a session (highest cycle).
    function latestFindings(sessionId) {
        const r = liveDb()
            .prepare(`SELECT verdict, findings, summary, cycle FROM reviews WHERE session_id = ? ORDER BY cycle DESC, created_at DESC LIMIT 1`)
            .get(sessionId);
        if (!r)
            return undefined;
        let findings = [];
        try {
            const parsed = JSON.parse(r.findings);
            if (Array.isArray(parsed))
                findings = parsed;
        }
        catch {
            /* leave empty */
        }
        return { verdict: r.verdict, findings, summary: r.summary, cycle: r.cycle };
    }
    function summariseRevisable(row) {
        const fnd = latestFindings(row.id);
        let title = row.branch;
        try {
            if (row.crystallised_prompt) {
                const b = JSON.parse(row.crystallised_prompt);
                if (b.title)
                    title = b.title;
            }
        }
        catch {
            /* keep branch as title */
        }
        return {
            sessionId: row.id,
            prNumber: row.pr_number,
            prUrl: row.final_pr_url,
            repo: row.repo,
            branch: row.branch,
            title,
            mergeRecommendation: row.merge_recommendation ?? "do_not_merge",
            reason: row.merge_recommendation_reason ?? null,
            findingCount: fnd?.findings.length ?? 0,
            lastVerdict: fnd?.verdict ?? null,
            // beta.49: expose each finding with its 1-based index + a conditional
            // flag, so a caller can pass dropFindings:[n] for stale/wrong findings
            // and see which will be auto-demoted (verify-premise-first) by C.
            findings: (fnd?.findings ?? []).map((f, i) => {
                const o = (f ?? {});
                return {
                    index: i + 1,
                    severity: String(o.severity ?? o.level ?? ""),
                    // beta.72 (D-B): use the hardened extractor so a finding whose text
                    // lives in `title` (empty `detail`) is not shown as a blank summary.
                    summary: findingText(f).slice(0, 200),
                    conditional: isConditionalFinding(f),
                };
            }),
        };
    }
    // beta.49 (C): a finding is CONDITIONAL when its stated action depends on an
    // unresolved premise about repo state. Session 21da9f9c's immortal finding
    // 10 is exactly this shape and kept being replayed verbatim into every
    // revise-of-21da9f9c because buildReviseBrief pulls stored findings without
    // re-checking premises. C3 disciplined the ADVERSARY at emission time, but
    // the revise path never re-runs the adversary, so a stale pre-C3 finding
    // survives forever. `isConditionalFinding` (pure, in finding-hygiene.ts)
    // detects that class so the brief can demote it from a hard mandate to a
    // VERIFY-PREMISE-FIRST instruction: the lead (already P1-disciplined) emits
    // an observe probe sub-task that greps the repo, and only a mutate sub-task
    // if the premise holds. Combined with beta.48 C1/C2, a false premise now
    // produces a VISIBLE non-fatal skip instead of a hard worker refusal.
    // Build a revise brief from a prior session + its stored findings. The new
    // brief carries the ORIGINAL goal forward (so the worker doesn't regress the
    // passing criteria) and adds the findings as the primary work items, pinned
    // to the existing branch.
    //
    // beta.49:
    //   A (dropFindings): 1-based indices (as shown in the finding list / the
    //     picker) to EXCLUDE from the revise brief entirely -- the manual escape
    //     hatch for a stale/wrong finding (e.g. finding 10 on #858).
    //   C (auto-demote conditional findings): any finding whose premise is an
    //     unresolved repo-state conditional is rewritten into a verify-first
    //     instruction rather than a hard mandate.
    //   guidance: free-text operator direction about WHAT THE FIX MUST DO, folded
    //     in as an authoritative instruction. dropFindings says what to ignore;
    //     this says what to build. See src/tools/revise-guidance.ts.
    function buildReviseBrief(row, opts = {}) {
        const fnd = latestFindings(row.id);
        let orig = {};
        try {
            if (row.crystallised_prompt)
                orig = JSON.parse(row.crystallised_prompt);
        }
        catch {
            /* fall through with empty orig */
        }
        const allFindings = fnd?.findings ?? [];
        const drop = new Set((opts.dropFindings ?? []).filter((n) => Number.isInteger(n) && n >= 1));
        const droppedIdx = [];
        const demotedIdx = [];
        // Keep 1-based display indices STABLE (matching the picker / prior report)
        // even after dropping, so a human referencing "finding 10" always means the
        // same finding regardless of how many were dropped.
        const findingLines = [];
        allFindings.forEach((f, i) => {
            const displayIdx = i + 1;
            if (drop.has(displayIdx)) {
                droppedIdx.push(displayIdx);
                return;
            }
            const o = (f ?? {});
            const sev = o.severity ?? o.level ?? "";
            // beta.72 (D-B): the pre-beta.72 inline extraction read
            // `message ?? finding ?? detail ?? description` and used `??`, which does
            // NOT fall through an EMPTY string. The adversary's ReviewFinding carries
            // its text in `title`+`detail`; a finding with text in `title` and an
            // empty `detail` produced an empty body -> `"1. [medium] "` (Staging #876
            // revise auto-brief, all 4 findings blank). `findingText` reads `title`,
            // coalesces empties, and dumps JSON as a last resort so the line is never
            // empty.
            const msg = findingText(f) || JSON.stringify(o);
            const loc = o.location ?? o.file ?? o.path ?? "";
            const line = o.line ?? "";
            const locStr = loc ? `${String(loc)}${line ? `:${String(line)}` : ""}` : "";
            const base = `${displayIdx}. [${String(sev)}] ${msg}${locStr ? ` (${locStr})` : ""}`;
            if (isConditionalFinding(f)) {
                demotedIdx.push(displayIdx);
                findingLines.push(`${base} -- CONDITIONAL PREMISE: this finding's action depends on an unverified claim about repo state. ` +
                    `Do NOT treat it as a mandate. FIRST verify the premise by grepping/inspecting the repo (an observe sub-task). ` +
                    `Only act if the premise holds; if the repo contradicts it, report the finding as invalid and make NO change for it.`);
            }
            else {
                findingLines.push(base);
            }
        });
        // Guidance sits directly under the preamble and ABOVE the findings, because
        // it governs how they are read: it is the intent the findings are meant to
        // serve. A worker that reaches finding 3 has already been told what
        // resolving it has to achieve.
        const guidance = normaliseGuidance(opts.guidance);
        const acceptance = [
            "Address each adversary finding listed below without regressing the original acceptance criteria.",
            ...(guidance ? [guidanceAcceptanceLine(guidance)] : []),
            ...(demotedIdx.length
                ? [
                    "NOTE: findings marked CONDITIONAL PREMISE must be premise-verified against the current repo BEFORE any change; a contradicted premise means skip that finding, not fail.",
                ]
                : []),
            ...findingLines,
        ];
        if (Array.isArray(orig.acceptanceCriteria)) {
            acceptance.push("--- original acceptance criteria (must still hold) ---", ...orig.acceptanceCriteria);
        }
        const brief = {
            title: orig.title ? `Revise: ${orig.title}` : `Revise PR #${row.pr_number}`,
            motivation: `Revise the existing PR #${row.pr_number} on branch ${row.branch}. The adversary review returned ` +
                `${fnd?.verdict ?? "revise"} with ${allFindings.length} finding(s)` +
                (droppedIdx.length ? ` (excluding dropped finding(s) ${droppedIdx.join(", ")})` : "") +
                (row.merge_recommendation_reason ? ` (merge recommendation: ${row.merge_recommendation_reason})` : "") +
                `. Build ON the existing branch -- do not start over. Only make the changes needed to resolve the findings.`,
            acceptanceCriteria: acceptance,
            filesLikelyTouched: Array.isArray(orig.filesLikelyTouched) ? orig.filesLikelyTouched : [],
            outOfScope: Array.isArray(orig.outOfScope)
                ? orig.outOfScope
                : ["Unrelated refactors", "Changes outside the scope of the listed findings"],
            relevantConcepts: orig.relevantConcepts,
            repoHint: row.repo,
            riskLevel: orig.riskLevel ?? "low",
            reviseOfSessionId: row.id,
            pinnedBranch: row.branch,
            // Also carried structurally, not only as prose inside acceptanceCriteria.
            // The PR review comment renders it as its own section, and a revise never
            // rewrites the PR body, so the echo needs a field it can read rather than
            // a string it has to find by prefix.
            operatorGuidance: guidance,
        };
        // _reviseMeta is advisory (audit/telemetry only) and is stripped before
        // the brief is handed to startSessionFromBrief so it never reaches the
        // loop / crystallised_prompt.
        return Object.assign(brief, {
            _reviseMeta: { total: allFindings.length, dropped: droppedIdx, demoted: demotedIdx, guidance },
        });
    }
    disposers.push(toDispose(api.registerTool({
        name: "harness_list_revisable",
        description: "List shipped harness PRs that are NOT merge-ready (merge_recommendation != 'merge'), so a user can pick one to revise. " +
            "Each item: sessionId, prNumber, prUrl, repo, branch, title, mergeRecommendation, reason, findingCount, lastVerdict. " +
            "Use this when a user asks to 'fix the findings' / 'revise' WITHOUT naming a specific PR -- present the list and let them choose, then call harness_revise with the chosen prNumber or sessionId.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
            const rows = listRevisableRows();
            const items = rows.map(summariseRevisable);
            return {
                content: [{ type: "text", text: JSON.stringify({ count: items.length, revisable: items }, null, 2) }],
                details: { ok: true, count: items.length, revisable: items },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_revise",
        description: "Revise a shipped-but-not-merge-ready harness PR by addressing its adversary findings, UPDATING THE SAME PR (new commits stack on the existing branch head -- no new PR opens). " +
            "Target resolution: pass `prNumber` OR `sessionId` to revise that specific one. Pass NEITHER to get back the revisable list (needsSelection=true) so the caller can present a picker and re-invoke with a choice. " +
            "The revise brief is built AUTOMATICALLY from the prior session's stored adversary findings + original goal -- the user does NOT need to know the session id or restate the findings. " +
            "beta.49: pass `dropFindings: [n, ...]` (1-based indices as shown by harness_list_revisable) to EXCLUDE stale/wrong findings from the revise (e.g. a finding whose premise is factually false). Conditional findings (premise depends on unverified repo state) are AUTOMATICALLY demoted to verify-premise-first, not dropped. " +
            "Pass `guidance: \"...\"` to steer WHAT THE FIX SHOULD DO when a finding names a symptom but understates the remedy -- it is folded into the brief as an authoritative operator instruction the lead, workers and adversary all see. Guidance adds intent only; it cannot drop a finding or lower a severity (that is dropFindings). " +
            "Returns the new revise sessionId (fire-and-forget loop; watch harness_progress). requester must be in slack.authorised_users.",
        parameters: {
            type: "object",
            properties: {
                requester: { type: "string", minLength: 1, description: "Slack user id of the invoker. Must be in slack.authorised_users." },
                prNumber: { type: "number", description: "PR number to revise. Alternative to sessionId." },
                sessionId: { type: "string", minLength: 1, description: "Shipped session id to revise. Alternative to prNumber." },
                budgetUsd: { type: "number", minimum: 0.05, description: "Optional per-session budget override for the revise run." },
                dropFindings: {
                    type: "array",
                    items: { type: "number", minimum: 1 },
                    description: "1-based finding indices (from harness_list_revisable) to EXCLUDE from this revise. Use for stale/false findings.",
                },
                guidance: {
                    type: "string",
                    minLength: 1,
                    // Bounded because it is copied into the lead, worker and adversary
                    // prompts on every cycle. 2000 chars is several paragraphs of
                    // direction; past that the operator wants a new brief, not a steer.
                    maxLength: 2000,
                    description: "Free-text direction for THIS revise, from the human requesting it -- what the fix must actually DO. " +
                        "Folded into the brief as an authoritative instruction that reaches the lead, the workers and the adversary. " +
                        "Use when a finding names a symptom but understates the remedy (e.g. 'translate status=DUE_FOR_RENEWAL into a reviewDate < now() predicate rather than rejecting it'). " +
                        "It ADDS intent only: it cannot drop a finding or lower a severity -- use dropFindings for that.",
                },
            },
            required: ["requester"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { requester, prNumber, sessionId, budgetUsd, dropFindings, guidance } = input;
            if (!liveConfig().slack.authorised_users.includes(requester)) {
                return { content: [{ type: "text", text: `Requester ${requester} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            // No target -> return the picker list.
            if (prNumber === undefined && !sessionId) {
                const items = listRevisableRows().map(summariseRevisable);
                return {
                    content: [
                        {
                            type: "text",
                            text: items.length === 0
                                ? "No revisable PRs (nothing shipped with a non-merge recommendation)."
                                : `Which PR would you like to revise? ${items.length} option(s):\n` +
                                    items.map((i) => `• PR #${i.prNumber} — ${i.title} (${i.findingCount} findings, ${i.mergeRecommendation})`).join("\n"),
                        },
                    ],
                    details: { ok: true, needsSelection: true, count: items.length, revisable: items },
                };
            }
            // Resolve the target row.
            let row;
            if (sessionId) {
                row = liveDb()
                    .prepare(`SELECT id, repo, branch, pr_number, final_pr_url, merge_recommendation, merge_recommendation_reason, crystallised_prompt, created_at FROM sessions WHERE id = ?`)
                    .get(sessionId);
            }
            else if (prNumber !== undefined) {
                row = liveDb()
                    .prepare(`SELECT id, repo, branch, pr_number, final_pr_url, merge_recommendation, merge_recommendation_reason, crystallised_prompt, created_at FROM sessions WHERE pr_number = ? ORDER BY created_at DESC LIMIT 1`)
                    .get(prNumber);
            }
            if (!row) {
                return { content: [{ type: "text", text: `No shipped session found for ${sessionId ? `session ${sessionId}` : `PR #${prNumber}`}.` }], details: { ok: false, notFound: true } };
            }
            if (!row.pr_number || !row.branch) {
                return { content: [{ type: "text", text: `Session ${row.id} has no PR/branch to revise.` }], details: { ok: false, noPr: true } };
            }
            const built = buildReviseBrief(row, { dropFindings, guidance });
            if ("error" in built) {
                return { content: [{ type: "text", text: built.error }], details: { ok: false, error: built.error } };
            }
            // Strip the advisory _reviseMeta before the brief goes to the loop /
            // crystallised_prompt (it's audit-only).
            const { _reviseMeta, ...cleanBrief } = built;
            const started = startSessionFromBrief({
                requester,
                brief: cleanBrief,
                budgetUsd,
                auditEvent: "tool.revise",
                // beta.120: a revise continues a brief the human already accepted,
                // against findings the harness itself raised. Re-confirming it
                // would gate the fix loop behind a round-trip for no new signal.
                confirmWaived: true,
            });
            if (!started.ok) {
                return { content: [{ type: "text", text: `Could not start revise: ${started.reason}` }], details: { ...started, ok: false } };
            }
            liveState().audit("tool.revise.started", {
                newSessionId: started.sessionId,
                reviseOfSessionId: row.id,
                prNumber: row.pr_number,
                branch: row.branch,
                requester,
                // beta.49 A+C: record which findings were dropped/demoted so the
                // revise's provenance is auditable.
                findingsTotal: _reviseMeta?.total ?? 0,
                findingsDropped: _reviseMeta?.dropped ?? [],
                findingsDemotedConditional: _reviseMeta?.demoted ?? [],
                // The operator's steer, verbatim as folded in. A revise that went
                // somewhere surprising should be answerable from the audit trail
                // alone -- "what were they told to build" is half of that, and it
                // is the half that was previously unrecorded because it could not
                // be said at all.
                guidance: _reviseMeta?.guidance ?? null,
            }, started.sessionId);
            return {
                content: [
                    {
                        type: "text",
                        text: `Revising PR #${row.pr_number} (branch ${row.branch}) as session ${started.sessionId}. ` +
                            (_reviseMeta?.dropped.length ? `Dropped finding(s) ${_reviseMeta.dropped.join(", ")}. ` : "") +
                            (_reviseMeta?.demoted.length ? `Auto-demoted conditional finding(s) ${_reviseMeta.demoted.join(", ")} to verify-first. ` : "") +
                            (_reviseMeta?.guidance ? `Operator guidance folded into the brief (findings and severities unchanged). ` : "") +
                            `New commits will update the same PR. Watch harness_progress for the new session.`,
                    },
                ],
                details: {
                    ok: true,
                    sessionId: started.sessionId,
                    reviseOfSessionId: row.id,
                    prNumber: row.pr_number,
                    branch: row.branch,
                    findingsDropped: _reviseMeta?.dropped ?? [],
                    findingsDemotedConditional: _reviseMeta?.demoted ?? [],
                    guidanceApplied: !!_reviseMeta?.guidance,
                    feedback: {
                        poll: "harness_progress",
                        args: { sessionId: started.sessionId },
                        intervalSeconds: 45,
                        relayField: "headline",
                        until: "terminal",
                        instruction: "Poll harness_progress every ~45s and relay the headline until terminal; the revise updates the SAME PR.",
                    },
                },
            };
        },
    })));
    // ---- harness_bootstrap_test_repo ----
    // Creates a fresh, disposable test repo under the requester's own GitHub
    // account, seeds it with a minimal README + docs/, and adds it to the LIVE
    // repos allow-list so a smoke test can target it immediately. This keeps
    // smoke tests off the harness's own source repo (branch clutter / accidental
    // PRs). The allow-list addition is IN-MEMORY only (not persisted to config);
    // it survives until the next plugin (re-)register.
    disposers.push(toDispose(api.registerTool({
        name: "harness_bootstrap_test_repo",
        description: "Create a fresh disposable test repo under the requester's GitHub account (seeded with README + docs/SMOKE.md) and add it to the live repos allow-list, for repeatable smoke tests. Does NOT persist to config. Params: { owner, name?, private?, requester? }.",
        parameters: {
            type: "object",
            properties: {
                owner: { type: "string", description: "GitHub account (user or org) to create the repo under. Used to resolve the vault credential service." },
                name: { type: "string", description: "Repo name. Default: 'oah-smoke-test-<timestamp>'." },
                private: { type: "boolean", description: "Create as private. Default true." },
                requester: { type: "string", description: "Slack user id of the requester (for audit + PAT routing). Optional." },
            },
            required: ["owner"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const p = (input ?? {});
            if (!p.owner) {
                return { content: [{ type: "text", text: "owner is required" }], details: { ok: false, reason: "owner required" } };
            }
            const requester = p.requester ?? liveConfig().slack.authorised_users[0] ?? "unknown";
            const name = p.name ?? `oah-smoke-test-${Date.now()}`;
            const isPrivate = p.private !== false; // default private
            const repoFullName = `${p.owner}/${name}`;
            // Resolve a GitHub token (vault-first, env fallback) via the router.
            let token;
            try {
                const resolution = liveRuntime().pat.resolve({
                    slackUserId: requester,
                    gitHubUser: p.owner,
                    repoFullName,
                });
                if (resolution.provider !== "github") {
                    return { content: [{ type: "text", text: `harness_bootstrap_test_repo currently supports GitHub only; '${p.owner}' resolves to provider '${resolution.provider}'` }], details: { ok: false, reason: "provider_unsupported" } };
                }
                token = await liveRuntime().gitToken(resolution);
            }
            catch (err) {
                return { content: [{ type: "text", text: `Could not resolve a GitHub token for ${p.owner}: ${String(err)}` }], details: { ok: false, reason: "no_token" } };
            }
            const ghHeaders = {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "openclaw-agent-harness",
                "Content-Type": "application/json",
            };
            // 1) Who am I? Decide user-repo vs org-repo endpoint.
            let login;
            try {
                const who = await fetch("https://api.github.com/user", { headers: ghHeaders });
                if (who.ok)
                    login = (await who.json()).login;
            }
            catch { /* fall through; treat as org create */ }
            const createUrl = login && login.toLowerCase() === p.owner.toLowerCase()
                ? "https://api.github.com/user/repos"
                : `https://api.github.com/orgs/${p.owner}/repos`;
            // 2) Create the repo (auto_init gives us a main branch + README).
            const createResp = await fetch(createUrl, {
                method: "POST",
                headers: ghHeaders,
                body: JSON.stringify({
                    name,
                    private: isPrivate,
                    auto_init: true,
                    description: "Disposable smoke-test repo created by openclaw-agent-harness. Safe to delete.",
                }),
            });
            if (!createResp.ok) {
                const body = await createResp.text().catch(() => "");
                return {
                    content: [{ type: "text", text: `GitHub repo create failed: ${createResp.status} ${createResp.statusText} ${body.slice(0, 200)}` }],
                    details: { ok: false, reason: "create_failed", status: createResp.status },
                };
            }
            const created = (await createResp.json());
            const branch = created.default_branch ?? "main";
            // 3) Seed docs/SMOKE.md (README already exists from auto_init).
            const seed = async (path, content, message) => {
                const putResp = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${path}`, {
                    method: "PUT",
                    headers: ghHeaders,
                    body: JSON.stringify({
                        message,
                        content: Buffer.from(content, "utf8").toString("base64"),
                        branch,
                    }),
                });
                return putResp.ok;
            };
            const seededDocs = await seed("docs/SMOKE.md", "# Smoke test target\n\nDisposable repo for openclaw-agent-harness smoke tests. Safe to delete.\n", "chore: seed docs/SMOKE.md for harness smoke tests");
            // 4) Add to the LIVE allow-list (in-memory, not persisted).
            const allow = liveConfig().repos.allowed;
            if (!allow.includes(repoFullName))
                allow.push(repoFullName);
            liveState().audit("tool.bootstrap_test_repo", { repoFullName, private: isPrivate, requester, seededDocs }, undefined);
            return {
                content: [{
                        type: "text",
                        text: `Created ${isPrivate ? "private" : "public"} test repo ${repoFullName} (${created.html_url ?? ""}), seeded README + docs/SMOKE.md${seededDocs ? "" : " (docs seed failed)"}, and added it to the live allow-list. Note: allow-list add is in-memory only; add it to config.repos.allowed to persist.`,
                    }],
                details: {
                    ok: true,
                    repo: repoFullName,
                    url: created.html_url,
                    branch,
                    private: isPrivate,
                    seededDocs,
                    allowListAddedInMemory: true,
                },
            };
        },
    })));
    return () => {
        for (const d of disposers) {
            try {
                d();
            }
            catch { /* ignore */ }
        }
    };
}
function monthStart(yyyymm) {
    const [y, m] = yyyymm.split("-").map(Number);
    return Date.UTC(y, (m ?? 1) - 1, 1);
}
//# sourceMappingURL=registration.js.map