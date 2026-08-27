/**
 * ACP worker backend.
 *
 * Speaks the Agent Client Protocol over stdio to an external dev harness
 * (OpenCode, Codex, Claude Code, ...) and presents the result through the same
 * `WorkerDeps.runWorkerModel` contract the Claude Code SDK path already
 * satisfies. Nothing in the orchestrator, verifier, adversary or budget layer
 * changes; only which function is injected at the seam.
 *
 * We speak ACP directly rather than going through OpenClaw's acpx bridge
 * ("Option B"). The bridge is documented as surfacing usage as approximate and
 * carrying no cost data, and it abstracts away both the permission
 * request/response pair and the per-agent rawInput shapes -- all three of which
 * we need. See docs/acp-capability-matrix.md for the measurements behind this.
 *
 * Transport is newline-delimited JSON-RPC 2.0, per the ACP stdio binding.
 *
 * KNOWN LIMITS, measured rather than assumed:
 *   - Usage arrives in TWO places and they carry different things. The
 *     `usage_update` notification carries context occupancy (`used`, `size`)
 *     and a cumulative `cost`; the `session/prompt` RESULT carries the token
 *     split. An earlier revision of this file read only the notification and
 *     concluded ACP had no token split at all — see `recordPromptUsage`.
 *   - `cost` is cumulative per session and optional. We delta it across the
 *     turn; agents that report neither cost nor tokens yield usageSource
 *     "unavailable", which the ledger must not read as zero spend.
 *   - Permission enforcement depends on the BACKEND's own config. An agent not
 *     configured to ask never sends session/request_permission and the guard
 *     never runs. `preflightAcpBackend()` exists to make that a startup failure
 *     rather than a silent hole.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AcpToolCallForGuard } from "../safety/bash-guard.js";
import { redactSecrets } from "./git-worktree.js";
import { buildAgentEnv } from "./shared/env.js";
import { runStructuredLadder } from "./shared/structured.js";
import type { JsonValidationOptions } from "./shared/json.js";
import type { BackendCapabilities } from "./backend.js";
import { assessOpenCodeVersion, type VersionAssessment } from "./opencode-version.js";

/** ACP stop reasons, per the v1 spec. */
type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** The harness-side stop reasons the worker contract expects. */
export type WorkerStopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_error"
  | "timeout"
  | "canceled"
  | "first_token_timeout";

/**
 * `max_turn_requests` and `refusal` have no harness equivalent. Both mean the
 * turn ended without finishing the work, which is what `tool_error` signals to
 * the retry logic. The raw reason is preserved in logsExcerpt for the audit.
 */
const STOP_REASON_MAP: Record<AcpStopReason, WorkerStopReason> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  cancelled: "canceled",
  refusal: "tool_error",
  max_turn_requests: "tool_error",
};

/**
 * The `usage` object on a `session/prompt` result.
 *
 * Every field optional, and the cache fields spelled several ways, because
 * agents disagree: the captured OpenCode sessions use `cachedWriteTokens`,
 * while other implementations use `cacheReadTokens`/`cacheWriteTokens`. Reading
 * all of them is cheaper than being wrong about which one arrived.
 */
export interface AcpPromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedWriteTokens?: number;
  cachedReadTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AcpAgentSpec {
  /** Executable to launch, e.g. "npx" or an absolute path to a baked-in binary. */
  command: string;
  args: string[];
  /** Extra environment for the child, merged over the inherited env. */
  env?: Record<string, string>;
  /**
   * M9: called when the launched agent's version is not the pinned one.
   *
   * A callback rather than a hard failure. The caller decides what to do with
   * it — audit it, surface it, ignore it — because the SAFETY question is
   * answered by the startup permission probe, which observes behaviour rather
   * than trusting a version string. This is the diagnostic that makes an
   * incident answerable without a reproduction.
   */
  onVersionMismatch?: (info: VersionAssessment & { agentName?: string }) => void;
}

export interface RunWorkerAcpParams {
  agent: AcpAgentSpec;
  worktreePath: string;
  systemPrompt: string;
  userMessage: string;
  model: string;
  resumeSessionId?: string;
  timeoutSeconds: number;
  streamOpenTimeoutSeconds?: number;
  firstTokenTimeoutSeconds?: number;
  streamIdleWarnSeconds?: number;
  onStreamSlow?: (info: { idleMs: number; elapsedMs: number; tokensOut: number; label: string }) => void;
  /**
   * REQUIRED, and deliberately not the SDK-shaped `canUseTool` from
   * WorkerDeps. That callback keys on Claude Code tool names and would fall
   * through to allow for every ACP call. Taking an ACP-shaped guard as a
   * required parameter makes the unsafe wiring impossible to express.
   * Build it with `buildAcpGuard()`.
   */
  acpGuard: (call: AcpToolCallForGuard) => Promise<{ allow: boolean; reason?: string }>;
  /** Redacted from logs and error text when present. */
  secretToken?: string;
  logger?: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}

