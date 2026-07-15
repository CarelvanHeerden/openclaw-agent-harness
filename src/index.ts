/**
 * openclaw-agent-harness plugin entry.
 *
 * Exports the OpenClaw plugin descriptor. The runtime calls `register(api)`
 * once per lifecycle. We use that hook to:
 *   1. Parse plugin config (from OpenClaw config store)
 *   2. Open the state store (SQLite)
 *   3. Wire real subsystems (SDK, git, github, vercel, slack)
 *   4. Register runtime tools (harness_* namespace)
 *   5. Register Slack message hook (message.received)
 *   6. Register cron / service (retention prune, recovery, reaction poller)
 *
 * Shape mirrors memory-hybrid.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { HarnessConfig } from "./config.js";
import { parseHarnessConfig } from "./config.js";
import { openStateStore, openStateStoreSync } from "./state/store.js";
import { OrchestratorLoop } from "./orchestrator/loop.js";
import { SlackChannelListener, type SlackMessageEvent } from "./slack/channel-listener.js";
import { Dispatcher } from "./slack/dispatcher.js";
import { SlackReactionsReader } from "./slack/reactions.js";
import { ReactionsPoller } from "./slack/reactions-poller.js";
import { PrMergedWatcher } from "./adapters/github-watcher.js";
import { BudgetEnforcer } from "./budgets/enforcer.js";
import { PatRouter } from "./auth/pat-router.js";
import { pruneRetention } from "./state/retention.js";
import { registerHarnessTools } from "./tools/registration.js";
import { CredentialAdapter } from "./adapters/credentials.js";
import { GitAdapter } from "./adapters/git-worktree.js";
import { createPullRequest } from "./adapters/github.js";
import { SlackAdapter } from "./adapters/slack.js";
import {
  estimateSubTaskCost,
  extractJson,
  runAdversarySdk,
  runClassifierSdk,
  runCrystalliserSdk,
  runLeadSdk,
  runWorkerSdk,
} from "./adapters/claude-sdk.js";
import { fetchBranchLogs } from "./vercel/logs.js";
import { crystallisePrompt } from "./crystallise/prompt-refiner.js";
import { runLeadPlanner } from "./orchestrator/fable5-lead.js";
import { runWorker as runWorkerCore, buildWorkerSystemPrompt } from "./orchestrator/sonnet-worker.js";
import { runAdversary as runAdversaryCore } from "./orchestrator/fable5-adversary.js";
import { buildBashGuard } from "./safety/bash-guard.js";
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_VERSION } from "./version.js";

/** Minimal shape of the OpenClaw plugin API surface that we use. */
export interface HarnessPluginApi {
  registrationMode?: "cli-metadata" | "runtime";
  logger: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
    debug?: (msg: string, meta?: unknown) => void;
  };
  registerTool: (
    definition: {
      name: string;
      description: string;
      // OpenClaw plugin SDK uses `parameters` (JSON Schema). We also accept
      // the legacy `inputSchema` alias to keep older mock harnesses working.
      parameters?: unknown;
      inputSchema?: unknown;
      // OpenClaw SDK signature: (callId, params, context?). Older mocks used
      // (input, ctx?); we type broadly so both call shapes typecheck.
      execute: (callIdOrInput: unknown, paramsOrCtx?: unknown, context?: unknown) => Promise<unknown> | unknown;
    },
    options?: unknown,
  ) => (() => void) | { dispose?: () => void; unregister?: () => void };
  /**
   * Subscribe to a lifecycle event on the OpenClaw event bus. Same shape as
   * a Node EventEmitter; hybrid-memory uses this for `message_received`,
   * `agent_end`, etc. Returns an unsubscribe function.
   */
  on?: (event: string, handler: (payload: unknown) => unknown) => (() => void) | undefined;
  /**
   * Register a named hook on the OpenClaw plugin registry.
   *
   * SDK signature (verified against openclaw-hybrid-memory's copy of the
   * openclaw runtime, `registry-*.js`):
   *
   *     registerHook(events: string | string[], handler, opts: { name, description? })
   *
   * `opts.name` is required -- the registry throws
   * `hook registration missing name` otherwise. This is a different beast
   * from `api.on(event, handler)`, which is a simple event-bus subscribe.
   *
   * We type both positional shapes because older mocks still use the
   * 2-arg form; the runtime call site always passes opts.
   */
  registerHook?: (
    events: string | string[],
    handler: (event: unknown) => unknown,
    opts?: { name: string; description?: string },
  ) => (() => void) | { dispose?: () => void };
  registerService?: (svc: {
    id: string;
    start?: () => Promise<void> | void;
    stop?: () => Promise<void> | void;
  }) => (() => void) | { dispose?: () => void };
  /** Deprecated: retained for backwards-compat with older mock APIs. Prefer `pluginConfig`. */
  getConfig?: () => unknown;
  /** OpenClaw plugin-SDK config surface (JSON parsed from `plugins.entries[<id>].config`). */
  pluginConfig?: unknown;
  workspaceDir?: string;

  /** Optional -- for sending Slack messages. Different runtimes wire this differently. */
  sendMessage?: (input: { channel: string; threadTs?: string; text: string; blocks?: unknown[] }) => Promise<{ ts: string }>;
  addReaction?: (input: { channel: string; ts: string; name: string }) => Promise<void>;

  /** Optional -- lookup for calling another plugin's tool (e.g. hybrid-memory's credential_get). */
  callTool?: (name: string, input: unknown) => Promise<unknown>;
}

