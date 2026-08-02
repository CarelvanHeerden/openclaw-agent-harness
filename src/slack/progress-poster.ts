/**
 * Slack progress poster (beta.77).
 *
 * WHY THIS EXISTS
 * ---------------
 * In agent-orchestrated mode the harness surfaces progress/terminal ONLY via
 * the poll model (beta.37): the loop writes `loop.progress` audit rows and the
 * calling OpenClaw agent POLLS `harness_progress` and relays headlines to Slack
 * through its own embedded agent turn (`api.sendMessage`). When that channel-
 * agent turn WEDGES (the DR/BCP `d47c8686` blackout: `embedded_run:started`,
 * `recovery=none`), the harness loop keeps running fine but NO progress or
 * terminal announcement reaches anyone -- a single wedge blinds the whole run.
 *
 * This poster is a SECOND, INDEPENDENT outbound path for progress + terminal
 * announcements ONLY. It posts DIRECTLY to Slack's `chat.postMessage` using the
 * SAME vault-resolved bot token the reactions poller already uses (zero agent
 * turns), so a wedge in the agent turn can no longer blind the informational
 * stream.
 *
 * HARD BOUNDARY: this is OUTBOUND, one-way, best-effort. It NEVER handles
 * clarifications or any inbound control -- those stay 100% agent-mediated
 * (`awaiting_clarification` -> `harness_progress` -> `harness_answer` tool).
 * The harness still never reads a free-text Slack reply (beta.34 removed the
 * listener). A failed progress post must NEVER fail the run.
 *
 * WHY THE GATE MATTERS
 * --------------------
 * The pre-beta.37 direct-post died because agent-orchestrated runs have
 * `slack_channel = ""` and `slack_thread = "agent:<uuid>"` (no real Slack
 * binding), so every `chat.postMessage` was rejected by Slack and swallowed by
 * a blind `.catch(() => {})`. `hasRealSlackBinding` is the guard: we ONLY
 * direct-post when a REAL channel + thread was explicitly passed on
 * `harness_run`. Otherwise we fall back to the poll model (unchanged).
 */

/**
 * PURE gate: does this session have a REAL Slack channel+thread binding we can
 * post into, or is it an agent-orchestrated run with a synthetic thread key?
 *
 * True iff channel is non-empty AND thread is non-empty AND thread is NOT a
 * synthetic `agent:<uuid>` key NOR a reclaimed `retired:<...>` tombstone.
 */
export function hasRealSlackBinding(channel: string | null | undefined, thread: string | null | undefined): boolean {
  if (!channel || !thread) return false;
  if (thread.startsWith("agent:")) return false;
  if (thread.startsWith("retired:")) return false;
  return true;
}

export interface ProgressPosterDeps {
  slackToken: string;
  fetchImpl?: typeof fetch;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}

export interface PostResult {
  ok: boolean;
  ts?: string;
  error?: string;
  /** beta.97 (Fix #4): attempts made before returning (1 = no retry). */
  attempts?: number;
}

/** beta.97 (Fix #4): retryable failure classes for the terminal-post path. */
function isRetryablePostError(r: PostResult): boolean {
  const e = r.error ?? "";
  if (e === "ratelimited") return true;
  if (/^http_(408|429|5\d\d)$/.test(e)) return true;
  // A thrown fetch (network blip) is stringified into `error`; retry those too.
  if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(e)) return true;
  return false;
}

interface ChatPostMessageResponse {
  ok: boolean;
  ts?: string;
  error?: string;
  retry_after?: number;
}

export class SlackProgressPoster {
  constructor(private readonly deps: ProgressPosterDeps) {}