export interface RunWorkerAcpResult {
  sdkSessionId: string;
  stopReason: WorkerStopReason;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  logsExcerpt: string;
  finalMessage: string;
  streamOpened: boolean;
  msToFirstToken?: number;
  /** Cache tokens, when the agent reported a split. Priced separately in M8. */
  tokensCached?: number;
  /**
   * How to read costUsd / tokensIn / tokensOut.
   *
   * "acp-delta"    — costUsd is a real delta of the agent's cumulative figure.
   * "tokens-only"  — a token split arrived but no cost, which is what a local
   *                  or self-hosted provider looks like: there is no invoice,
   *                  so `costUsd: 0` is TRUE rather than unknown, and the
   *                  tokens are the usage signal.
   * "unavailable"  — the agent reported neither. The ledger has a hole here and
   *                  must say so rather than record a measured zero.
   */
  usageSource: "acp-delta" | "tokens-only" | "unavailable";
  /** Context-window occupancy, the only token signal ACP actually carries. */
  contextUsed?: number;
  contextSize?: number;
  /** Denials the guard issued this turn. Surfaced for the audit trail. */
  deniedToolCalls: Array<{ kind?: string | null; reason?: string }>;
}

const LOG_EXCERPT_MAX = 20_000;

/**
 * Thrown when the agent asks us to perform something we declined in
 * `initialize`.
 *
 * Its own type so the connection can answer with `-32601 method not found`
 * rather than a generic internal error — the agent then knows the capability
 * is absent, not that we broke, and falls back to its own tooling instead of
 * retrying.
 */
export class AcpClientCapabilityError extends Error {
  constructor(readonly method: string) {
    super(`client capability not offered: ${method}`);
    this.name = "AcpClientCapabilityError";
  }
}

