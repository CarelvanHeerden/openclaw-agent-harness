/**
 * Runtime tool registration for openclaw-agent-harness.
 *
 * These are the tools OpenClaw exposes to callers (Slack users via
 * commands, other plugins, or cron jobs). They intentionally do NOT
 * include the "run a task" surface -- that entry point is the Slack
 * listener. These tools are for inspection, admin, and cron jobs.
 */
import { getCurrentRuntime } from "../runtime-registry.js";
import { pruneRetention } from "../state/retention.js";
import { buildProgressSnapshot } from "../orchestrator/progress.js";
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
                // thread slot so the retry can take it. Their worktrees/PRs were
                // already cleaned up on the terminal transition.
                const del = liveDb().prepare(`DELETE FROM sessions WHERE slack_channel = ? AND slack_thread = ? AND status IN ('done','failed','aborted')`);
                const info = del.run(slackChannel, slackThread);
                liveState().audit("tool.run.thread_reclaimed", { channel: slackChannel, thread: slackThread, freed: info.changes, priorIds: prior.map((p) => p.id) });
            }
        }
        try {
            liveDb()
                .prepare(`INSERT INTO sessions (
             id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
             status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran
           ) VALUES (?, ?, ?, ?, ?, '', '', '', 'planning', ?, ?, ?, ?, 0, 0)`)
                .run(sessionId, slackThread, slackChannel, params.requester, params.requester, JSON.stringify(params.brief), Date.now(), Date.now(), params.budgetUsd ?? liveConfig().budgets.session_default_usd);
        }
        catch (err) {
            if (String(err).includes("UNIQUE") || String(err).includes("SQLITE_CONSTRAINT")) {
                return { ok: false, duplicateThread: true, reason: `Session already exists for thread ${slackThread}` };
            }
            throw err;
        }
        liveState().audit(params.auditEvent, { sessionId, requester: params.requester }, sessionId);
        void liveRuntime().loop.run(sessionId, params.brief).catch((err) => {
            api.logger.error(`[${params.auditEvent}] loop crashed`, { sessionId, err: String(err) });
        });
        return { ok: true, sessionId };
    }
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
                            models: liveConfig().models,
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
        description: "Poll live progress for a harness run started by harness_run / harness_start_session. Returns the current phase, per-sub-task N/M status, running cost vs budget, recent lifecycle events, PR/deploy state, ms-since-last-event, and a ready-to-post `headline` line. The harness NEVER posts to Slack itself (tool-driven) -- YOU poll this on an interval (~30-60s) and relay `headline` (or a rephrase) to the user, stopping when `terminal` is true. Use this right after kicking off a run so the user gets feedback instead of silence.",
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
            const snapshot = buildProgressSnapshot(liveDb(), sessionId, opts.eventLimit ?? 12);
            return {
                content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
                details: {
                    ok: snapshot.ok,
                    found: snapshot.found,
                    terminal: snapshot.terminal,
                    phase: snapshot.phase,
                    headline: snapshot.headline,
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
                invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker. If provided, must be in slack.authorised_users." },
            },
            required: ["sessionId"],
            additionalProperties: false,
        },
        execute: (_callId, input) => {
            const { sessionId, reason, invokedBy } = input;
            if (invokedBy && !liveConfig().slack.authorised_users.includes(invokedBy)) {
                return { content: [{ type: "text", text: `Invoker ${invokedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
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
                invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker; must be in slack.authorised_users if provided." },
                repairBudgetUsd: { type: "number", minimum: 0, description: "Optional override (USD) for the post-merge deploy-repair budget on Vercel projects. Defaults to budgets.daily_max_usd * vercel.deploy_repair.budget_ratio." },
            },
            required: ["sessionId"],
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
            const where = slackThread ? "Watch the Slack thread for progress." : "Poll harness_status / harness_session_get for progress.";
            return { content: [{ type: "text", text: `Session ${res.sessionId} started. ${where}` }], details: { ok: true, sessionId: res.sessionId } };
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
                request: { type: "string", minLength: 10, description: "The raw natural-language coding request to crystallise and run." },
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
            required: ["requester", "request"],
            additionalProperties: false,
        },
        execute: async (_callId, input) => {
            const { requester, request, slackChannel, slackThread, budgetUsd, relevantConcepts } = input;
            if (!liveConfig().slack.authorised_users.includes(requester)) {
                return { content: [{ type: "text", text: `Requester ${requester} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            let cResult;
            try {
                cResult = await liveRuntime().crystallise(request, relevantConcepts);
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
            });
            if (!res.ok) {
                return { content: [{ type: "text", text: res.reason }], details: { ok: false, unauthorised: res.unauthorised, duplicateThread: res.duplicateThread } };
            }
            const where = slackThread ? "Progress will post to the Slack thread." : "Poll harness_status / harness_session_get for progress.";
            return {
                content: [{ type: "text", text: `Session ${res.sessionId} started for "${cResult.brief.title}". ${where}` }],
                details: { ok: true, sessionId: res.sessionId, brief: cResult.brief },
            };
        },
    })));
    disposers.push(toDispose(api.registerTool({
        name: "harness_health",
        description: "Return a health snapshot: DB reachable, schema OK, config well-formed, model auth resolvable, credentials configured. For smoke tests + monitoring. Pass { deep: true } to also do a tiny live SDK ping that verifies the Anthropic key actually authenticates (costs a few tokens).",
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
            checks.push({ name: "config_slack_channel", ok: !!liveConfig().slack.channel, detail: liveConfig().slack.channel });
            checks.push({ name: "config_authorised_users", ok: liveConfig().slack.authorised_users.length > 0 });
            checks.push({ name: "config_repos_allowed", ok: liveConfig().repos.allowed.length > 0 });
            // Model auth: can we resolve an Anthropic API key for the embedded
            // Claude Agent SDK? A missing key means the FIRST session plan dies
            // immediately with "Not logged in" -- so this is FATAL to overall
            // health, closing the gap between "healthy" and "able to plan".
            const auth = liveConfig().models.auth ?? {};
            let apiKey;
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
            // Optional deep check: a tiny live SDK call proves the key actually
            // authenticates (catches expired/invalid keys, not just missing).
            if (deep) {
                if (!apiKey) {
                    checks.push({ name: "model_auth_live_ping", ok: false, detail: "skipped: no key to test" });
                }
                else {
                    try {
                        const { runClassifierSdk } = await import("../adapters/claude-sdk.js");
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
                c.name === "git_credential_live_ping")
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
            if (invokedBy && !liveConfig().slack.authorised_users.includes(invokedBy)) {
                return { content: [{ type: "text", text: `Invoker ${invokedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
            }
            const row = liveDb().prepare(`SELECT status, crystallised_prompt FROM sessions WHERE id = ?`).get(sessionId);
            if (!row)
                return { content: [{ type: "text", text: `No session ${sessionId}` }], details: { ok: false, notFound: true } };
            if (!["interrupted", "resumable"].includes(row.status)) {
                return { content: [{ type: "text", text: `Cannot resume ${sessionId} in status ${row.status}` }], details: { ok: false, badStatus: row.status } };
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