export interface HarnessRuntime {
  config: HarnessConfig;
  state: Awaited<ReturnType<typeof openStateStore>>;
  budget: BudgetEnforcer;
  pat: PatRouter;
  loop: OrchestratorLoop;
  listener: SlackChannelListener;
  dispatcher: Dispatcher;
  slack: SlackAdapter;
  git: GitAdapter;
  creds: CredentialAdapter;
  disposers: Array<() => void | Promise<void>>;
  /**
   * Promise for the async bootstrap phase (reactions poller start,
   * session recovery). Populated by `register()` once it has kicked off
   * `bootstrapHarnessAsync`. Teardown awaits this to ensure recovery
   * notifications have flushed before closing the state DB.
   */
  asyncBootstrap?: Promise<void>;
}

let currentRuntime: HarnessRuntime | null = null;

/**
 * Synchronous phase of plugin bootstrap.
 *
 * OpenClaw's plugin loader requires `register()` to be synchronous, so all
 * tool/hook/service registration must complete before we hand control back.
 * Anything that requires I/O that CAN be sync (SQLite via node:sqlite,
 * mkdirSync) runs here; anything that must be async (credential vault
 * fetches, Slack API calls, session recovery notifies) is deferred to
 * {@link bootstrapHarnessAsync}, which runs as a background promise the
 * runtime holds a reference to for teardown ordering.
 */