  private fetchFn(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  /**
   * Best-effort direct `chat.postMessage` into a thread. NEVER throws; returns
   * `{ ok:false, error }` on any failure (HTTP error, Slack `ok:false`, 429,
   * or a thrown fetch). A failed progress post must not fail the run.
   */
  async post(channel: string, threadTs: string, text: string): Promise<PostResult> {
    if (!hasRealSlackBinding(channel, threadTs)) {
      return { ok: false, error: "no_real_binding" };
    }
    try {
      const res = await this.fetchFn()("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.slackToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, thread_ts: threadTs, text }),
      });
      // Slack rate-limits on 429 AND can encode ratelimited in a 200 body.
      // Either way: swallow (best-effort), never fail the run.
      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after") ?? "?";
        this.deps.logger.warn("[progress-poster] rate limited; dropping progress post", { channel, retryAfter });
        return { ok: false, error: "ratelimited", retryAfterSec: parseRetryAfter(retryAfter) } as PostResult & { retryAfterSec?: number };
      }
      if (!res.ok) {
        this.deps.logger.warn("[progress-poster] HTTP not ok", { status: res.status, channel });
        return { ok: false, error: `http_${res.status}` };
      }
      const j = (await res.json()) as ChatPostMessageResponse;
      if (!j.ok) {
        this.deps.logger.warn("[progress-poster] chat.postMessage rejected", { error: j.error, channel });
        return { ok: false, error: j.error ?? "unknown" };
      }
      return { ok: true, ts: j.ts };
    } catch (err) {
      this.deps.logger.warn("[progress-poster] post failed", { channel, err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /**
   * beta.97 (Fix #4): TERMINAL-post path with bounded retry + Retry-After.
   *
   * The plain `post()` is best-effort single-shot -- correct for the high-
   * frequency PROGRESS stream (a dropped mid-run headline is harmless). But the
   * TERMINAL post is the one message a run must not lose: b96 guaranteed the
   * harness always GENERATES a reason-bearing terminal headline, yet a transient
   * Slack 429/5xx/network blip on that single fire-and-forget POST still drops
   * it silently -> zero-feedback death via the transport vector. This wrapper
   * retries a bounded number of times, honouring Slack's `Retry-After` (capped),
   * and hard-logs a final failure so the drop is never silent. Still NEVER
   * throws -- a failed terminal post must not fail the (already-terminal) run.
   */
  async postTerminal(
    channel: string,
    threadTs: string,
    text: string,
    opts?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleepImpl?: (ms: number) => Promise<void> },
  ): Promise<PostResult> {
    const maxAttempts = Math.max(1, opts?.maxAttempts ?? 4);
    const baseDelayMs = opts?.baseDelayMs ?? 1000;
    const maxDelayMs = opts?.maxDelayMs ?? 30_000;
    const sleep = opts?.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: PostResult = { ok: false, error: "not_attempted" };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await this.post(channel, threadTs, text);
      if (last.ok) return { ...last, attempts: attempt };
      // A structural failure (no binding, auth, bad channel) will never clear
      // on retry -- stop immediately.
      if (!isRetryablePostError(last)) {
        this.deps.logger.warn("[progress-poster] terminal post non-retryable; giving up", {
          channel,
          error: last.error,
          attempt,
        });
        return { ...last, attempts: attempt };
      }
      if (attempt === maxAttempts) break;
      const retryAfterSec = (last as PostResult & { retryAfterSec?: number }).retryAfterSec;
      const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = retryAfterSec != null ? Math.min(maxDelayMs, retryAfterSec * 1000) : backoffMs;
      this.deps.logger.warn("[progress-poster] terminal post failed; retrying", {
        channel,
        error: last.error,
        attempt,
        nextDelayMs: delayMs,
      });
      await sleep(delayMs);
    }
    // Bounded retries exhausted -- HARD log (not a silent drop) so the terminal
    // announcement loss is at least visible in the harness log.
    this.deps.logger.warn("[progress-poster] TERMINAL POST DROPPED after retries (run terminated but announcement not delivered)", {
      channel,
      error: last.error,
      attempts: maxAttempts,
    });
    return { ...last, attempts: maxAttempts };
  }
}

/** beta.97 (Fix #4): parse a Slack `Retry-After` header (seconds) into a number, or undefined. */
function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v || v === "?") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
