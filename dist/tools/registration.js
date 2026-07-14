/**
 * Runtime tool registration for openclaw-agent-harness.
 *
 * These are the tools OpenClaw exposes to callers (Slack users via
 * commands, other plugins, or cron jobs). They intentionally do NOT
 * include the "run a task" surface -- that entry point is the Slack
 * listener. These tools are for inspection, admin, and cron jobs.
 */
import { pruneRetention } from "../state/retention.js";
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
    disposers.push(toDispose(api.registerTool({
        name: "harness_status",
        description: "Return harness runtime status: active sessions, monthly spend per user, model config.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: (_callId, _params) => {
            const sessions = runtime.state.db
                .prepare(`SELECT id, status, requester, repo, branch, cycles_ran, cost_usd,
                      datetime(created_at/1000,'unixepoch') AS created
               FROM sessions
               WHERE status NOT IN ('done','failed','aborted')
               ORDER BY created_at DESC`)
                .all();
            const month = new Date().toISOString().slice(0, 7);
            const spend = runtime.state.db
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
                            models: runtime.config.models,
                            channel: runtime.config.slack.channel,
                            reposAllowed: runtime.config.repos.allowed,
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
            const result = pruneRetention(runtime.state, {
                auditRetentionDays: opts.auditRetentionDays ?? runtime.config.storage.audit_retention_days,
                pruneTerminalSessions: runtime.config.storage.prune_terminal_sessions,
                pruneTerminalSessionsDays: runtime.config.storage.prune_terminal_sessions_days,
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
            const session = runtime.state.db
                .prepare(`SELECT * FROM sessions WHERE id = ?`)
                .get(sessionId);
            if (!session) {
                return {
                    content: [{ type: "text", text: `No session ${sessionId}` }],
                    details: { ok: false, notFound: true },
                };
            }
            const subTasks = runtime.state.db
                .prepare(`SELECT * FROM sub_tasks WHERE session_id = ? ORDER BY seq ASC`)
                .all(sessionId);
            const reviews = runtime.state.db
                .prepare(`SELECT * FROM reviews WHERE session_id = ? ORDER BY cycle ASC`)
                .all(sessionId);
            const audit = runtime.state.db
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
                invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker. If provided, must be in slack.authorised_users." },
            },
            required: ["sessionId"],
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const { sessionId, reason, invokedBy } = input;
            if (invokedBy && !runtime.config.slack.authorised_users.includes(invokedBy)) {
                return { content: [{ type: "text", text: `Invoker ${invokedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const row = runtime.state.db.prepare(`SELECT status, reactions_json FROM sessions WHERE id = ?`).get(sessionId);
            if (!row)
                return { content: [{ type: "text", text: `No session ${sessionId}` }], details: { ok: false, notFound: true } };
            if (["done", "failed", "aborted"].includes(row.status)) {
                return { content: [{ type: "text", text: `Session ${sessionId} is already terminal (${row.status})` }], details: { ok: false, alreadyTerminal: true, status: row.status } };
            }
            const parsed = row.reactions_json ? JSON.parse(row.reactions_json) : {};
            parsed.abort = true;
            runtime.state.db.prepare(`UPDATE sessions SET reactions_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(parsed), Date.now(), sessionId);
            runtime.state.audit("tool.cancel", { sessionId, reason: reason ?? "tool-invoked", invokedBy: invokedBy ?? null }, sessionId);
            return { content: [{ type: "text", text: `Abort flag set on ${sessionId}. The loop will terminate at its next checkpoint.` }], details: { ok: true, sessionId } };
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
            if (!runtime.config.slack.authorised_users.includes(p.uploadedBy)) {
                return { content: [{ type: "text", text: `Uploader ${p.uploadedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const sess = runtime.state.db.prepare(`SELECT id, status FROM sessions WHERE id=?`).get(p.sessionId);
            if (!sess?.id) {
                return { content: [{ type: "text", text: `Unknown session ${p.sessionId}` }], details: { ok: false, notFound: true } };
            }
            const CAP = 16 * 1024;
            const excerpt = p.logsExcerpt.length > CAP ? p.logsExcerpt.slice(0, CAP) + "\n[...truncated at 16KB]" : p.logsExcerpt;
            runtime.state.db
                .prepare(`INSERT INTO runtime_uploads (session_id, uploaded_by, source, status, logs_excerpt, error_count, deployment_url, uploaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(p.sessionId, p.uploadedBy, p.source ?? null, p.status, excerpt, p.errorCount ?? null, p.deploymentUrl ?? null, Date.now());
            runtime.state.audit("runtime.upload", { uploadedBy: p.uploadedBy, status: p.status, bytes: excerpt.length, source: p.source }, p.sessionId);
            return { content: [{ type: "text", text: `Uploaded ${excerpt.length} bytes of runtime logs for ${p.sessionId} (status=${p.status}). Adversary will pick this up on the next cycle.` }], details: { ok: true, bytes: excerpt.length } };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_start_session",
        description: "Start a harness session directly (bypasses classifier). Useful for slash commands, cron-triggered runs, or other plugins.",
        parameters: {
            type: "object",
            properties: {
                requester: { type: "string", minLength: 1, description: "Slack user id of the requester" },
                slackChannel: { type: "string", minLength: 1 },
                slackThread: { type: "string", minLength: 1, description: "Thread ts to reply into (usually the origin message ts)" },
                brief: {
                    type: "object",
                    required: ["title", "motivation", "acceptanceCriteria"],
                    properties: {
                        title: { type: "string", minLength: 3 },
                        motivation: { type: "string", minLength: 10 },
                        acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 3 } },
                        filesLikelyTouched: { type: "array", items: { type: "string" } },
                        outOfScope: { type: "array", items: { type: "string" } },
                        repoHint: { type: "string" },
                        branchHint: { type: "string" },
                        riskLevel: { type: "string", enum: ["low", "medium", "high"] },
                    },
                },
                budgetUsd: { type: "number", minimum: 1 },
            },
            required: ["requester", "slackChannel", "slackThread", "brief"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { requester, slackChannel, slackThread, brief, budgetUsd } = input;
            if (!runtime.config.slack.authorised_users.includes(requester)) {
                return { content: [{ type: "text", text: `Requester ${requester} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const sessionId = (globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            const briefFull = {
                title: brief.title,
                motivation: brief.motivation,
                acceptanceCriteria: brief.acceptanceCriteria,
                filesLikelyTouched: brief.filesLikelyTouched ?? [],
                outOfScope: brief.outOfScope ?? [],
                repoHint: brief.repoHint,
                branchHint: brief.branchHint,
                riskLevel: (brief.riskLevel ?? "low"),
            };
            try {
                runtime.state.db
                    .prepare(`INSERT INTO sessions (
                   id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
                   status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran
                 ) VALUES (?, ?, ?, ?, ?, '', '', '', 'planning', ?, ?, ?, ?, 0, 0)`)
                    .run(sessionId, slackThread, slackChannel, requester, requester, JSON.stringify(briefFull), Date.now(), Date.now(), budgetUsd ?? runtime.config.budgets.session_default_usd);
            }
            catch (err) {
                if (String(err).includes("UNIQUE") || String(err).includes("SQLITE_CONSTRAINT")) {
                    return { content: [{ type: "text", text: `Session already exists for thread ${slackThread}` }], details: { ok: false, duplicateThread: true } };
                }
                throw err;
            }
            runtime.state.audit("tool.start_session", { sessionId, requester }, sessionId);
            void runtime.loop.run(sessionId, briefFull).catch((err) => {
                api.logger.error("[tool.start_session] loop crashed", { sessionId, err: String(err) });
            });
            return { content: [{ type: "text", text: `Session ${sessionId} started. Watch Slack thread for progress.` }], details: { ok: true, sessionId } };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_health",
        description: "Return a health snapshot: DB reachable, schema OK, config well-formed, credentials configured. For smoke tests + monitoring.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: (_callId, _params) => {
            const checks = [];
            // DB reachable?
            try {
                runtime.state.db.prepare(`SELECT 1`).get();
                checks.push({ name: "db_reachable", ok: true });
            }
            catch (err) {
                checks.push({ name: "db_reachable", ok: false, detail: String(err) });
            }
            // Schema tables present?
            const need = ["sessions", "sub_tasks", "reviews", "budgets_daily", "budgets_monthly", "audit_log"];
            for (const t of need) {
                const row = runtime.state.db
                    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
                    .get(t);
                checks.push({ name: `table_${t}`, ok: !!row?.name });
            }
            // Config: minimally-valid?
            checks.push({ name: "config_slack_channel", ok: !!runtime.config.slack.channel, detail: runtime.config.slack.channel });
            checks.push({ name: "config_authorised_users", ok: runtime.config.slack.authorised_users.length > 0 });
            checks.push({ name: "config_repos_allowed", ok: runtime.config.repos.allowed.length > 0 });
            // Credentials: are we set to talk to Slack/Vercel? (informational, not fatal)
            checks.push({ name: "slack_credential_service_set", ok: !!runtime.config.slack.credential_service });
            checks.push({ name: "vercel_enabled", ok: !!runtime.config.vercel?.enabled });
            const overall = checks.filter((c) => c.name.startsWith("table_") || c.name === "db_reachable" || c.name.startsWith("config_")).every((c) => c.ok);
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
                ? runtime.state.db.prepare(`SELECT month, user, spent_usd, session_count FROM budgets_monthly WHERE month = ? AND user = ?`).all(targetMonth, user)
                : runtime.state.db.prepare(`SELECT month, user, spent_usd, session_count FROM budgets_monthly WHERE month = ? ORDER BY spent_usd DESC`).all(targetMonth);
            const dailyRows = user
                ? runtime.state.db.prepare(`SELECT day, user, spent_usd FROM budgets_daily WHERE day LIKE ? AND user = ? ORDER BY day DESC`).all(`${targetMonth}%`, user)
                : runtime.state.db.prepare(`SELECT day, user, spent_usd FROM budgets_daily WHERE day LIKE ? ORDER BY day DESC`).all(`${targetMonth}%`);
            const sessionRows = user
                ? runtime.state.db.prepare(`SELECT id, status, requester, repo, cost_usd, cycles_ran, datetime(created_at/1000,'unixepoch') AS created FROM sessions WHERE requester = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 100`).all(user, monthStart(targetMonth))
                : runtime.state.db.prepare(`SELECT id, status, requester, repo, cost_usd, cycles_ran, datetime(created_at/1000,'unixepoch') AS created FROM sessions WHERE created_at >= ? ORDER BY created_at DESC LIMIT 100`).all(monthStart(targetMonth));
            const totals = {
                monthUsd: monthlyRows.reduce((a, r) => a + (r.spent_usd || 0), 0),
                sessions: sessionRows.length,
                shipped: sessionRows.filter((s) => s.status === "done").length,
                failed: sessionRows.filter((s) => s.status === "failed").length,
                aborted: sessionRows.filter((s) => s.status === "aborted").length,
                active: sessionRows.filter((s) => !["done", "failed", "aborted", "interrupted"].includes(s.status)).length,
            };
            return {
                content: [{ type: "text", text: JSON.stringify({ month: targetMonth, totals, monthly: monthlyRows, daily: dailyRows, sessions: sessionRows }, null, 2) }],
                details: { ok: true, month: targetMonth, totals },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_resume",
        description: "Resume an interrupted harness session. Requires the session to be in 'interrupted' or 'resumable' state.",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", minLength: 1 },
                invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker. If provided, must be in slack.authorised_users." },
            },
            required: ["sessionId"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { sessionId, invokedBy } = input;
            if (invokedBy && !runtime.config.slack.authorised_users.includes(invokedBy)) {
                return { content: [{ type: "text", text: `Invoker ${invokedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const row = runtime.state.db.prepare(`SELECT status, crystallised_prompt FROM sessions WHERE id = ?`).get(sessionId);
            if (!row)
                return { content: [{ type: "text", text: `No session ${sessionId}` }], details: { ok: false, notFound: true } };
            if (!["interrupted", "resumable"].includes(row.status)) {
                return { content: [{ type: "text", text: `Cannot resume ${sessionId} in status ${row.status}` }], details: { ok: false, badStatus: row.status } };
            }
            if (!row.crystallised_prompt) {
                return { content: [{ type: "text", text: `Session ${sessionId} has no crystallised brief; cannot resume.` }], details: { ok: false, missingBrief: true } };
            }
            const brief = JSON.parse(row.crystallised_prompt);
            runtime.state.db.prepare(`UPDATE sessions SET status = 'planning', updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
            runtime.state.audit("tool.resume", { sessionId, wasStatus: row.status, invokedBy: invokedBy ?? null }, sessionId);
            // Fire-and-forget: loop takes over from planning
            void runtime.loop.run(sessionId, brief).catch((err) => {
                api.logger.error("[tool.resume] loop.run failed", { sessionId, err: String(err) });
            });
            return { content: [{ type: "text", text: `Session ${sessionId} resumed. Watch the Slack thread for progress.` }], details: { ok: true, sessionId } };
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