/** Minimal ndjson JSON-RPC 2.0 peer over a child process's stdio. */
class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onRequest: (method: string, params: unknown) => Promise<unknown>,
    private readonly onNotify: (method: string, params: unknown) => void,
  ) {
    child.stdout.on("data", (c: Buffer) => this.ingest(c.toString()));
    // v2.0.0: a spawn failure -- a mistyped command, a binary that is not
    // installed -- arrives as an asynchronous `error` event, NOT as a throw
    // from `spawn()`. Unhandled, it is an uncaught exception that takes the
    // whole harness process down rather than failing one turn. The M6 probe
    // found this by trying to launch a binary that does not exist, which is
    // exactly what a misconfigured `worker_backend` looks like in production.
    child.on("error", (err: Error) => {
      this.closed = true;
      this.spawnError = err;
      const wrapped = new Error(`acp agent could not be started: ${err.message}`);
      this.closeError = wrapped;
      for (const [, p] of this.pending) p.reject(wrapped);
      this.pending.clear();
    });
    child.stdin.on("error", () => {
      // The child died between our checking and our writing. `exit`/`error`
      // above own the rejection; this only stops an EPIPE from escaping.
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      const err = this.spawnError
        ? new Error(`acp agent could not be started: ${this.spawnError.message}`)
        : new Error(`acp agent exited (code=${code} signal=${signal})`);
      this.closeError = err;
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  private spawnError?: Error;

  /**
   * Why the connection closed, retained after the handlers have run.
   *
   * The handlers fire ONCE and reject whatever was pending at that moment. A
   * request issued afterwards used to register itself into a map nobody would
   * ever drain again -- see `request()`.
   */
  private closeError?: Error;

  private ingest(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-JSON noise on stdout is not fatal
      }
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: Record<string, unknown>): Promise<void> {
    const id = msg["id"] as number | undefined;
    // Response to something we sent.
    if (id !== undefined && (("result" in msg) || ("error" in msg))) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if ("error" in msg) {
        const e = msg["error"] as { message?: string } | undefined;
        p.reject(new Error(e?.message ?? "acp rpc error"));
      } else {
        p.resolve(msg["result"]);
      }
      return;
    }
    const method = msg["method"] as string | undefined;
    if (!method) return;
    // Request from the agent: must be answered or the agent blocks forever.
    if (id !== undefined) {
      let result: unknown;
      try {
        result = await this.onRequest(method, msg["params"]);
      } catch (err) {
        // A handler that throws must produce a JSON-RPC ERROR, not an empty
        // success. Collapsing every failure into `{}` told the agent its
        // request had succeeded — which for `fs/write_text_file` meant a
        // worker's edits vanished while it went on to report the sub-task
        // done. An error is answerable: the agent falls back to its own
        // tooling, which routes through the guard.
        const capability = err instanceof AcpClientCapabilityError;
        this.write({
          jsonrpc: "2.0",
          id,
          error: {
            // -32601 "method not found" is the honest code for a capability we
            // explicitly declined in `initialize`.
            code: capability ? -32601 : -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return;
      }
      this.write({ jsonrpc: "2.0", id, result });
      return;
    }
    this.onNotify(method, msg["params"]);
  }

  private write(obj: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      /* agent already gone; pending requests reject via the exit handler */
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    // Reject a request made AFTER the connection closed, rather than waiting
    // for a reply that cannot come.
    //
    // `error` and `exit` fire once and drain whatever is pending at that
    // instant. Anything registered afterwards sat in the map forever: `write`
    // is a silent no-op once closed, so the call simply never settled and the
    // turn hung until `subtask_deadline_seconds` force-failed the whole
    // sub-task, minutes later, with a timeout that named the wrong cause.
    //
    // The window is small but entirely reachable -- a child that dies between
    // `initialize` resolving and `session/new` being sent is the ordinary
    // shape of a crash on startup, which is exactly when a misconfigured
    // backend fails.
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error(`acp agent connection is closed; '${method}' cannot be sent`),
      );
    }
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return p;
  }
}

/**
 * Runs one worker turn against an ACP backend.
 *
 * Watchdogs stay harness-side, exactly as they do for the SDK path: ACP has no
 * notion of "the stream failed to open", so phase-1 (launch -> first update),
 * phase-2 (first update -> first token) and the overall turn timeout are all
 * enforced here by aborting the child.
 */
export async function runWorkerAcp(params: RunWorkerAcpParams): Promise<RunWorkerAcpResult> {
  const {
    agent,
    worktreePath,
    systemPrompt,
    userMessage,
    model,
    resumeSessionId,
    timeoutSeconds,
    streamOpenTimeoutSeconds = 120,
    firstTokenTimeoutSeconds = 30,
    streamIdleWarnSeconds = 90,
    onStreamSlow,
    acpGuard,
    secretToken,
    logger,
  } = params;

  const startedAt = Date.now();
  const logs: string[] = [];
  const denied: Array<{ kind?: string | null; reason?: string }> = [];
  let finalMessage = "";
  let streamOpened = false;
  let msToFirstToken: number | undefined;
  let lastActivityAt = Date.now();
  let sessionId = "";
  let costBaseline: number | null = null;
  let costLatest: number | null = null;
  let contextUsed: number | undefined;
  let contextSize: number | undefined;
  let sawAnyCost = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  let sawTokenSplit = false;

  const recordPromptUsage = (u: AcpPromptUsage): void => {
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    // Only claim a split when the agent actually sent one. An agent that omits
    // `usage` must leave `sawTokenSplit` false so `usageSource` reports the gap
    // rather than a measured zero.
    if (u.inputTokens === undefined && u.outputTokens === undefined) return;
    sawTokenSplit = true;
    tokensIn = n(u.inputTokens);
    tokensOut = n(u.outputTokens);
    // Cache reads and writes are billed differently by every provider that has
    // them, so they are kept separate rather than folded into tokensIn. M8 is
    // where that becomes a price; here it is only recorded.
    tokensCached = n(u.cachedWriteTokens) + n(u.cachedReadTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens);
  };

  const scrub = (s: string): string => (secretToken ? redactSecrets(s, secretToken) : s);
  const pushLog = (s: string): void => {
    if (logs.length < 400) logs.push(scrub(s));
  };

  const child = spawn(agent.command, agent.args, {
    cwd: worktreePath,
    stdio: ["pipe", "pipe", "pipe"],
    // v2.0.0 (P0): this was `{ ...process.env, ... }`, which handed the agent
    // every secret the harness holds -- the vault key, the GitHub PAT, the
    // Slack tokens. The SDK path has filtered its child since beta.57 and the
    // vault key specifically since beta.110; this path was new and simply did
    // not know. That is exactly the drift `shared/env.ts` exists to stop, and
    // it is why the filter is shared rather than copied.
    //
    // `agent.env` is applied AFTER the filter and is the only route in for
    // anything sensitive -- see M6, where the OpenCode configuration arrives as
    // OPENCODE_CONFIG_CONTENT and may carry provider keys.
    env: buildAgentEnv({ NO_COLOR: "1", ...(agent.env ?? {}) }),
    // The child is a process GROUP leader so the whole tree can be signalled.
    // See `reap`.
    detached: true,
  }) as ChildProcessWithoutNullStreams;

  const stderrParts: string[] = [];
  child.stderr.on("data", (d: Buffer) => {
    if (stderrParts.length < 100) stderrParts.push(d.toString());
  });

  /**
   * Single place that ends the agent, so no path can leak a process.
   *
   * v2.0.0: signals the process GROUP, not just the child. `opencode` is a node
   * wrapper that spawns its own children -- the provider client, any MCP
   * servers it is configured with -- and SIGTERM to the wrapper alone leaves
   * those orphaned. On a long-running harness that is a slow leak of processes
   * holding a worktree open, and on a timeout it means the turn we just
   * abandoned keeps talking to the model and keeps spending.
   *
   * The child is spawned `detached`, which makes it a group leader, so
   * `kill(-pid)` reaches the whole tree. `child.kill()` remains as the fallback
   * for the case where the group is already gone or the platform refuses the
   * negative pid.
   */
  let reaped = false;
  const signalGroup = (sig: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      // Negative pid = "every process in this group".
      process.kill(-pid, sig);
    } catch {
      // No group (spawn failed, or already reaped): fall back to the child.
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  const reap = (): void => {
    if (reaped) return;
    reaped = true;
    signalGroup("SIGTERM");
    // Escalate if it ignores SIGTERM; unref so we never hold the event loop.
    const t = setTimeout(() => signalGroup("SIGKILL"), 5_000);
    t.unref?.();
  };

  let abortReason: WorkerStopReason | null = null;
  const timers: NodeJS.Timeout[] = [];
  const arm = (ms: number, fn: () => void): void => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    timers.push(t);
  };

  // Phase 1: launched but never produced a single session/update.
  arm(streamOpenTimeoutSeconds * 1000, () => {
    if (!streamOpened) {
      abortReason = "first_token_timeout";
      pushLog(`[acp] stream-open watchdog fired after ${streamOpenTimeoutSeconds}s`);
      reap();
    }
  });
  // Overall turn budget.
  arm(timeoutSeconds * 1000, () => {
    abortReason = "timeout";
    pushLog(`[acp] turn timeout after ${timeoutSeconds}s`);
    reap();
  });

  const markActivity = (): void => {
    lastActivityAt = Date.now();
    if (!streamOpened) {
      streamOpened = true;
      // Phase 2 only becomes meaningful once the stream is actually open.
      arm(firstTokenTimeoutSeconds * 1000, () => {
        if (msToFirstToken === undefined) {
          abortReason = "first_token_timeout";
          pushLog(`[acp] first-token watchdog fired after ${firstTokenTimeoutSeconds}s`);
          reap();
        }
      });
    }
  };

  // Liveness only; never aborts, matching the SDK path's stream-slow semantics.
  if (onStreamSlow) {
    const iv = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs >= streamIdleWarnSeconds * 1000) {
        onStreamSlow({ idleMs, elapsedMs: Date.now() - startedAt, tokensOut: 0, label: "acp" });
      }
    }, 15_000);
    iv.unref?.();
    timers.push(iv as unknown as NodeJS.Timeout);
  }

  const handleUpdate = (update: Record<string, unknown>): void => {
    const kind = update["sessionUpdate"] as string | undefined;
    markActivity();
    switch (kind) {
      case "agent_message_chunk":
      case "agent_message": {
        if (msToFirstToken === undefined) msToFirstToken = Date.now() - startedAt;
        const text = extractText(update);
        if (text) {
          finalMessage += text;
          pushLog(text);
        }
        break;
      }
      case "agent_thought_chunk":
        if (msToFirstToken === undefined) msToFirstToken = Date.now() - startedAt;
        break;
      case "usage_update": {
        const used = update["used"];
        const size = update["size"];
        if (typeof used === "number") contextUsed = used;
        if (typeof size === "number") contextSize = size;
        const cost = update["cost"] as { amount?: number } | null | undefined;
        if (cost && typeof cost.amount === "number") {
          sawAnyCost = true;
          // Cumulative per session, so the first figure is this turn's baseline.
          if (costBaseline === null) costBaseline = cost.amount;
          costLatest = cost.amount;
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const title = update["title"];
        if (typeof title === "string" && title.length > 0) pushLog(`[tool:${String(update["kind"] ?? "?")}] ${title}`);
        break;
      }
      default:
        break;
    }
  };

  const conn = new AcpConnection(
    child,
    async (method, rpcParams) => {
      if (method === "session/request_permission") {
        const p = rpcParams as { toolCall?: AcpToolCallForGuard; options?: Array<{ optionId?: string; kind?: string }> };
        const call = p?.toolCall ?? {};
        const options = p?.options ?? [];
        const verdict = await acpGuard(call);
        if (!verdict.allow) {
          denied.push({ kind: call.kind, reason: verdict.reason });
          pushLog(`[guard] DENIED ${String(call.kind)}: ${verdict.reason ?? "no reason"}`);
          const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
          // No reject option offered is itself a denial we cannot honour; the
          // cancelled outcome is the only safe fallback.
          return reject?.optionId
            ? { outcome: { outcome: "selected", optionId: reject.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }
        const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
        return { outcome: { outcome: "selected", optionId: allow?.optionId } };
      }
      // We advertise `fs: {readTextFile: false, writeTextFile: false}`, so
      // neither of these should arrive. The captured OpenCode 1.18.11 sessions
      // in `probe/runs/` show it sending `fs/write_text_file` regardless, right
      // after the `session/request_permission` for the same edit — it asks us
      // for approval, then asks us to perform the write.
      //
      // Answering must not deadlock the agent, but it must also not LIE. The
      // previous `return {}` read as success on a write that never happened,
      // so a worker delegating its edits to the client silently lost all of
      // them and then reported the sub-task complete. An error is the honest
      // answer and it is also the useful one: the agent falls back to its own
      // file tooling, which routes through `bash`/`edit` and therefore through
      // the permission round-trip and the guard.
      if (method === "fs/write_text_file") {
        const p = rpcParams as { path?: string };
        pushLog(`[acp] refused client-side write to ${String(p?.path ?? "?")}: fs capability is not offered`);
        throw new AcpClientCapabilityError("fs/write_text_file");
      }
      if (method === "fs/read_text_file") {
        throw new AcpClientCapabilityError("fs/read_text_file");
      }
      return {};
    },
    (method, notifyParams) => {
      if (method !== "session/update") return;
      const p = notifyParams as { update?: Record<string, unknown> };
      if (p?.update) handleUpdate(p.update);
    },
  );

  let stopReason: WorkerStopReason = "tool_error";
  try {
    const initResult = (await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })) as { agentInfo?: { name?: string; version?: string } } | undefined;

    // M9: record what actually launched. Warn-on-mismatch rather than refuse —
    // the startup permission probe is the safety gate, this is the diagnostic
    // that answers "what were you running?" without a reproduction.
    const agentVersion = initResult?.agentInfo?.version;
    const versionCheck = assessOpenCodeVersion(agentVersion);
    if (versionCheck.warn) {
      pushLog(`[acp] version: ${versionCheck.message ?? "mismatch"}`);
      agent.onVersionMismatch?.({
        agentName: initResult?.agentInfo?.name,
        ...versionCheck,
      });
    }

    if (resumeSessionId) {
      try {
        await conn.request("session/load", { sessionId: resumeSessionId, cwd: worktreePath, mcpServers: [] });
        sessionId = resumeSessionId;
      } catch (err) {
        // session/load is optional in the spec and unsupported by some agents.
        // A fresh session plus the dispatch hint is the documented fallback.
        pushLog(`[acp] session/load failed, starting fresh: ${scrub(String(err))}`);
      }
    }
    if (!sessionId) {
      const created = await conn.request<{ sessionId?: string }>("session/new", {
        cwd: worktreePath,
        mcpServers: [],
      });
      sessionId = created?.sessionId ?? "";
    }

    // Only some agents advertise model selection over ACP (Claude Code does,
    // OpenCode does not). Failure is non-fatal: the backend's own config then
    // owns the model choice.
    if (model) {
      try {
        await conn.request("session/set_model", { sessionId, modelId: model });
      } catch {
        pushLog(`[acp] session/set_model unsupported; backend config owns the model`);
      }
    }

    const res = await conn.request<{ stopReason?: AcpStopReason; usage?: AcpPromptUsage }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `${systemPrompt}\n\n---\n\n${userMessage}` }],
    });
    // v2.0.0: the token split lives on the session/prompt RESULT, not on the
    // usage_update notification. The original matrix recorded "ACP carries no
    // input/output token split" from reading only the notification, which
    // carries context occupancy (`used`/`size`) and cost. The captured probe
    // sessions in probe/runs show the result frame carrying
    // `{inputTokens, outputTokens, totalTokens, cachedWriteTokens}` -- so the
    // split was there all along and the harness was throwing it away.
    //
    // This matters beyond tidiness: a local provider reports no cost at all, so
    // tokens are the ONLY usage signal the budget enforcer will have.
    if (res?.usage) recordPromptUsage(res.usage);
    stopReason = STOP_REASON_MAP[res?.stopReason ?? "end_turn"] ?? "tool_error";
    if (res?.stopReason && STOP_REASON_MAP[res.stopReason] === "tool_error") {
      pushLog(`[acp] raw stopReason=${res.stopReason}`);
    }
  } catch (err) {
    // A watchdog that killed the child surfaces here as a transport error; the
    // watchdog's own classification wins.
    stopReason = abortReason ?? "tool_error";
    pushLog(`[acp] ${scrub(String(err))}`);
  } finally {
    for (const t of timers) clearTimeout(t as NodeJS.Timeout);
    reap();
  }
  if (abortReason) stopReason = abortReason;

  if (stderrParts.length > 0) pushLog(`[acp stderr] ${scrub(stderrParts.join("").slice(-2000))}`);

  const costUsd = costBaseline !== null && costLatest !== null ? Math.max(0, costLatest - costBaseline) : 0;

  // Computed once and shared with the return below. These were two separate
  // expressions, and the logged one ignored `sawTokenSplit` -- so an agent that
  // reported tokens but no cost (OpenCode against a custom provider does
  // exactly this) was priced correctly off the catalogue while the log claimed
  // `unavailable`. The operator-visible signal said the cost path was broken at
  // the moment it was working, which is the most expensive kind of wrong.
  const usageSource = acpUsageSource(sawAnyCost, sawTokenSplit);

  logger?.info("[acp] worker turn finished", {
    stopReason,
    sessionId,
    denied: denied.length,
    usageSource,
  });

  return {
    sdkSessionId: sessionId,
    stopReason,
    costUsd,
    // Real counts when the agent sent a split; 0 with `usageSource` saying so
    // when it did not. A consumer must always be able to tell "not measured"
    // from "free" -- that distinction is the whole reason usageSource exists.
    tokensIn,
    tokensOut,
    tokensCached: sawTokenSplit ? tokensCached : undefined,
    logsExcerpt: logs.join("").slice(-LOG_EXCERPT_MAX),
    finalMessage: finalMessage.trim(),
    streamOpened,
    msToFirstToken,
    usageSource,
    contextUsed,
    contextSize,
    deniedToolCalls: denied,
  };
}

