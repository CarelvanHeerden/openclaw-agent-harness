/**
 * Runtime tool registration for openclaw-agent-harness.
 *
 * These are the tools OpenClaw exposes to callers (Slack users via
 * commands, other plugins, or cron jobs). They intentionally do NOT
 * include the "run a task" surface -- that entry point is the Slack
 * listener. These tools are for inspection, admin, and cron jobs.
 */

import type { HarnessPluginApi, HarnessRuntime } from "../index.js";
import { getCurrentRuntime } from "../runtime-registry.js";
import { pruneRetention } from "../state/retention.js";

type ToolDisposer = (() => void) | { dispose?: () => void; unregister?: () => void };

function toDispose(x: ToolDisposer): () => void {
  return () => {
    if (typeof x === "function") x();
    else if (x && typeof x === "object") {
      if (typeof x.dispose === "function") x.dispose();
      else if (typeof x.unregister === "function") x.unregister();
    }
  };
}

/** Normalised brief shape used by both harness_run and harness_start_session. */
interface RunnableBrief {
  title: string;
  motivation: string;
  acceptanceCriteria: string[];
  filesLikelyTouched: string[];
  outOfScope: string[];
  repoHint?: string;
  branchHint?: string;
  riskLevel: "low" | "medium" | "high";
  /**
   * beta.21: OKF concept refs carried into the plan + worker prompts.
   * Optional; pre-beta.21 briefs simply omit the field.
   */
  relevantConcepts?: Array<{ id: string; path?: string; summary?: string; tags?: string[]; content?: string }>;
}

