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
export declare function hasRealSlackBinding(channel: string | null | undefined, thread: string | null | undefined): boolean;
export interface ProgressPosterDeps {
    slackToken: string;
    fetchImpl?: typeof fetch;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
}
export interface PostResult {
    ok: boolean;
    ts?: string;
    error?: string;
    /** beta.97 (Fix #4): attempts made before returning (1 = no retry). */
    attempts?: number;
}
export declare class SlackProgressPoster {
    private readonly deps;
    constructor(deps: ProgressPosterDeps);
    private fetchFn;
    /**
     * Best-effort direct `chat.postMessage` into a thread. NEVER throws; returns
     * `{ ok:false, error }` on any failure (HTTP error, Slack `ok:false`, 429,
     * or a thrown fetch). A failed progress post must not fail the run.
     */
    post(channel: string, threadTs: string, text: string): Promise<PostResult>;
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
    postTerminal(channel: string, threadTs: string, text: string, opts?: {
        maxAttempts?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
        sleepImpl?: (ms: number) => Promise<void>;
    }): Promise<PostResult>;
}
//# sourceMappingURL=progress-poster.d.ts.map