/**
 * How to read the usage numbers on a result.
 *
 * Three states, because the two signals arrive independently: a hosted provider
 * sends both cost and tokens, a local endpoint sends tokens but has no invoice
 * to report, and an agent that sends neither leaves the ledger with a hole that
 * must not be recorded as zero spend.
 */
export function acpUsageSource(sawCost: boolean, sawTokens: boolean): RunWorkerAcpResult["usageSource"] {
  if (sawCost && sawTokens) return "acp-delta";
  if (sawTokens) return "tokens-only";
  if (sawCost) return "acp-delta";
  return "unavailable";
}

/** Pulls display text out of the several content shapes ACP allows. */
function extractText(update: Record<string, unknown>): string {
  const direct = update["text"];
  if (typeof direct === "string") return direct;
  const content = update["content"];
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const t = (content as Record<string, unknown>)["text"];
    if (typeof t === "string") return t;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? ((c as Record<string, unknown>)["text"] ?? "") : ""))
      .filter((s): s is string => typeof s === "string")
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// The structured shape: the six tool-less roles over ACP
// ---------------------------------------------------------------------------

export interface RunStructuredAcpParams<T> {
  agent: AcpAgentSpec;
  /** Which role is asking. Drives the ladder's messages and its exhaustion policy. */
  role: string;
  /** A scratch directory. ACP requires a `cwd` even for a turn that touches nothing. */
  cwd: string;
  systemPrompt: string;
  userMessage: string;
  model: string;
  timeoutSeconds: number;
  streamOpenTimeoutSeconds?: number;
  validation: JsonValidationOptions<T>;
  maxAttempts?: number;
  secretToken?: string;
  logger?: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}

