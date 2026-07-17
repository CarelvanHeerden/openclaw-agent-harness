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
export function parseOkfBlocksFromContext(text) {
    if (!text || typeof text !== "string")
        return [];
    // Locate the OKF section. Accept either `## Relevant Knowledge (OKF)`
    // or `## Relevant Knowledge` (older / stripped variants).
    const sectionRe = /##\s+Relevant Knowledge(?:\s*\(OKF\))?\s*\n/i;
    const startMatch = sectionRe.exec(text);
    if (!startMatch)
        return [];
    const sectionStart = startMatch.index + startMatch[0].length;
    // The section runs until the next top-level `## ` header or end of text.
    const rest = text.slice(sectionStart);
    const nextHeader = /\n##\s+/.exec(rest);
    const sectionBody = nextHeader ? rest.slice(0, nextHeader.index) : rest;
    const results = [];
    // Each concept block starts with an H3 (### Title).
    const blocks = sectionBody.split(/\n(?=###\s+)/);
    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed)
            continue;
        if (!trimmed.startsWith("###"))
            continue;
        const lines = trimmed.split("\n").map((l) => l.trimEnd());
        // Line 0 is the H3 title; keep it as the fallback if no other
        // summary line is found.
        const h3Raw = lines[0] ?? "";
        const h3Line = h3Raw.replace(/^###\s+/, "").trim();
        let id;
        let summary;
        let tags;
        for (const raw of lines.slice(1)) {
            const line = raw.trim();
            if (!line)
                continue;
            // ID: `credentials/workspace-oauth`  (backticks optional)
            const idMatch = /^ID:\s*`?([^`\s]+)`?\s*$/i.exec(line);
            if (idMatch) {
                id = idMatch[1];
                continue;
            }
            // Tags: a, b, c
            const tagsMatch = /^Tags?:\s*(.+)$/i.exec(line);
            if (tagsMatch && tagsMatch[1]) {
                tags = tagsMatch[1]
                    .split(/[,;]/)
                    .map((t) => t.trim())
                    .filter((t) => t.length > 0);
                continue;
            }
            // Skip "Links to:" lines.
            if (/^Links to:/i.test(line))
                continue;
            // Anything else, on the first hit, becomes the summary.
            if (summary === undefined)
                summary = line;
        }
        if (!id)
            continue; // No id => not a real OKF block.
        const concept = { id };
        if (summary)
            concept.summary = summary;
        else if (h3Line)
            concept.summary = h3Line;
        if (tags && tags.length > 0)
            concept.tags = tags;
        results.push(concept);
    }
    return results;
}
/**
 * beta.23: per-session cache of the most recent OKF blocks parsed from
 * that session's context. Bounded to avoid unbounded growth on a
 * long-running gateway.
 */
export class OkfConceptCache {
    opts;
    entries = new Map();
    constructor(opts = {}) {
        this.opts = opts;
    }
    get maxSessions() {
        return this.opts.maxSessions ?? 256;
    }
    get ttlMs() {
        return this.opts.ttlMs ?? 15 * 60 * 1000;
    }
    now() {
        return this.opts.now ? this.opts.now() : Date.now();
    }
    set(sessionKey, concepts) {
        if (!sessionKey)
            return;
        // Delete first so re-set moves to insertion-order tail (LRU
        // behaviour).
        this.entries.delete(sessionKey);
        this.entries.set(sessionKey, { concepts, updatedAt: this.now() });
        // Evict oldest if over cap.
        while (this.entries.size > this.maxSessions) {
            const firstKey = this.entries.keys().next().value;
            if (firstKey === undefined)
                break;
            this.entries.delete(firstKey);
        }
    }
    get(sessionKey) {
        if (!sessionKey)
            return undefined;
        const entry = this.entries.get(sessionKey);
        if (!entry)
            return undefined;
        // TTL: silently expire stale entries.
        if (this.now() - entry.updatedAt > this.ttlMs) {
            this.entries.delete(sessionKey);
            return undefined;
        }
        // Refresh LRU position on read.
        this.entries.delete(sessionKey);
        this.entries.set(sessionKey, entry);
        return entry.concepts;
    }
    /** Number of currently-cached sessions. Exposed for tests + observability. */
    size() {
        return this.entries.size;
    }
    /** Clear all entries. Exposed for tests. */
    clear() {
        this.entries.clear();
    }
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
export function decideAutoForward(input) {
    const { toolName, params, cached } = input;
    if (toolName !== "harness_run" && toolName !== "harness_start_session") {
        return { inject: false };
    }
    if (!cached || cached.length === 0)
        return { inject: false };
    // `harness_run` accepts `relevantConcepts` at the root of its params.
    // `harness_start_session` accepts them under `brief.relevantConcepts`.
    const injectionSite = toolName === "harness_run" ? "root" : "brief";
    const p = (params ?? {});
    if (injectionSite === "root") {
        const existing = p.relevantConcepts;
        if (Array.isArray(existing) && existing.length > 0)
            return { inject: false };
    }
    else {
        const brief = (p.brief ?? {});
        const existing = brief.relevantConcepts;
        if (Array.isArray(existing) && existing.length > 0)
            return { inject: false };
    }
    return { inject: true, concepts: cached, injectionSite };
}
/**
 * beta.23: build the rewritten `params` for a `before_tool_call` return.
 * Immutable: constructs a new object rather than mutating `params`.
 */
export function buildRewrittenParams(toolName, params, concepts) {
    const p = (params ?? {});
    if (toolName === "harness_run") {
        return { ...p, relevantConcepts: concepts };
    }
    if (toolName === "harness_start_session") {
        const brief = { ...(p.brief ?? {}) };
        brief.relevantConcepts = concepts;
        return { ...p, brief };
    }
    return p;
}
/**
 * beta.23: pick a stable cache key from a hook event's context. Prefers
 * `sessionKey` (stable across turns) but falls back to `sessionId` if
 * that's all we have. Empty string when neither is present, which the
 * cache treats as "don't store".
 */
export function cacheKeyForCtx(ctx) {
    const c = (ctx ?? {});
    if (typeof c.sessionKey === "string" && c.sessionKey.length > 0)
        return c.sessionKey;
    if (typeof c.sessionId === "string" && c.sessionId.length > 0)
        return c.sessionId;
    return "";
}
//# sourceMappingURL=okf-auto-forward.js.map