export function bootstrapHarnessSync(api: HarnessPluginApi): HarnessRuntime {
  // OpenClaw plugin SDK provides config via `api.pluginConfig`.
  // We fall back to `api.getConfig()` for backwards-compat with older mock harnesses.
  const rawConfig = (api.pluginConfig ?? api.getConfig?.() ?? {}) as unknown;
  const config = parseHarnessConfig(rawConfig);

  const dbPath = config.storage.state_db_path.replace(/^~/, process.env.HOME ?? "");
  mkdirSync(dirname(dbPath), { recursive: true });
  const state = openStateStoreSync(dbPath);

  const budget = new BudgetEnforcer(config.budgets, state);
  const pat = new PatRouter(config.pat_routing);

  const creds = new CredentialAdapter({
    logger: api.logger,
    callCredentialGetTool: async (input) => {
      if (!api.callTool) {
        return { error: "api.callTool not available; cannot read vault" };
      }
      try {
        const r = (await api.callTool("credential_get", input)) as { value?: string; error?: string };
        return r;
      } catch (err) {
        return { error: String(err) };
      }
    },
  });

  const git = new GitAdapter({
    worktreesRoot: config.storage.worktree_root,
    logger: api.logger,
  });

  const slack = new SlackAdapter({
    logger: api.logger,
    sendMessage: api.sendMessage ?? (async () => ({ ts: `${Date.now()}` })),
    addReaction: api.addReaction,
  });

  // ---- Orchestrator wiring ----
  const loop = new OrchestratorLoop({
    config,
    state,
    budget,
    pat,
    logger: api.logger,

    runLead: async (brief) => {
      const raw = await runLeadSdk({
        model: config.models.lead,
        brief,
        reposAllowed: config.repos.allowed,
        timeoutSeconds: config.loop.worker_timeout_seconds,
      });
      return runLeadPlanner(brief, {
        config,
        logger: api.logger,
        callLeadModel: async () => raw,
        allocateWorktree: async (repo, branch) => {
          const [owner] = repo.split("/");
          // Determine PAT + identity
          const resolution = pat.resolve({
            slackUserId: config.slack.authorised_users[0]!, // TODO: pass the actual requester
            gitHubUser: owner!,
            repoFullName: repo,
          });
          const ghToken = await creds.getToken(resolution.credentialService);
          return git.allocate({
            repoFullName: repo,
            baseBranch: config.repos.default_base_branch,
            sessionBranch: branch,
            sessionId: `pending-${Date.now()}`,
            ghToken,
            commitIdentity: resolution.commitIdentity,
          });
        },
        estimateCost: (p) => p.subTasks.reduce((acc, s) => acc + estimateSubTaskCost(config.models.worker, s.estimatedTokens), 0),
      });
    },

    runWorker: async ({ brief, subTask, plan, resumeSessionId }) => {
      const systemPrompt = buildWorkerSystemPrompt(brief, subTask);
      const canUseTool = buildBashGuard(config.safety);
      const resolution = pat.resolve({
        slackUserId: config.slack.authorised_users[0]!,
        gitHubUser: plan.repo.split("/")[0]!,
        repoFullName: plan.repo,
      });
      return runWorkerCore(
        plan.worktreePath,
        brief,
        subTask,
        resolution.commitIdentity,
        {
          config,
          logger: api.logger,
          buildCanUseTool: () => canUseTool,
          runWorkerModel: (params) => runWorkerSdk(params),
          gitBaseSha: (wt) => git.baseSha(wt),
          gitListChangedFiles: (wt, base) => git.listChangedFiles(wt, base),
          gitCommit: (wt, msg, id) => git.commit(wt, msg, id),
        },
        resumeSessionId,
      );
    },

    runAdversary: async ({ brief, plan, runtime }) => {
      const diffText = await git.diff(plan.worktreePath, config.repos.default_base_branch);
      const diffFile = resolve(config.storage.worktree_root.replace(/^~/, process.env.HOME ?? ""), `${Date.now()}.diff`);
      await mkdir(dirname(diffFile), { recursive: true });
      await writeFile(diffFile, diffText, "utf8");
      return runAdversaryCore(
        {
          crystallisedPrompt: brief.title,
          diffPath: diffFile,
          repoPath: plan.worktreePath,
          runtime,
          reviewChecklist: plan.reviewChecklist,
          model: config.models.adversary,
          timeoutSeconds: config.loop.adversary_timeout_seconds,
        },
        {
          logger: api.logger,
          readDiff: async (p) => (await readFile(p, "utf8")),
          callAdversaryModel: async (params) => {
            const r = await runAdversarySdk(params);
            return {
              parsed: {
                verdict: r.parsed.verdict,
                findings: (r.parsed.findings as any[]).map((f) => ({
                  dimension: f.dimension ?? "quality",
                  severity: f.severity ?? "low",
                  title: f.title ?? "(untitled)",
                  detail: f.detail ?? "",
                  file: f.file,
                  line: f.line,
                })),
                summary: r.parsed.summary,
              },
              sdkSessionId: r.sdkSessionId,
              costUsd: r.costUsd,
              tokensIn: r.tokensIn,
              tokensOut: r.tokensOut,
            };
          },
        },
      );
    },

    fetchRuntime: async ({ plan, sessionId }) => {
      // Prefer a manual upload if one exists (most recent wins). This lets
      // non-Vercel deploys hand-supply logs via the harness_upload_logs tool.
      const upload = state.db
        .prepare(
          `SELECT status, source, logs_excerpt, error_count, deployment_url, uploaded_at, uploaded_by
             FROM runtime_uploads
            WHERE session_id = ?
         ORDER BY uploaded_at DESC
            LIMIT 1`,
        )
        .get(sessionId) as
          | { status: string; source: string | null; logs_excerpt: string; error_count: number | null; deployment_url: string | null; uploaded_at: number; uploaded_by: string }
          | undefined;
      if (upload) {
        return {
          provider: "manual" as const,
          status: upload.status as "ok" | "build_failed" | "no_deploy_yet" | "unavailable",
          deploymentUrl: upload.deployment_url ?? undefined,
          logsExcerpt: upload.logs_excerpt,
          errorCount: upload.error_count ?? undefined,
          uploadedAt: upload.uploaded_at,
          uploadedBy: upload.uploaded_by,
          source: upload.source ?? undefined,
        };
      }
      // Otherwise fall back to Vercel bridge, only if explicitly enabled.
      if (!config.vercel?.enabled) return undefined;
      const token = await creds.getToken(config.vercel.credential_service);
      return fetchBranchLogs({
        vercelToken: token,
        teamId: config.vercel.team_id,
        projectId: config.vercel.project_id,
        branch: plan.branch,
        waitSeconds: config.vercel.preview_wait_seconds,
        logger: api.logger,
      });
    },

    pushBranchAndOpenPr: async ({ plan, brief, reviewReport }) => {
      const resolution = pat.resolve({
        slackUserId: config.slack.authorised_users[0]!,
        gitHubUser: plan.repo.split("/")[0]!,
        repoFullName: plan.repo,
      });
      const ghToken = await creds.getToken(resolution.credentialService);
      await git.pushBranch(plan.worktreePath, "origin", plan.branch, ghToken);
      const pr = await createPullRequest({
        repoFullName: plan.repo,
        head: plan.branch,
        base: config.repos.default_base_branch,
        title: `harness: ${brief.title}`,
        body: renderPrBody(brief, reviewReport),
        ghToken,
        draft: reviewReport.verdict !== "pass",
      });
      return pr.htmlUrl;
    },

    readReactions: async (sessionId) => {
      // Reactions are surfaced via a separate poller (see below) that writes
      // into sessions.reactions_json. Read from there.
      const row = state.db.prepare(`SELECT reactions_json FROM sessions WHERE id = ?`).get(sessionId) as { reactions_json?: string } | undefined;
      const parsed = row?.reactions_json ? JSON.parse(row.reactions_json) : {};
      return {
        shipIt: !!parsed.shipIt,
        abort: !!parsed.abort,
        pause: !!parsed.pause,
        budgetBump: !!parsed.budgetBump,
      };
    },

    reportProgress: async (sessionId, status, meta) => {
      const row = state.db.prepare(`SELECT slack_channel, slack_thread FROM sessions WHERE id = ?`).get(sessionId) as { slack_channel: string; slack_thread: string } | undefined;
      if (!row) return;
      const label = ({
        crystallising: ":brain: Crystallising…",
        planning: ":memo: Planning…",
        executing: `:hammer: Executing cycle ${(meta as any)?.cycle ?? 1}…`,
        reviewing: `:mag: Adversarial review of cycle ${(meta as any)?.cycle ?? 1}…`,
        done: ":tada: Done.",
        failed: ":x: Failed.",
        aborted: ":octagonal_sign: Aborted.",
      } as Record<string, string>)[status] ?? status;
      await slack.replyInThread(row.slack_channel, row.slack_thread, label).catch(() => {});
    },
  });

  const dispatcher = new Dispatcher({
    config,
    state,
    loop,
    logger: api.logger,
    crystallise: async (userText) => {
      const result = await crystallisePrompt(userText, {
        config,
        logger: api.logger,
        callClassifier: async () => runClassifierSdk({
          model: config.models.classifier,
          userText,
          timeoutSeconds: 60,
        }),
        callCrystalliser: async () => runCrystalliserSdk({
          model: config.models.lead,
          userText,
          timeoutSeconds: 120,
        }),
      });
      // crystallisePrompt returns a discriminated union; add cost=0 for now
      // (real cost is aggregated per-model call). Full cost tracking lives
      // in Phase D telemetry work.
      return result.kind === "brief"
        ? { kind: "brief", brief: result.brief, costUsd: 0 }
        : result.kind === "clarify"
          ? { kind: "clarify", question: result.question, costUsd: 0 }
          : { kind: "reject", intent: result.intent as "not_dev" | "unsafe", reason: result.reason ?? "", costUsd: 0 };
    },
    slackReply: (channel, threadTs, text) => slack.replyInThread(channel, threadTs, text),
    slackReact: (channel, ts, name) => slack.addReaction(channel, ts, name),
  });

  const listener = new SlackChannelListener({
    config,
    state,
    dispatcher,
    logger: api.logger,
  });

  const runtime: HarnessRuntime = {
    config, state, budget, pat, loop, listener, dispatcher, slack, git, creds,
    disposers: [],
  };

  // Tools (sync)
  const disposeTools = registerHarnessTools(api, runtime);
  runtime.disposers.push(disposeTools);

  // Subscribe to inbound Slack messages.
  //
  // The SDK exposes TWO distinct concepts here:
  //   * `api.on(event, handler)` -- lightweight event-bus subscribe, the
  //     path hybrid-memory uses for `message_received`. Returns an
  //     unsubscribe fn. This is what we want for reacting to inbound
  //     Slack messages.
  //   * `api.registerHook(events, handler, opts)` -- registers a NAMED,
  //     enumerable, first-class plugin hook (shows up in
  //     `openclaw plugins list ... hooks`). Requires `opts.name`.
  //
  // We prefer `api.on` (matches hybrid-memory's pattern for this exact
  // event) and fall back to `api.registerHook` with a proper `opts.name`
  // if only the latter is present. Older mock APIs may expose neither.
  //
  // Handler itself is async; only `register()` needs to be sync, which
  // this code is (we do NOT await api.on / api.registerHook here).
  const messageHandler = async (event: unknown) => {
    const slackEvt = event as { channel?: { provider?: string }; payload?: SlackMessageEvent } | undefined;
    if (!slackEvt?.payload) return;
    if (slackEvt.channel?.provider !== "slack") return;
    await listener.handle(slackEvt.payload);
  };

  if (typeof api.on === "function") {
    // Try the underscore form first (matches hybrid-memory / the openclaw
    // event bus), then the dotted form as a fallback for older builds.
    const disposeOn = api.on("message_received", messageHandler) ?? api.on("message.received", messageHandler);
    if (typeof disposeOn === "function") {
      runtime.disposers.push(disposeOn);
    }
  } else if (typeof api.registerHook === "function") {
    // Named hook path. `opts.name` is REQUIRED by the SDK registry --
    // omitting it triggers 'Error: hook registration missing name'.
    const dispose = api.registerHook(
      ["message_received", "message.received"],
      messageHandler,
      {
        name: `${PLUGIN_ID}:slack-message-listener`,
        description: "Forward inbound Slack messages to the harness channel listener",
      },
    );
    runtime.disposers.push(() => {
      if (typeof dispose === "function") dispose();
      else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
    });
  } else {
    api.logger.warn("[harness] neither api.on nor api.registerHook present; Slack listener will be idle.");
  }

  // Retention prune on service start (sync -- pruneRetention is a plain
  // SQL delete, no I/O beyond the DB).
  try {
    const r = pruneRetention(state, {
      auditRetentionDays: config.storage.audit_retention_days,
      pruneTerminalSessions: config.storage.prune_terminal_sessions,
      pruneTerminalSessionsDays: config.storage.prune_terminal_sessions_days,
    });
    api.logger.info("[harness] retention prune on start", r);
  } catch (err) {
    api.logger.warn("[harness] retention prune on start failed", { err: String(err) });
  }

  // PR-merged watcher (sync registration; start() runs async internally).
  {
    const watcher = new PrMergedWatcher(state, {
      logger: api.logger,
      intervalMs: 300_000,
      git,
      slackNotify: (ch, ts, text) => slack.replyInThread(ch, ts, text),
      resolveGhToken: async (repo, slackUserId) => {
        const [owner] = repo.split("/");
        const resolution = pat.resolve({
          slackUserId,
          gitHubUser: owner!,
          repoFullName: repo,
        });
        return creds.getToken(resolution.credentialService);
      },
    });
    if (api.registerService) {
      const dispose = api.registerService({
        id: `${PLUGIN_ID}:pr-watcher`,
        start: () => watcher.start(),
        stop: () => watcher.stop(),
      });
      runtime.disposers.push(async () => {
        await watcher.stop();
        if (typeof dispose === "function") dispose();
        else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
      });
    } else {
      // Fire-and-forget start; register() must return sync.
      // watcher.start() is idempotent, and stop() awaits any in-flight tick.
      void watcher.start().catch((err) => api.logger.warn("[harness] pr-watcher.start failed", { err: String(err) }));
      runtime.disposers.push(() => watcher.stop());
    }
  }

  // Nightly retention timer (24h). Uses api.registerService if available so
  // the runtime owns the lifecycle; else falls back to an in-process timer.
  {
    const dayMs = 24 * 60 * 60 * 1000;
    let timer: NodeJS.Timeout | undefined;
    const tick = () => {
      try {
        const r = pruneRetention(state, {
          auditRetentionDays: config.storage.audit_retention_days,
          pruneTerminalSessions: config.storage.prune_terminal_sessions,
          pruneTerminalSessionsDays: config.storage.prune_terminal_sessions_days,
        });
        api.logger.info("[harness] retention nightly prune", r);
      } catch (err) {
        api.logger.warn("[harness] retention nightly prune failed", { err: String(err) });
      }
    };
    if (api.registerService) {
      const dispose = api.registerService({
        id: `${PLUGIN_ID}:retention-nightly`,
        start: () => { timer = setInterval(tick, dayMs); },
        stop: () => { if (timer) clearInterval(timer); timer = undefined; },
      });
      runtime.disposers.push(async () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        if (typeof dispose === "function") dispose();
        else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
      });
    } else {
      timer = setInterval(tick, dayMs);
      runtime.disposers.push(() => { if (timer) clearInterval(timer); timer = undefined; });
    }
  }

  currentRuntime = runtime;
  return runtime;
}