export interface RunStructuredAcpResult<T> {
  parsed: T;
  sdkSessionId: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  usageSource: RunWorkerAcpResult["usageSource"];
  /** True when the document was recovered from a truncated reply. */
  repaired: boolean;
}

/**
 * Run one of the six tool-less roles over ACP.
 *
 * These roles take one prompt and return one JSON document. They are not
 * agents: giving them tools does not merely waste a turn, it changes what they
 * emit — beta.28 and beta.40 both traced "no JSON in output" to a structured
 * role drifting into an assistant persona and narrating instead of answering.
 *
 * Tools are refused TWICE, on purpose. M6 configures the backend to have none,
 * and the guard below denies every request that arrives anyway. The first is
 * the real mechanism; the second is there because the whole reason
 * `preflightAcpBackend` exists is that a backend silently ignoring its own
 * permission configuration is a thing that happens, and a structured role that
 * quietly gained filesystem access would be a containment failure in the roles
 * that were supposed to be the safe ones.
 *
 * Each ladder rung is a FRESH session. Appending a correction to a session that
 * has already produced prose invites the model to continue in the same register,
 * and a new session costs nothing here because there is no accumulated worktree
 * state to carry over.
 */
export async function runStructuredAcp<T>(params: RunStructuredAcpParams<T>): Promise<RunStructuredAcpResult<T>> {
  let sessionId = "";
  let usageSource: RunWorkerAcpResult["usageSource"] = "unavailable";

  const denyAll = async (call: AcpToolCallForGuard) => {
    params.logger?.warn(
      `[acp/${params.role}] denied a tool call in a structured role; the backend is not honouring its tool configuration`,
      { role: params.role, kind: call.kind ?? null, title: call.title ?? null },
    );
    return { allow: false, reason: `role '${params.role}' runs with no tools` };
  };

  const r = await runStructuredLadder<T>({
    role: params.role,
    validation: params.validation,
    maxAttempts: params.maxAttempts,
    logger: params.logger,
    attempt: async (correction) => {
      const turn = await runWorkerAcp({
        agent: params.agent,
        worktreePath: params.cwd,
        systemPrompt: params.systemPrompt,
        userMessage: correction ? `${params.userMessage}\n\n${correction}` : params.userMessage,
        model: params.model,
        timeoutSeconds: params.timeoutSeconds,
        streamOpenTimeoutSeconds: params.streamOpenTimeoutSeconds,
        acpGuard: denyAll,
        secretToken: params.secretToken,
        logger: params.logger,
      });
      if (!sessionId) sessionId = turn.sdkSessionId;
      usageSource = turn.usageSource;
      return {
        raw: turn.finalMessage,
        costUsd: turn.costUsd,
        tokensIn: turn.tokensIn,
        tokensOut: turn.tokensOut,
        sessionId: turn.sdkSessionId,
        truncated: turn.stopReason === "max_tokens",
      };
    },
  });

  return {
    parsed: r.parsed,
    sdkSessionId: sessionId,
    costUsd: r.costUsd,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    usageSource,
    repaired: r.repaired,
  };
}

