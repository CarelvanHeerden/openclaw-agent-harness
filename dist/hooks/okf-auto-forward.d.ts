/**
 * beta.23: OKF auto-forward, Option B (deterministic plugin-side hook).
 *
 * Beta.21 wired the `relevantConcepts` pass-through end-to-end.
 * Beta.22 taught the calling OpenClaw agent to forward OKF blocks via
 * an instruction in the tool description (prompt-side, model-reliant).
 * Beta.23 makes the auto-forward deterministic:
 *
 *   1. Observe `before_prompt_build` hook events to see the current
 *      turn's context. Parse any `## Relevant Knowledge (OKF)` sections
 *      out of the system-context text. Cache the parsed concepts under
 *      the session key.
 *
 *   2. Observe `before_tool_call` hook events filtered to `harness_run`
 *      and `harness_start_session`. If the tool params lack a
 *      `relevantConcepts` field, look up the cached concepts for this
 *      session and rewrite the params so the harness sees them.
 *
 * Cache is bounded (LRU-ish with a TTL) so a long-running gateway can't
 * leak memory. Individual entries expire after 15 minutes of inactivity;
 * total cache capped at 256 sessions.
 *
 * Requires
 *   plugins.entries.openclaw-agent-harness.hooks.allowConversationAccess: true
 * in openclaw.json for `before_prompt_build` to fire for this plugin.
 * Without it, the parser hook is silently skipped by the platform and
 * the auto-forward degrades to the beta.22 prompt-side path.
 */
/**
 * Parsed OKF concept as it lands in the tool `relevantConcepts` array.
 * Matches the `OkfConceptRef` shape declared in
 * `src/crystallise/prompt-refiner.ts`; keeping it structural here avoids
 * a cross-module type import cycle.
 */
export interface ParsedOkfConcept {
    id: string;
    path?: string;
    summary?: string;
    tags?: string[];
    content?: string;
}
/**
 * beta.23: extract OKF concept blocks from a chunk of context text.
 *
 * The OpenClaw OKF plugin injects blocks that look like:
 *
 *   ## Relevant Knowledge (OKF)
 *
 *   ### Google Workspace OAuth (Credential)
 *   OAuth credentials for Carel's Google Workspace calendar (destination)
 *   Tags: credential, oauth, google-workspace, google, calendar
 *   Links to: workflows/health-check, workflows/gmail-sync
 *   ID: `credentials/workspace-oauth`
 *
 * We parse the id (required), summary (first non-empty line under the H3
 * that isn't a metadata line), and tags (from the `Tags:` line). Path is
 * NOT part of the OKF surface today, so parsed concepts have `path`
 * undefined by default; callers can layer path knowledge on top if
 * needed.
 *
 * The parser is deliberately tolerant: unknown metadata lines are
 * ignored, blocks without an `ID:` line are skipped, and stray
 * whitespace is normalised. Returns an empty array when no OKF section
 * is found.
 */
export declare function parseOkfBlocksFromContext(text: string | undefined): ParsedOkfConcept[];
/**
 * beta.23: per-session cache of the most recent OKF blocks parsed from
 * that session's context. Bounded to avoid unbounded growth on a
 * long-running gateway.
 */
export declare class OkfConceptCache {
    private readonly opts;
    private readonly entries;
    constructor(opts?: {
        maxSessions?: number;
        ttlMs?: number;
        now?: () => number;
    });
    private get maxSessions();
    private get ttlMs();
    private now;
    set(sessionKey: string, concepts: ParsedOkfConcept[]): void;
    get(sessionKey: string): ParsedOkfConcept[] | undefined;
    /** Number of currently-cached sessions. Exposed for tests + observability. */
    size(): number;
    /** Clear all entries. Exposed for tests. */
    clear(): void;
}
/**
 * beta.23: determine whether a `before_tool_call` payload should have
 * `relevantConcepts` injected. Returns a small discriminated result so
 * callers can act on it without further inspection.
 *
 * Rules:
 *   - Only rewrite the two harness tools (`harness_run`,
 *     `harness_start_session`); other tools are none of our business.
 *   - If the params already carry a non-empty `relevantConcepts`,
 *     respect the caller. They explicitly forwarded concepts, we don't
 *     second-guess.
 *   - Otherwise, if the cache has concepts for this session, inject
 *     them.
 *   - Otherwise, no-op.
 *
 * Kept pure so tests can exercise the decision without a live hook.
 */
export declare function decideAutoForward(input: {
    toolName: string;
    params: unknown;
    cached: ParsedOkfConcept[] | undefined;
}): {
    inject: false;
} | {
    inject: true;
    concepts: ParsedOkfConcept[];
    injectionSite: "root" | "brief";
};
/**
 * beta.23: build the rewritten `params` for a `before_tool_call` return.
 * Immutable: constructs a new object rather than mutating `params`.
 */
export declare function buildRewrittenParams(toolName: string, params: unknown, concepts: ParsedOkfConcept[]): Record<string, unknown>;
/**
 * beta.23: pick a stable cache key from a hook event's context. Prefers
 * `sessionKey` (stable across turns) but falls back to `sessionId` if
 * that's all we have. Empty string when neither is present, which the
 * cache treats as "don't store".
 */
export declare function cacheKeyForCtx(ctx: unknown): string;
//# sourceMappingURL=okf-auto-forward.d.ts.map