export function registerHarnessTools(api: HarnessPluginApi, runtime: HarnessRuntime): () => void {
  const disposers: Array<() => void> = [];

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
  const liveRuntime = (): HarnessRuntime =>
    (getCurrentRuntime() as HarnessRuntime | null) ?? runtime;

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
      throw new Error(
        "harness state DB is not open (plugin is re-registering); retry in a moment",
      );
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
  function startSessionFromBrief(params: {
    requester: string;
    brief: RunnableBrief;
    slackChannel?: string;
    slackThread?: string;
    budgetUsd?: number;
    auditEvent: string;
  }):
    | { ok: true; sessionId: string }
    | { ok: false; reason: string; unauthorised?: boolean; duplicateThread?: boolean } {
    if (!liveConfig().slack.authorised_users.includes(params.requester)) {
      return { ok: false, unauthorised: true, reason: `Requester ${params.requester} is not in slack.authorised_users` };
    }
    const sessionId = globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const slackChannel = params.slackChannel ?? "";
    // Synthesise a unique thread key when the agent supplies none.
    const slackThread = params.slackThread ?? `agent:${sessionId}`;
    try {
      liveDb()
        .prepare(
          `INSERT INTO sessions (
             id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
             status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran
           ) VALUES (?, ?, ?, ?, ?, '', '', '', 'planning', ?, ?, ?, ?, 0, 0)`,
        )
        .run(
          sessionId, slackThread, slackChannel, params.requester, params.requester,
          JSON.stringify(params.brief), Date.now(), Date.now(),
          params.budgetUsd ?? liveConfig().budgets.session_default_usd,
        );
    } catch (err) {
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

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_status",
        description:
          "Return harness runtime status: active sessions, monthly spend per user, model config.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: (_callId: unknown, _params: unknown) => {
          const sessions = liveDb()
            .prepare(
              `SELECT id, status, requester, repo, branch, cycles_ran, cost_usd,
                      datetime(created_at/1000,'unixepoch') AS created
               FROM sessions
               WHERE status NOT IN ('done','failed','aborted')
               ORDER BY created_at DESC`,
            )
            .all();
          const month = new Date().toISOString().slice(0, 7);
          const spend = liveDb()
            .prepare(
              `SELECT user, spent_usd, session_count
               FROM budgets_monthly WHERE month = ?
               ORDER BY spent_usd DESC`,
            )
            .all(month);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    activeSessions: sessions,
                    monthlySpend: spend,
                    models: liveConfig().models,
                    channel: liveConfig().slack.channel,
                    reposAllowed: liveConfig().repos.allowed,
                  },
                  null,
                  2,
                ),
              },
            ],
            details: {
              ok: true,
              activeSessionCount: sessions.length,
            },
          };
        },
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_retention_prune",
        description:
          "Prune the harness audit log per retention policy. Safe to invoke daily from cron.",
        parameters: {
          type: "object",
          properties: {
            auditRetentionDays: { type: "number", minimum: 7, maximum: 3650 },
          },
          additionalProperties: false,
        },
        execute: (_callId: unknown, input: unknown) => {
          const opts = (input ?? {}) as { auditRetentionDays?: number };
          const result = pruneRetention(liveState(), {
            auditRetentionDays:
              opts.auditRetentionDays ?? liveConfig().storage.audit_retention_days,
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
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_session_get",
        description: "Get full details of a harness session by id.",
        parameters: {
          type: "object",
          properties: { sessionId: { type: "string", minLength: 1 } },
          required: ["sessionId"],
          additionalProperties: false,
        },
        execute: (_callId: unknown, input: unknown) => {
          const { sessionId } = input as { sessionId: string };
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
            .prepare(
              `SELECT event, payload, datetime(created_at/1000,'unixepoch') AS ts
               FROM audit_log WHERE session_id = ? ORDER BY id ASC LIMIT 200`,
            )
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
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_cancel",
        description:
          "Cancel an in-flight harness session by setting an abort flag the loop reads on its next checkpoint.",
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
        execute: (_callId: unknown, input: unknown) => {
          const { sessionId, reason, invokedBy } = input as { sessionId: string; reason?: string; invokedBy?: string };
          if (invokedBy && !liveConfig().slack.authorised_users.includes(invokedBy)) {
            return { content: [{ type: "text", text: `Invoker ${invokedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
          }
          const row = liveDb().prepare(`SELECT status, reactions_json FROM sessions WHERE id = ?`).get(sessionId) as { status: string; reactions_json?: string } | undefined;
          if (!row) return { content: [{ type: "text", text: `No session ${sessionId}` }], details: { ok: false, notFound: true } };
          if (["done", "failed", "aborted"].includes(row.status)) {
            return { content: [{ type: "text", text: `Session ${sessionId} is already terminal (${row.status})` }], details: { ok: false, alreadyTerminal: true, status: row.status } };
          }
          const parsed = row.reactions_json ? JSON.parse(row.reactions_json) : {};
          parsed.abort = true;
          liveDb().prepare(`UPDATE sessions SET reactions_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(parsed), Date.now(), sessionId);
          liveState().audit("tool.cancel", { sessionId, reason: reason ?? "tool-invoked", invokedBy: invokedBy ?? null }, sessionId);
          return { content: [{ type: "text", text: `Abort flag set on ${sessionId}. The loop will terminate at its next checkpoint.` }], details: { ok: true, sessionId } };
        },
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_upload_logs",
        description:
          "Attach runtime logs to a session manually. Use when the target repo does NOT deploy to Vercel (Cloudflare, AWS, on-prem) or when the Vercel bridge is disabled. The adversary reads the most recent upload for a session and treats it as runtime evidence with provider=\"manual\".",
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
        execute: (_callId: unknown, input: unknown) => {
          const p = input as {
            sessionId: string;
            uploadedBy: string;
            status: "ok" | "build_failed" | "no_deploy_yet" | "unavailable";
            logsExcerpt: string;
            source?: string;
            errorCount?: number;
            deploymentUrl?: string;
          };
          if (!liveConfig().slack.authorised_users.includes(p.uploadedBy)) {
            return { content: [{ type: "text", text: `Uploader ${p.uploadedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
          }
          const sess = liveDb().prepare(`SELECT id, status FROM sessions WHERE id=?`).get(p.sessionId) as { id?: string; status?: string } | undefined;
          if (!sess?.id) {
            return { content: [{ type: "text", text: `Unknown session ${p.sessionId}` }], details: { ok: false, notFound: true } };
          }
          const CAP = 16 * 1024;
          const excerpt = p.logsExcerpt.length > CAP ? p.logsExcerpt.slice(0, CAP) + "\n[...truncated at 16KB]" : p.logsExcerpt;
          liveDb()
            .prepare(
              `INSERT INTO runtime_uploads (session_id, uploaded_by, source, status, logs_excerpt, error_count, deployment_url, uploaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(p.sessionId, p.uploadedBy, p.source ?? null, p.status, excerpt, p.errorCount ?? null, p.deploymentUrl ?? null, Date.now());
          liveState().audit("runtime.upload", { uploadedBy: p.uploadedBy, status: p.status, bytes: excerpt.length, source: p.source }, p.sessionId);
          return { content: [{ type: "text", text: `Uploaded ${excerpt.length} bytes of runtime logs for ${p.sessionId} (status=${p.status}). Adversary will pick this up on the next cycle.` }], details: { ok: true, bytes: excerpt.length } };
        },
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_start_session",
        description:
          "Start a harness session from a STRUCTURED brief (skips the classifier/crystalliser). Use this when you have already refined the request into title + motivation + acceptance criteria. For a raw natural-language request, use harness_run instead. Slack channel/thread are optional; when omitted, progress is not posted to Slack and you poll harness_status / harness_session_get for the outcome.",
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
                  description:
                    "Optional. OKF concept references relevant to this brief. Each item: { id, path?, summary?, tags?, content? }. See harness_run docs for semantics.",
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
                  description:
                    "Optional branch name hint. NOT authoritative: the harness namespaces all branches under 'harness/' and slugifies the hint, so the actual branch may differ (e.g. 'smoke/x' -> 'harness/smoke-x'). Read the resolved branch from harness_status or harness_session_get after planning.",
                },
                riskLevel: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
            budgetUsd: {
              type: "number",
              minimum: 0.05,
              description:
                "Optional per-session budget override (USD). Minimum 0.05; sub-$1 budgets are valid for plan-only dry runs. Capped at budgets.session_hard_ceiling_usd and remaining monthly budget.",
            },
          },
          required: ["requester", "brief"],
          additionalProperties: false,
        },
        execute: async (_callId: unknown, input: unknown) => {
          const { requester, slackChannel, slackThread, brief, budgetUsd } = input as {
            requester: string;
            slackChannel?: string;
            slackThread?: string;
            brief: { title: string; motivation: string; acceptanceCriteria: string[]; filesLikelyTouched?: string[]; outOfScope?: string[]; repoHint?: string; branchHint?: string; riskLevel?: string; relevantConcepts?: Array<{ id: string; path?: string; summary?: string; tags?: string[]; content?: string }> };
            budgetUsd?: number;
          };
          const briefFull: RunnableBrief = {
            title: brief.title,
            motivation: brief.motivation,
            acceptanceCriteria: brief.acceptanceCriteria,
            filesLikelyTouched: brief.filesLikelyTouched ?? [],
            outOfScope: brief.outOfScope ?? [],
            relevantConcepts: brief.relevantConcepts,
            repoHint: brief.repoHint,
            branchHint: brief.branchHint,
            riskLevel: (brief.riskLevel ?? "low") as "low" | "medium" | "high",
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
      }),
    ),
  );

  // ---- harness_run: the PRIMARY agent entry point ----
  //
  // Takes a raw natural-language request, runs the SAME classify -> refine
  // pipeline the Slack listener uses, and either (a) starts a session and
  // returns its id, (b) returns a clarifying question for the agent to put
  // back to the user, or (c) rejects (not a dev task / unsafe). This is how
  // the OpenClaw agent orchestrates the harness end to end.
  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_run",
        description:
          "PRIMARY entry point. Hand the harness a raw natural-language coding request; it classifies + crystallises it into a brief and starts a session (plan -> parallel workers -> adversarial review -> PR). Returns either a started sessionId, a clarifying question to relay to the user, or a rejection. Use this instead of harness_start_session unless you have already built a structured brief. Slack channel/thread are optional; omit them for pure agent-orchestrated runs and poll harness_status for the outcome. beta.21: optionally pass `relevantConcepts` if your OpenClaw agent's context enrichment surfaced OKF concept blocks that relate to this request — they'll propagate to the lead planner and workers.",
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
              description:
                "Optional per-session budget override (USD). Minimum 0.05; sub-$1 budgets are valid for plan-only dry runs. Capped at budgets.session_hard_ceiling_usd and remaining monthly budget.",
            },
            // beta.21: OKF concept pass-through.
            relevantConcepts: {
              type: "array",
              description:
                "Optional. OKF concept references the OpenClaw agent's context enrichment surfaced as relevant to this request. The harness does NOT crawl OKF itself; this is the pass-through so concepts propagate into the crystallised brief, the lead plan's file hints, and the worker system prompts. Each item: { id, path?, summary?, tags?, content? }. Content is bounded at ~4KB per concept in worker prompts (auto-truncated).",
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
        execute: async (_callId: unknown, input: unknown) => {
          const { requester, request, slackChannel, slackThread, budgetUsd, relevantConcepts } = input as {
            requester: string; request: string; slackChannel?: string; slackThread?: string; budgetUsd?: number;
            relevantConcepts?: Array<{ id: string; path?: string; summary?: string; tags?: string[]; content?: string }>;
          };
          if (!liveConfig().slack.authorised_users.includes(requester)) {
            return { content: [{ type: "text", text: `Requester ${requester} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
          }
          let cResult: Awaited<ReturnType<HarnessRuntime["crystallise"]>>;
          try {
            cResult = await liveRuntime().crystallise(request, relevantConcepts);
          } catch (err) {
            api.logger.error("[tool.run] crystallise failed", { requester, err: String(err) });
            return { content: [{ type: "text", text: `Crystallisation failed: ${String(err)}` }], details: { ok: false, crystalliseError: true } };
          }
          if (cResult.kind === "reject") {
            liveState().audit("tool.run.rejected", { requester, intent: cResult.intent, reason: cResult.reason });
            return { content: [{ type: "text", text: `Request rejected (${cResult.intent}): ${cResult.reason}` }], details: { ok: false, rejected: true, intent: cResult.intent, reason: cResult.reason } };
          }
          if (cResult.kind === "clarify") {
            return { content: [{ type: "text", text: `Needs clarification: ${cResult.question}` }], details: { ok: false, needsClarification: true, question: cResult.question } };
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
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_health",
        description:
          "Return a health snapshot: DB reachable, schema OK, config well-formed, model auth resolvable, credentials configured. For smoke tests + monitoring. Pass { deep: true } to also do a tiny live SDK ping that verifies the Anthropic key actually authenticates (costs a few tokens).",
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
        execute: async (_callId: unknown, input: unknown) => {
          const { deep } = (input ?? {}) as { deep?: boolean };
          const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

          // DB reachable?
          try {
            liveDb().prepare(`SELECT 1`).get();
            checks.push({ name: "db_reachable", ok: true });
          } catch (err) {
            checks.push({ name: "db_reachable", ok: false, detail: String(err) });
          }

          // Schema tables present?
          const need = ["sessions", "sub_tasks", "reviews", "budgets_daily", "budgets_monthly", "audit_log"];
          for (const t of need) {
            const row = liveDb()
              .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
              .get(t) as { name?: string } | undefined;
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
          let apiKey: string | undefined;
          try {
            const resolver = liveRuntime().anthropicApiKey;
            apiKey = typeof resolver === "function" ? await resolver() : undefined;
          } catch (err) {
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
            } else {
              try {
                const { runClassifierSdk } = await import("../adapters/claude-sdk.js");
                await runClassifierSdk({
                  model: liveConfig().models.classifier,
                  userText: "ping",
                  timeoutSeconds: 30,
                  apiKey,
                });
                checks.push({ name: "model_auth_live_ping", ok: true, detail: "SDK authenticated" });
              } catch (err) {
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
          let gitRes: { credentialService: string; provider: string; apiBase: string; apiKeyEnv: string } | undefined;
          let ghToken: string | undefined;
          try {
            const resFn = liveRuntime().gitResolutionFor;
            gitRes = typeof resFn === "function" ? resFn() : undefined;
            const tokFn = liveRuntime().gitToken;
            if (typeof tokFn === "function" && gitRes) {
              ghToken = await tokFn(gitRes);
            }
          } catch { /* resolution failed -> ghToken stays undefined */ }
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
            } else {
              try {
                const isGitlab = gitRes.provider === "gitlab";
                const url = isGitlab ? `${gitRes.apiBase}/user` : `${gitRes.apiBase}/user`;
                const headers: Record<string, string> = isGitlab
                  ? { "PRIVATE-TOKEN": ghToken, "User-Agent": "openclaw-agent-harness" }
                  : { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "User-Agent": "openclaw-agent-harness" };
                const resp = await fetch(url, { headers });
                if (resp.ok) {
                  const who = (await resp.json().catch(() => ({}))) as { login?: string; username?: string };
                  checks.push({ name: "git_credential_live_ping", ok: true, detail: `[${gitRes.provider}] authenticated as ${who.login ?? who.username ?? "(unknown)"}` });
                } else {
                  checks.push({ name: "git_credential_live_ping", ok: false, detail: `[${gitRes.provider}] API ${resp.status} ${resp.statusText}` });
                }
              } catch (err) {
                checks.push({ name: "git_credential_live_ping", ok: false, detail: `[${gitRes.provider}] ping failed (network): ${String(err).slice(0, 160)}` });
              }
            }
          }

          // Credentials: are we set to talk to Slack/Vercel? (informational, not fatal)
          checks.push({ name: "slack_credential_service_set", ok: !!liveConfig().slack.credential_service });
          checks.push({ name: "vercel_enabled", ok: !!liveConfig().vercel?.enabled });

          const overall = checks
            .filter(
              (c) =>
                c.name.startsWith("table_") ||
                c.name === "db_reachable" ||
                c.name.startsWith("config_") ||
                c.name === "model_auth_resolvable" ||
                c.name === "model_auth_live_ping" ||
                c.name === "git_credential_resolvable" ||
                c.name === "git_credential_live_ping",
            )
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
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_telemetry",
        description:
          "Return cost + activity telemetry: monthly ledger, session-level cost breakdown, model mix.",
        parameters: {
          type: "object",
          properties: {
            month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "YYYY-MM. Defaults to current month." },
            user: { type: "string", description: "Optional user id filter" },
          },
          additionalProperties: false,
        },
        execute: (_callId: unknown, input: unknown) => {
          const { month, user } = (input ?? {}) as { month?: string; user?: string };
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
            monthUsd: (monthlyRows as any[]).reduce((a, r: any) => a + (r.spent_usd || 0), 0),
            sessions: sessionRows.length,
            shipped: (sessionRows as any[]).filter((s: any) => s.status === "done").length,
            failed: (sessionRows as any[]).filter((s: any) => s.status === "failed").length,
            aborted: (sessionRows as any[]).filter((s: any) => s.status === "aborted").length,
            active: (sessionRows as any[]).filter((s: any) => !["done","failed","aborted","interrupted"].includes(s.status)).length,
          };
          return {
            content: [{ type: "text", text: JSON.stringify({ month: targetMonth, totals, monthly: monthlyRows, daily: dailyRows, sessions: sessionRows }, null, 2) }],
            details: { ok: true, month: targetMonth, totals },
          };
        },
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_resume",
        description:
          "Resume an interrupted harness session. Requires the session to be in 'interrupted' or 'resumable' state.",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string", minLength: 1 },
            invokedBy: { type: "string", minLength: 1, description: "Slack user id of the invoker. If provided, must be in slack.authorised_users." },
          },
          required: ["sessionId"],
          additionalProperties: false,
        },
        execute: async (_callId: unknown, input: unknown) => {
          const { sessionId, invokedBy } = input as { sessionId: string; invokedBy?: string };
          if (invokedBy && !liveConfig().slack.authorised_users.includes(invokedBy)) {
            return { content: [{ type: "text", text: `Invoker ${invokedBy} is not in slack.authorised_users` }], details: { ok: false, unauthorised: true } };
          }
          const row = liveDb().prepare(`SELECT status, crystallised_prompt FROM sessions WHERE id = ?`).get(sessionId) as { status: string; crystallised_prompt?: string } | undefined;
          if (!row) return { content: [{ type: "text", text: `No session ${sessionId}` }], details: { ok: false, notFound: true } };
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
      }),
    ),
  );

  // ---- harness_bootstrap_test_repo ----
  // Creates a fresh, disposable test repo under the requester's own GitHub
  // account, seeds it with a minimal README + docs/, and adds it to the LIVE
  // repos allow-list so a smoke test can target it immediately. This keeps
  // smoke tests off the harness's own source repo (branch clutter / accidental
  // PRs). The allow-list addition is IN-MEMORY only (not persisted to config);
  // it survives until the next plugin (re-)register.
  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_bootstrap_test_repo",
        description:
          "Create a fresh disposable test repo under the requester's GitHub account (seeded with README + docs/SMOKE.md) and add it to the live repos allow-list, for repeatable smoke tests. Does NOT persist to config. Params: { owner, name?, private?, requester? }.",
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
        execute: async (_callId: unknown, input: unknown) => {
          const p = (input ?? {}) as { owner?: string; name?: string; private?: boolean; requester?: string };
          if (!p.owner) {
            return { content: [{ type: "text", text: "owner is required" }], details: { ok: false, reason: "owner required" } };
          }
          const requester = p.requester ?? liveConfig().slack.authorised_users[0] ?? "unknown";
          const name = p.name ?? `oah-smoke-test-${Date.now()}`;
          const isPrivate = p.private !== false; // default private
          const repoFullName = `${p.owner}/${name}`;

          // Resolve a GitHub token (vault-first, env fallback) via the router.
          let token: string;
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
          } catch (err) {
            return { content: [{ type: "text", text: `Could not resolve a GitHub token for ${p.owner}: ${String(err)}` }], details: { ok: false, reason: "no_token" } };
          }

          const ghHeaders = {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "openclaw-agent-harness",
            "Content-Type": "application/json",
          };

          // 1) Who am I? Decide user-repo vs org-repo endpoint.
          let login: string | undefined;
          try {
            const who = await fetch("https://api.github.com/user", { headers: ghHeaders });
            if (who.ok) login = ((await who.json()) as { login?: string }).login;
          } catch { /* fall through; treat as org create */ }

          const createUrl =
            login && login.toLowerCase() === p.owner.toLowerCase()
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
          const created = (await createResp.json()) as { html_url?: string; default_branch?: string };
          const branch = created.default_branch ?? "main";

          // 3) Seed docs/SMOKE.md (README already exists from auto_init).
          const seed = async (path: string, content: string, message: string) => {
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
          const seededDocs = await seed(
            "docs/SMOKE.md",
            "# Smoke test target\n\nDisposable repo for openclaw-agent-harness smoke tests. Safe to delete.\n",
            "chore: seed docs/SMOKE.md for harness smoke tests",
          );

          // 4) Add to the LIVE allow-list (in-memory, not persisted).
          const allow = liveConfig().repos.allowed;
          if (!allow.includes(repoFullName)) allow.push(repoFullName);

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
      }),
    ),
  );

  return () => {
    for (const d of disposers) {
      try { d(); } catch { /* ignore */ }
    }
  };
}

function monthStart(yyyymm: string): number {
  const [y, m] = yyyymm.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, 1);
}
