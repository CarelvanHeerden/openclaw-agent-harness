/**
 * Durable, structured, append-only INTERACTION LOG (beta.63, Part B).
 *
 * WHY THIS EXISTS
 * ---------------
 * The b60 record-depth run silently stalled ~2 days near completion with no
 * terminal verdict, and it was UNDIAGNOSABLE because:
 *   - the harness `state.db` (plan JSON, sub-task shapes, audit_log) lives
 *     INSIDE the ephemeral git worktree that gets released at teardown, so a
 *     released/restarted worktree takes the history with it;
 *   - the piped stdout (`okf-test.log`) does NOT capture DB audit events and
 *     freezes/detaches on restart;
 *   - the SDK/LLM interactions (lead planner, worker, adversary) are separate
 *     Claude Agent SDK calls whose inputs/outputs/costs/timing are NOT durably
 *     captured anywhere an operator can read after the fact.
 *
 * THE FIX
 * -------
 * A dedicated, append-only, structured JSONL log written OUTSIDE the worktree
 * in the harness data dir (`<dataDir>/logs`). One file per session
 * (`session-<id>.jsonl`) that survives worktree release AND container restart
 * (if the data dir is on a persisted volume), plus a rolling global tail
 * (`harness-interactions.jsonl`) for a cross-session view.
 *
 * SECRET REDACTION on write is MANDATORY and NOT disableable — every string
 * value in every payload is scrubbed through {@link redactSecrets} before it
 * touches disk. `log.full_prompts` only controls whether we persist full
 * prompt text (default false = sizes + tails only); it NEVER disables
 * redaction.
 *
 * A stalled run leaves a complete trail: a last `sdk_request` with no matching
 * `sdk_response` is the exact hang point; frozen phase + last event ts is the
 * stall boundary.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactSecrets } from "../adapters/git-worktree.js";

/** The phase classification carried on every interaction-log event. */
export type InteractionPhase =
  | "classify"
  | "plan"
  | "worker"
  | "review"
  | "finalize"
  | "watchdog"
  | "unknown";

/** The role of an SDK/LLM call. */
export type SdkRole = "lead" | "worker" | "adversary" | "classifier" | "crystalliser";

/**
 * One structured event. `event` is the discriminator. Everything else is a
 * free-form bag that gets redacted + serialised. `ts` and `sessionId` are
 * always stamped by the logger, not the caller.
 */
export interface InteractionEvent {
  event: string;
  phase?: InteractionPhase;
  seq?: number;
  cycle?: number;
  [k: string]: unknown;
}

export interface InteractionLogConfig {
  enabled: boolean;
  dir: string;
  fullPrompts: boolean;
  retentionDays: number;
}

export interface InteractionLogDeps {
  config: InteractionLogConfig;
  logger?: { warn: (m: string, meta?: unknown) => void };
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const GLOBAL_TAIL = "harness-interactions.jsonl";

/** Max chars of a prompt tail we keep when full_prompts is off. */
export const PROMPT_TAIL_CHARS = 2000;

/**
 * Deep-redact every string leaf in an arbitrary JSON-ish value. Reuses the
 * exec/git redaction discipline (userinfo-in-URL + exact-token scrubbing) and
 * additionally scrubs common standalone credential token shapes
 * (Anthropic `sk-ant-...`, GitHub `ghp_`/`gho_`/`ghs_`/`github_pat_...`,
 * generic bearer tokens). MANDATORY on every write — there is no off switch.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactTokenShapes(redactSecrets(value));
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Scrub standalone secret token shapes that {@link redactSecrets} (which only
 * knows about URL userinfo + a KNOWN token value) cannot catch when the raw
 * token appears bare in a prompt/log line.
 */
export function redactTokenShapes(text: string): string {
  return text
    // Anthropic API keys.
    .replace(/sk-ant-[A-Za-z0-9_\-]{8,}/g, "sk-ant-***")
    // GitHub fine-grained PAT.
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
    // GitHub classic/oauth/server tokens.
    .replace(/gh[posru]_[A-Za-z0-9]{20,}/g, "gh_***")
    // GitLab PAT.
    .replace(/glpat-[A-Za-z0-9_\-]{16,}/g, "glpat-***")
    // OpenAI-style keys.
    .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-***")
    // Bearer tokens in an Authorization header value.
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi, "$1***")
    // x-access-token:<secret>@ (git clone url form, belt-and-braces).
    .replace(/(x-access-token:)[^@\s]+/gi, "$1***");
}