/**
 * What this backend can do.
 *
 * `toolPermissionCallback` is declared true, but M6 does not take that on
 * trust: it is the one capability whose absence is invisible at runtime, and
 * the M2 probe measured OpenCode on default configuration running four shell
 * commands and two edits without a single permission request. The declaration
 * says "this backend is capable of asking"; the live probe establishes that
 * this INSTALLATION actually does.
 *
 * `reportsCostUsd` is true for hosted providers and false in practice for local
 * ones, which is why `usageSource` accompanies every result rather than the
 * harness inferring it from a zero.
 */
export const ACP_CAPABILITIES: BackendCapabilities = {
  id: "acp",
  toolUse: true,
  toolPermissionCallback: true,
  disableAllTools: true,
  // session/load is optional in the spec and unsupported by some agents; the
  // adapter falls back to a fresh session, so resume is best-effort.
  resumeSession: true,
  reportsCostUsd: true,
};

export interface AcpPreflightResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Startup check for the one failure mode that is invisible at runtime.
 *
 * An ACP backend that is not configured to ask for permission simply never
 * sends `session/request_permission`. Nothing errors; the guard is just never
 * consulted, and the bash whitelist and path denylist are silently inert while
 * still reading as enabled. The M2 probe measured exactly this: OpenCode on
 * default config ran four shell commands and two edits with zero permission
 * requests.
 *
 * This must therefore be verified before a worker is ever dispatched, and must
 * fail closed.
 */