/**
 * Asynchronous phase of plugin bootstrap. Runs as a fire-and-forget promise
 * after {@link bootstrapHarnessSync} has returned control to the OpenClaw
 * loader. Handles anything that requires network / vault I/O:
 *
 *   - fetching the Slack bot token from the credential vault and starting
 *     the reactions poller
 *   - session recovery (mark stale sessions as interrupted, notify Slack)
 *
 * The returned promise is stored on `runtime.asyncBootstrap` so teardown
 * can await it if it needs to (e.g. to ensure recovery notifies have
 * flushed before closing the state DB).
 */
export async function bootstrapHarnessAsync(runtime: HarnessRuntime, api: HarnessPluginApi): Promise<void> {
  const { config, state, creds, slack } = runtime;

  // Reactions poller (only if slack.credential_service is set so we have a bot token).
  if (config.slack.credential_service) {
    try {
      const slackToken = await creds.getToken(config.slack.credential_service);
      const reader = new SlackReactionsReader({
        config,
        state,
        slackToken,
        logger: api.logger,
      });
      const poller = new ReactionsPoller(state, reader, {
        intervalMs: config.slack.reactions_poll_ms ?? 15000,
        logger: api.logger,
      });
      if (api.registerService) {
        const dispose = api.registerService({
          id: `${PLUGIN_ID}:reactions-poller`,
          start: () => poller.start(),
          stop: () => poller.stop(),
        });
        runtime.disposers.push(async () => {
          await poller.stop();
          if (typeof dispose === "function") dispose();
          else if (dispose && "dispose" in dispose && typeof dispose.dispose === "function") dispose.dispose();
        });
      } else {
        await poller.start();
        runtime.disposers.push(() => poller.stop());
      }
    } catch (err) {
      api.logger.warn("[harness] reactions poller not started", { err: String(err) });
    }
  } else {
    api.logger.info("[harness] slack.credential_service not set; reactions poller idle");
  }

  // Session recovery: mark stale non-terminal sessions as 'interrupted' and
  // notify their Slack threads. Fresh in-flight sessions stay 'resumable'
  // (deliberately conservative -- see src/state/recovery.ts).
  try {
    const { recoverSessions } = await import("./state/recovery.js");
    const result = await recoverSessions(state, {
      staleAfterSeconds: config.loop.session_hard_timeout_seconds,
      logger: api.logger,
      notify: async (s) => {
        const msg = s.stale
          ? `:arrows_counterclockwise: This harness session was interrupted at cycle ${s.cycles_ran} (state \`${s.status}\`). React :arrows_counterclockwise: to resume, :x: to abort.`
          : `:arrows_counterclockwise: Harness restarted while this session was mid-flight (cycle ${s.cycles_ran}). Watching for signals.`;
        await slack.replyInThread(s.slack_channel, s.slack_thread, msg).catch((err) => {
          api.logger.warn("[harness] recovery notify failed", { err: String(err), sessionId: s.id });
        });
      },
    });
    if (result.interrupted + result.resumable > 0) {
      api.logger.warn(`[harness] recovery: ${result.interrupted} interrupted, ${result.resumable} resumable`);
    }
  } catch (err) {
    api.logger.warn("[harness] session recovery on start failed", { err: String(err) });
  }
}

