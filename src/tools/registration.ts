/**
 * Runtime tool registration for openclaw-agent-harness.
 *
 * These are the tools OpenClaw exposes to callers (Slack users via
 * commands, other plugins, or cron jobs). They intentionally do NOT
 * include the "run a task" surface -- that entry point is the Slack
 * listener. These tools are for inspection, admin, and cron jobs.
 */

import type { HarnessPluginApi, HarnessRuntime } from "../index.js";
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

export function registerHarnessTools(api: HarnessPluginApi, runtime: HarnessRuntime): () => void {
  const disposers: Array<() => void> = [];

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_status",
        description:
          "Return harness runtime status: active sessions, monthly spend per user, model config.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () => {
          const sessions = runtime.state.db
            .prepare(
              `SELECT id, status, requester, repo, branch, cycles_ran, cost_usd,
                      datetime(created_at/1000,'unixepoch') AS created
               FROM sessions
               WHERE status NOT IN ('done','failed','aborted')
               ORDER BY created_at DESC`,
            )
            .all();
          const month = new Date().toISOString().slice(0, 7);
          const spend = runtime.state.db
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
                    models: runtime.config.models,
                    channel: runtime.config.slack.channel,
                    reposAllowed: runtime.config.repos.allowed,
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
        inputSchema: {
          type: "object",
          properties: {
            auditRetentionDays: { type: "number", minimum: 7, maximum: 3650 },
          },
          additionalProperties: false,
        },
        execute: (input) => {
          const opts = (input ?? {}) as { auditRetentionDays?: number };
          const result = pruneRetention(runtime.state, {
            auditRetentionDays:
              opts.auditRetentionDays ?? runtime.config.storage.audit_retention_days,
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
      }),
    ),
  );

  disposers.push(
    toDispose(
      api.registerTool({
        name: "harness_session_get",
        description: "Get full details of a harness session by id.",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string", minLength: 1 } },
          required: ["sessionId"],
          additionalProperties: false,
        },
        execute: (input) => {
          const { sessionId } = input as { sessionId: string };
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

  return () => {
    for (const d of disposers) {
      try { d(); } catch { /* ignore */ }
    }
  };
}