/**
 * Truncate a prompt to a tail (last N chars) unless full_prompts is on. Always
 * returns the character count separately so a stall's prompt SIZE is durable
 * even when the body is not.
 */
export function summarisePrompt(prompt: string, fullPrompts: boolean): { promptChars: number; promptTail: string; promptFull?: string } {
  const promptChars = prompt.length;
  const tail = prompt.length > PROMPT_TAIL_CHARS ? prompt.slice(-PROMPT_TAIL_CHARS) : prompt;
  const out: { promptChars: number; promptTail: string; promptFull?: string } = { promptChars, promptTail: tail };
  if (fullPrompts) out.promptFull = prompt;
  return out;
}

/**
 * The interaction logger. Construct one per runtime; call {@link log} on the
 * hot path. All writes are synchronous appends (JSONL) so a crash mid-run
 * still leaves a complete, parseable trail up to the last flushed line.
 */
export class InteractionLog {
  private readonly cfg: InteractionLogConfig;
  private readonly logger?: { warn: (m: string, meta?: unknown) => void };
  private readonly nowFn: () => number;
  private dirEnsured = false;

  constructor(deps: InteractionLogDeps) {
    this.cfg = deps.config;
    this.logger = deps.logger;
    this.nowFn = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  get dir(): string {
    return this.cfg.dir;
  }

  get fullPrompts(): boolean {
    return this.cfg.fullPrompts;
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    mkdirSync(this.cfg.dir, { recursive: true });
    this.dirEnsured = true;
  }

  private sessionFile(sessionId: string): string {
    // sessionId is a UUID/opaque id; guard against path traversal from a
    // malformed id by stripping anything that is not a safe filename char.
    const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
    return join(this.cfg.dir, `session-${safe}.jsonl`);
  }

  private globalFile(): string {
    return join(this.cfg.dir, GLOBAL_TAIL);
  }

  /**
   * Append one structured event for a session. Never throws — a logging
   * failure must not crash a live run. Redaction is applied UNCONDITIONALLY.
   */
  log(sessionId: string, event: InteractionEvent): void {
    if (!this.cfg.enabled) return;
    try {
      this.ensureDir();
      const stamped = {
        ts: this.nowFn(),
        sessionId,
        ...event,
      };
      // MANDATORY redaction — no config gate.
      const redacted = redactValue(stamped) as Record<string, unknown>;
      const line = JSON.stringify(redacted) + "\n";
      appendFileSync(this.sessionFile(sessionId), line);
      appendFileSync(this.globalFile(), line);
    } catch (err) {
      this.logger?.warn?.("[interaction-log] append failed", { sessionId, event: event.event, err: String(err) });
    }
  }

  /**
   * Convenience: log an `sdk_request`. Applies the full_prompts gate to the
   * prompt body (size + tail always retained). Redaction still applies on write.
   */
  logSdkRequest(sessionId: string, params: {
    role: SdkRole;
    model: string;
    prompt: string;
    phase?: InteractionPhase;
    seq?: number;
    cycle?: number;
    toolsAllowed?: string[];
    sdkSessionId?: string;
  }): void {
    if (!this.cfg.enabled) return;
    const p = summarisePrompt(params.prompt, this.cfg.fullPrompts);
    this.log(sessionId, {
      event: "sdk_request",
      phase: params.phase,
      seq: params.seq,
      cycle: params.cycle,
      role: params.role,
      model: params.model,
      promptChars: p.promptChars,
      promptTail: p.promptTail,
      ...(p.promptFull !== undefined ? { promptFull: p.promptFull } : {}),
      toolsAllowed: params.toolsAllowed,
      sdkSessionId: params.sdkSessionId,
    });
  }

  /** Convenience: log an `sdk_response`. */
  logSdkResponse(sessionId: string, params: {
    role: SdkRole;
    model: string;
    phase?: InteractionPhase;
    seq?: number;
    cycle?: number;
    finishReason?: string;
    outputChars?: number;
    costUsd?: number;
    durationMs?: number;
    toolCalls?: string[];
    sdkSessionId?: string;
    finalMessageTail?: string;
  }): void {
    if (!this.cfg.enabled) return;
    this.log(sessionId, {
      event: "sdk_response",
      phase: params.phase,
      seq: params.seq,
      cycle: params.cycle,
      role: params.role,
      model: params.model,
      finishReason: params.finishReason,
      outputChars: params.outputChars,
      costUsd: params.costUsd,
      durationMs: params.durationMs,
      toolCalls: params.toolCalls,
      sdkSessionId: params.sdkSessionId,
      finalMessageTail: params.finalMessageTail,
    });
  }

  /**
   * Read the tail of a session's JSONL as parsed events (newest last). Used by
   * the `harness_logs` tool so operators can read the trail without shell /
   * container access. Returns `{ found:false }` when the file does not exist.
   */
  readSessionTail(sessionId: string, limit = 100): { found: boolean; file: string; events: Array<Record<string, unknown>>; totalLines: number } {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return { found: false, file, events: [], totalLines: 0 };
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      this.logger?.warn?.("[interaction-log] read failed", { sessionId, err: String(err) });
      return { found: false, file, events: [], totalLines: 0 };
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const tail = lines.slice(-Math.max(1, limit));
    const events: Array<Record<string, unknown>> = [];
    for (const l of tail) {
      try {
        events.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        // Skip a torn last line (crash mid-append). The rest still parse.
      }
    }
    return { found: true, file, events, totalLines: lines.length };
  }

  /**
   * Prune session log files older than `retention_days`. The rolling global
   * tail is never deleted (it is the cross-session index) but is left to grow
   * bounded by the operator's disk; per-session files are the bulk. Returns the
   * number of files removed. Never throws.
   */
  prune(now = this.nowFn()): { removed: number; kept: number } {
    let removed = 0;
    let kept = 0;
    if (!this.cfg.enabled) return { removed, kept };
    const days = this.cfg.retentionDays;
    if (!(days > 0)) return { removed, kept };
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    try {
      if (!existsSync(this.cfg.dir)) return { removed, kept };
      for (const name of readdirSync(this.cfg.dir)) {
        if (!name.startsWith("session-") || !name.endsWith(".jsonl")) continue;
        const full = join(this.cfg.dir, name);
        try {
          const st = statSync(full);
          if (st.mtimeMs < cutoff) {
            unlinkSync(full);
            removed++;
          } else {
            kept++;
          }
        } catch {
          // ignore a per-file stat/unlink race
        }
      }
    } catch (err) {
      this.logger?.warn?.("[interaction-log] prune failed", { err: String(err) });
    }
    return { removed, kept };
  }
}

/**
 * Derive the interaction-log config from the harness `log` block + the data
 * dir (dirname of the state db). Centralised so both the runtime and tests
 * resolve the same `<dataDir>/logs` default.
 */
export function resolveInteractionLogConfig(
  logBlock: { interaction_log_enabled?: boolean; dir?: string; full_prompts?: boolean; retention_days?: number } | undefined,
  dataDir: string,
): InteractionLogConfig {
  const b = logBlock ?? {};
  return {
    enabled: b.interaction_log_enabled !== false,
    dir: b.dir && b.dir.trim() ? resolve(b.dir.replace(/^~/, process.env.HOME ?? "")) : join(dataDir, "logs"),
    fullPrompts: b.full_prompts === true,
    retentionDays: typeof b.retention_days === "number" && b.retention_days > 0 ? b.retention_days : 14,
  };
}