/**
 * Backwards-compat facade. New code should prefer
 * `bootstrapHarnessSync` + `bootstrapHarnessAsync`. Tests still call this.
 */
export async function bootstrapHarness(api: HarnessPluginApi): Promise<HarnessRuntime> {
  const runtime = bootstrapHarnessSync(api);
  await bootstrapHarnessAsync(runtime, api);
  return runtime;
}

function renderPrBody(
  brief: { title: string; motivation: string; acceptanceCriteria: string[] },
  review: { verdict: string; findings: unknown[]; summary: string },
): string {
  return [
    `## Motivation`,
    brief.motivation,
    ``,
    `## Acceptance criteria`,
    ...brief.acceptanceCriteria.map((c) => `- [ ] ${c}`),
    ``,
    `## Adversarial review`,
    `Verdict: **${review.verdict}**`,
    ``,
    review.summary,
    ``,
    review.findings.length ? `### Findings (${review.findings.length})` : "",
    ...review.findings.map((f: any) => `- **${(f.severity ?? "info").toUpperCase()}** [${f.dimension}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n  ${f.detail}`),
    ``,
    `---`,
    `_Opened by openclaw-agent-harness ${PLUGIN_VERSION.pluginVersion}._`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function teardown(runtime: HarnessRuntime, api: HarnessPluginApi): Promise<void> {
  // Wait for the async bootstrap phase to complete before tearing things
  // down. Otherwise the reactions poller could try to start after we've
  // closed the DB, or recovery could try to notify after `slack` is gone.
  if (runtime.asyncBootstrap) {
    try {
      await runtime.asyncBootstrap;
    } catch (err) {
      api.logger.warn("[harness] async bootstrap rejected during teardown", { err: String(err) });
    }
  }
  for (const d of runtime.disposers.reverse()) {
    try {
      await d();
    } catch (err) {
      api.logger.warn("[harness] disposer failed", { err: String(err) });
    }
  }
  try {
    runtime.state.close();
  } catch (err) {
    api.logger.warn("[harness] state.close failed", { err: String(err) });
  }
  runtime.creds.purge();
}

// OpenClaw plugin entry.
//
// The runtime loader calls `definePluginEntry()`-wrapped exports; the raw
// object form is not recognised. We import from the SDK subpath.
// See docs/plugins/sdk-entrypoints.md.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - types are provided by the host OpenClaw runtime at install time
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  versionInfo: PLUGIN_VERSION,
  /**
   * OpenClaw plugin loader requires `register()` to be SYNCHRONOUS.
   *
   * Returning a Promise (i.e. declaring this as `async`) causes the
   * gateway to reject the plugin with:
   *
   *   Error: plugin register must be synchronous
   *
   * We therefore do all sync setup (config parse, DB open, tool/hook/
   * service registration) inline in this call, and kick off the async
   * phase (Slack token fetch, reactions poller, session recovery) as
   * a fire-and-forget promise stored on `runtime.asyncBootstrap`.
   * Teardown awaits that promise so nothing runs on a closed DB.
   *
   * This mirrors the pattern used by openclaw-hybrid-memory and other
   * reference plugins.
   */
  register(api: unknown): void {
    // Bridge the OpenClaw SDK API to our internal HarnessPluginApi shape.
    // The SDK exposes a superset of what we consume; the fields we use
    // (`logger`, `registerTool`, `registerHook`, `registerService`,
    // `pluginConfig`, `workspaceDir`, `sendMessage`, `addReaction`,
    // `callTool`) are all present on the runtime `api` object.
    const pluginApi = api as HarnessPluginApi;
    if (pluginApi.registrationMode === "cli-metadata") {
      pluginApi.logger.info("[harness] cli-metadata registration");
      return;
    }
    if (currentRuntime) {
      pluginApi.logger.info("[harness] re-registering; scheduling teardown of previous runtime");
      const doomed = currentRuntime;
      currentRuntime = null;
      // Fire-and-forget: we can't await teardown here without violating the
      // sync-register contract. teardown() awaits doomed.asyncBootstrap so
      // it doesn't tear down mid-bootstrap.
      void teardown(doomed, pluginApi).catch((err) => {
        pluginApi.logger.warn("[harness] previous-runtime teardown failed", { err: String(err) });
      });
    }
    let runtime: HarnessRuntime;
    try {
      runtime = bootstrapHarnessSync(pluginApi);
    } catch (err) {
      pluginApi.logger.error("[harness] sync bootstrap failed", { err: String(err) });
      throw err;
    }
    // Kick off async bootstrap; do NOT await. Store the promise so teardown
    // can await it before closing the DB.
    runtime.asyncBootstrap = bootstrapHarnessAsync(runtime, pluginApi).then(
      () => pluginApi.logger.info(`[harness] ${PLUGIN_ID}@${PLUGIN_VERSION.pluginVersion} async bootstrap complete`),
      (err) => {
        pluginApi.logger.error("[harness] async bootstrap failed", { err: String(err) });
      },
    );
    pluginApi.logger.info(`[harness] ${PLUGIN_ID}@${PLUGIN_VERSION.pluginVersion} registered (async bootstrap in flight)`);
  },
});