export function preflightAcpBackend(input: {
  agentId: string;
  /** Parsed contents of the backend's own config, e.g. opencode.json. */
  backendConfig: unknown;
}): AcpPreflightResult {
  const reasons: string[] = [];
  const cfg = input.backendConfig as Record<string, unknown> | null | undefined;

  if (input.agentId === "opencode") {
    const perm = cfg?.["permission"] as Record<string, unknown> | undefined;
    if (!perm) {
      reasons.push("opencode.json has no `permission` block; the backend will run bash and edits without asking, so the harness guard would never be consulted");
    } else {
      for (const key of ["bash", "edit"]) {
        const v = perm[key];
        // A nested object maps patterns to actions; a bare "allow" is the
        // dangerous case because it silently bypasses the guard entirely.
        if (v === undefined) {
          reasons.push(`opencode.json permission.${key} is unset (defaults are permissive); set it to "ask"`);
        } else if (v === "allow") {
          reasons.push(`opencode.json permission.${key} is "allow"; the harness guard cannot see these calls`);
        }
      }
    }
  } else if (input.agentId === "codex") {
    // Measured: Codex only escalates on sandbox escape, so in-workspace reads
    // of denylisted files never reach the guard.
    reasons.push("codex uses sandbox-and-escalate: in-workspace reads of denylisted files (.env, keys) never raise a permission request, so path_denylist is unenforceable");
  } else if (input.agentId === "claude") {
    // Measured: none of Claude Code's five ACP session modes asks for every
    // tool call, whereas the SDK path invokes canUseTool for all of them.
    // Routing the worker here would be a safety regression against what we
    // already ship, for the same vendor and the same model.
    reasons.push("claude over ACP is strictly weaker than the existing claude-code SDK backend: no session mode asks for every tool call, and it emits no usage_update. Use worker_backend=claude-code instead");
  }

  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// The live capability probe
// ---------------------------------------------------------------------------

export interface AcpLiveProbeResult extends AcpPreflightResult {
  /** True when a `session/request_permission` actually arrived. */
  sawPermissionRequest: boolean;
  /** True when the agent honoured a denial rather than proceeding anyway. */
  denialHonoured: boolean;
  /** What the agent did, for the audit trail and for an operator to read. */
  detail: string;
}

/**
 * Prove, by doing it, that this INSTALLATION asks before it acts.
 *
 * `preflightAcpBackend` reads configuration and reasons about what it should
 * mean. That is worth doing and it is not sufficient, because every step
 * between the config and the behaviour can fail silently: the variable may not
 * reach the child, the agent's version may have renamed a key, the document may
 * be shadowed by managed preferences, or the backend may simply not honour what
 * it was told. In all of those cases the config LOOKS right and the guard is
 * never called — and a guard that is never called is indistinguishable from a
 * guard that approved everything.
 *
 * So this drives a real turn, asks for a real tool call, and requires the
 * round-trip to happen. It DENIES the call, because a probe that approves is
 * only half a test: an agent could conceivably ask and then ignore the answer,
 * and the denial path is the one the containment story actually rests on.
 *
 * FAILS CLOSED, on every axis. No permission request, a timeout, a spawn
 * failure, an agent that proceeds after being refused, or any thrown error all
 * return `ok: false`. There is no path through this function where "we could
 * not tell" produces a pass, because "we could not tell" is exactly what the
 * broken case looks like.
 */
export async function probeAcpPermissionEnforcement(input: {
  agent: AcpAgentSpec;
  /** A scratch directory. Must NOT be a real worktree: the probe asks for a write. */
  cwd: string;
  model?: string;
  timeoutSeconds?: number;
  logger?: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}): Promise<AcpLiveProbeResult> {
  const marker = `harness-probe-${Date.now().toString(36)}`;
  const markerFile = `${marker}.txt`;
  let sawPermissionRequest = false;
  let sawDeniableOption = false;

  const fail = (detail: string, extra?: Partial<AcpLiveProbeResult>): AcpLiveProbeResult => ({
    ok: false,
    reasons: [
      `the ACP permission probe did not confirm that '${input.agent.command}' asks before it acts: ${detail}. ` +
        `The harness guard (bash whitelist, path deny-list, no-push) is enforced ONLY through ` +
        `session/request_permission, so without that round-trip those controls do not run at all, ` +
        `while still reading as enabled in openclaw.json.`,
    ],
    sawPermissionRequest,
    denialHonoured: false,
    detail,
    ...extra,
  });

  let turn: RunWorkerAcpResult;
  try {
    turn = await runWorkerAcp({
      agent: input.agent,
      worktreePath: input.cwd,
      // The probe asks for a write rather than a shell command because `edit`
      // and `bash` are configured separately in OpenCode and a write is the
      // one that cannot be satisfied from a cache or a sandbox short-circuit.
      systemPrompt:
        "You are being checked for tool availability. Do exactly what is asked, using your file-writing tool. " +
        "Do not explain, do not ask questions, and do not use any other tool.",
      userMessage: `Create a file named ${markerFile} in the current directory containing the single word ok.`,
      model: input.model ?? "",
      timeoutSeconds: input.timeoutSeconds ?? 120,
      acpGuard: async (call) => {
        sawPermissionRequest = true;
        input.logger?.info("[acp/probe] permission request received", { kind: call.kind ?? null });
        return { allow: false, reason: "capability probe: denying on purpose to confirm the round-trip" };
      },
      logger: input.logger,
    });
  } catch (err) {
    return fail(`the agent could not be run at all (${String((err as Error)?.message ?? err)})`);
  }

  if (turn.stopReason === "timeout" || turn.stopReason === "first_token_timeout") {
    return fail(`the agent produced no usable turn before the probe deadline (${turn.stopReason})`);
  }

  // "Did the agent run at all" has to be answered BEFORE "did it ask", or a
  // missing binary is reported as a permission-configuration fault and sends
  // the operator after the wrong thing entirely. A child that never opened its
  // stream never got as far as having an opinion about permissions.
  //
  // This is a separate branch from the try/catch above because a spawn failure
  // does not throw out of `runWorkerAcp`: the adapter handles the child's async
  // `error` event and returns a failed turn, which is what stops one bad
  // command from taking the harness down.
  if (!turn.streamOpened) {
    return fail(
      `the agent could not be run at all (it never opened an ACP stream; ` +
        `${turn.logsExcerpt.trim().slice(-300) || "no output"})`,
    );
  }

  if (!sawPermissionRequest) {
    return fail(
      "the agent completed a turn that should have required a file write WITHOUT ever asking permission. " +
        "This is the measured default behaviour of OpenCode with no `permission` block, and it means " +
        "OPENCODE_CONFIG_CONTENT is not reaching the agent or is not being honoured",
    );
  }

  // The guard denied. The adapter records what it refused, and the agent must
  // not have gone ahead regardless.
  sawDeniableOption = turn.deniedToolCalls.length > 0;
  if (!sawDeniableOption) {
    return fail("a permission request arrived but the adapter recorded no denial, so the refusal path is unproven");
  }

  // Ask the FILESYSTEM whether the write happened, not the model.
  //
  // The narration check below is a fallback, and on its own it was the weak
  // link in the whole probe: it confirms containment by asking the agent
  // whether it complied. An agent that writes through an unguarded path and
  // simply does not mention it passes -- and "wrote the file without telling
  // us" is a strictly more alarming failure than "wrote it and said so", so
  // the check was weakest exactly where it most needed to be strong.
  //
  // `marker` is a filename the agent was told to create in `cwd`; if it is on
  // disk after a refusal, the refusal was decorative.
  let markerOnDisk = false;
  try {
    // `${marker}.txt`, matching the filename the prompt above asks for. Kept
    // in one variable so the prompt and the check cannot drift apart.
    markerOnDisk = existsSync(join(input.cwd, markerFile));
  } catch {
    // An unreadable scratch dir is not evidence of a write. The narration
    // check still applies below.
  }
  if (markerOnDisk) {
    return fail(
      `the agent WROTE ${markerFile} to disk after the harness refused the call; a backend that asks and then ` +
        "proceeds anyway offers no containment at all",
      { sawPermissionRequest: true },
    );
  }

  const claimedWrite = turn.finalMessage.includes(marker) && /created|written|wrote/i.test(turn.finalMessage);
  if (claimedWrite) {
    return fail(
      "the agent reported completing the write AFTER the harness refused it; a backend that asks and then " +
        "proceeds anyway offers no containment at all",
      { sawPermissionRequest: true },
    );
  }

  input.logger?.info("[acp/probe] permission enforcement confirmed", {
    denied: turn.deniedToolCalls.length,
    stopReason: turn.stopReason,
  });

  return {
    ok: true,
    reasons: [],
    sawPermissionRequest: true,
    denialHonoured: true,
    detail: `asked before acting and honoured a denial (${turn.deniedToolCalls.length} call(s) refused)`,
  };
}

/**
 * The full startup check: read the configuration, then prove the behaviour.
 *
 * Static inspection runs first because it is free and its messages are more
 * specific — "permission.bash is 'allow'" tells an operator what to edit, where
 * the live probe can only say "it did not ask". But a clean static result is
 * never sufficient on its own, so a pass there does not skip the probe.
 */
export async function preflightAcpBackendLive(input: {
  agentId: string;
  backendConfig: unknown;
  agent: AcpAgentSpec;
  cwd: string;
  model?: string;
  timeoutSeconds?: number;
  logger?: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}): Promise<AcpLiveProbeResult> {
  const stat = preflightAcpBackend({ agentId: input.agentId, backendConfig: input.backendConfig });
  if (!stat.ok) {
    return { ...stat, sawPermissionRequest: false, denialHonoured: false, detail: "refused on configuration inspection" };
  }
  return probeAcpPermissionEnforcement(input);
}
