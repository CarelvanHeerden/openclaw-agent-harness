import { isRepositoryAllowed } from "../repository-allowlist.js";
/** `owner/repo` with no glob segment -- something we can actually clone. */
function isConcrete(entry) {
    return entry.includes("/") && !entry.includes("*");
}
function basenameOf(entry) {
    return entry.slice(entry.lastIndexOf("/") + 1);
}
/** Case and separator folded, so `stitch-guard` still finds `StitchGuard`. */
function fold(s) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
/**
 * Reduce whatever the model put in `repoHint` to a repository NAME.
 *
 * The same models that invented a worktree path can put one here, and a hint
 * containing a slash used to be forwarded verbatim -- straight into the
 * requester preflight, which would go looking for a PAT for an "owner" called
 * `workspace`. A URL is the same problem wearing a different hat.
 *
 * `wasLocator` reports that the hint was a path or URL rather than a plain
 * name. It matters downstream: a plain `attacker/evil` must stay intact so the
 * allow-list gate can reject it by name and say so, whereas a locator is
 * already mangled and its trailing segments are only a guess worth re-checking.
 */
function normaliseHint(raw) {
    const cleaned = raw.replace(/[`'"<>]/g, "").trim();
    const url = /^(?:https?:\/\/|git@)[^/:]+[/:]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(cleaned);
    if (url)
        return { hint: url[1], wasLocator: true };
    const trimmed = cleaned.replace(/\.git$/i, "").replace(/[/\\]+$/, "");
    if (/^(?:~|\/|[A-Za-z]:\\|\.\.?\/)/.test(trimmed)) {
        const segs = trimmed.split(/[/\\]/).filter((s) => s && s !== "." && s !== "..");
        if (segs.length >= 2)
            return { hint: `${segs[segs.length - 2]}/${segs[segs.length - 1]}`, wasLocator: true };
        return { hint: segs[segs.length - 1] ?? "", wasLocator: true };
    }
    return { hint: trimmed, wasLocator: false };
}
/** `owner/repo` exactly, or covered by an `owner/*` glob. Mirrors `isRepoAllowed`. */
function allowedBy(repoFullName, allowed) {
    return isRepositoryAllowed(repoFullName, allowed);
}
/**
 * Turn whatever the requester called the repository into one allowed entry.
 *
 * Matching runs in decreasing strictness and STOPS at the first tier that
 * matches anything. Tiers do not pool: if `Stitch-Vercel/StitchGuard` matches
 * exactly, a looser tier finding `other/stitch_guard` too must not turn a
 * decided answer into an ambiguous one.
 *
 * Glob entries (`owner/*`) can never match a bare name -- the glob does not
 * tell us which repositories exist under that owner, and inventing one is the
 * failure mode this module exists to prevent.
 */
export function resolveRepoAlias(hint, allowed) {
    const rawTrimmed = (hint ?? "").trim();
    if (!rawTrimmed)
        return { kind: "unresolved" };
    const all = (allowed ?? []).map((r) => (r ?? "").trim()).filter(Boolean);
    const entries = all.filter(isConcrete);
    const { hint: raw, wasLocator } = normaliseHint(rawTrimmed);
    if (!raw)
        return { kind: "unresolved" };
    if (raw.includes("/")) {
        // A plain `owner/repo` is taken at its word. Allow-list enforcement stays
        // where it always was (`isRepoAllowed` at plan validation), which reports a
        // disallowed repository by name instead of silently losing it here.
        if (!wasLocator)
            return { kind: "resolved", repo: raw, via: "explicit" };
        // A locator's trailing segments are a guess. Trust them only if they name
        // something the operator actually allowed; otherwise fall through and match
        // the basename, which is how `/home/node/workspace/StitchGuard` still finds
        // `Stitch-Vercel/StitchGuard`.
        if (allowedBy(raw, all))
            return { kind: "resolved", repo: raw, via: "explicit" };
    }
    if (entries.length === 0)
        return { kind: "unresolved" };
    const name = raw.slice(raw.lastIndexOf("/") + 1);
    const tiers = [
        (entry) => basenameOf(entry) === name,
        (entry) => basenameOf(entry).toLowerCase() === name.toLowerCase(),
        (entry) => fold(basenameOf(entry)) === fold(name),
    ];
    for (const matches of tiers) {
        const hits = entries.filter(matches);
        if (hits.length === 1)
            return { kind: "resolved", repo: hits[0], via: "alias" };
        if (hits.length > 1)
            return { kind: "ambiguous", hint: name, candidates: hits };
    }
    return { kind: "unresolved" };
}
/**
 * The one question worth asking when a short name is genuinely ambiguous.
 *
 * Names the candidates and nothing else. Per the rc.2 brief: when several
 * allowed repositories match, ask ONLY which repository -- do not offer a local
 * path or a worktree, both of which the harness has not looked at and does not
 * need the human to choose.
 *
 * Lettered options match the house style used by the bimodality clarification
 * so the two read the same in Slack.
 */
export function renderRepoAmbiguityQuestion(hint, candidates) {
    const lettered = candidates
        .map((c, i) => `(${String.fromCharCode(97 + i)}) ${c}`)
        .join("  ");
    return `Which repository do you mean by "${hint}"?  ${lettered}`;
}
//# sourceMappingURL=repo-alias.js.map