/**
 * Deterministic repository-name resolution.
 *
 * rc.2: a user wrote "StitchGuard" and the harness could not turn that into
 * `Stitch-Vercel/StitchGuard`, even though `repos.allowed` named exactly one
 * repository with that basename. Nothing in `src/` did short-name matching:
 * `resolveScoutRepo` accepted a hint only when it already contained a slash,
 * and otherwise fell back to the allow-list only when the WHOLE list was a
 * single concrete entry. So a perfectly unambiguous name was treated as a
 * missing one, and the classifier's "MISSING which repo" trigger fired.
 *
 * The clarification that followed invented a filesystem path and a worktree to
 * ask about. The invention is fixed elsewhere (clarification-guard.ts); this
 * module removes the reason the question was asked at all.
 *
 * Deliberately deterministic. Repository identity is a lookup against operator
 * configuration, and a model guessing at it is how a run ends up pointed at the
 * wrong codebase -- a failure that looks identical to success from inside the
 * harness until the PR opens somewhere unexpected.
 */

/** What a hint resolved to, and how. */
export type RepoResolution =
  /** Exactly one allowed repository matched. */
  | { kind: "resolved"; repo: string; via: "explicit" | "alias" }
  /** The short name matched more than one allowed repository. */
  | { kind: "ambiguous"; hint: string; candidates: string[] }
  /** Nothing to go on, or nothing matched. The lead picks, as before. */
  | { kind: "unresolved" };

/** `owner/repo` with no glob segment -- something we can actually clone. */
function isConcrete(entry: string): boolean {
  return entry.includes("/") && !entry.includes("*");
}

function basenameOf(entry: string): string {
  return entry.slice(entry.lastIndexOf("/") + 1);
}

/** Case and separator folded, so `stitch-guard` still finds `StitchGuard`. */
function fold(s: string): string {
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
function normaliseHint(raw: string): { hint: string; wasLocator: boolean } {
  const cleaned = raw.replace(/[`'"<>]/g, "").trim();

  const url = /^(?:https?:\/\/|git@)[^/:]+[/:]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(cleaned);
  if (url) return { hint: url[1]!, wasLocator: true };

  const trimmed = cleaned.replace(/\.git$/i, "").replace(/[/\\]+$/, "");
  if (/^(?:~|\/|[A-Za-z]:\\|\.\.?\/)/.test(trimmed)) {
    const segs = trimmed.split(/[/\\]/).filter((s) => s && s !== "." && s !== "..");
    if (segs.length >= 2) return { hint: `${segs[segs.length - 2]}/${segs[segs.length - 1]}`, wasLocator: true };
    return { hint: segs[segs.length - 1] ?? "", wasLocator: true };
  }
  return { hint: trimmed, wasLocator: false };
}

/** `owner/repo` exactly, or covered by an `owner/*` glob. Mirrors `isRepoAllowed`. */
function allowedBy(repoFullName: string, entries: string[], allowed: string[]): boolean {
  if (entries.includes(repoFullName)) return true;
  const owner = repoFullName.split("/")[0]!;
  return allowed.some((glob) => glob.endsWith("/*") && glob.slice(0, -2) === owner);
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
export function resolveRepoAlias(hint: string | undefined, allowed: string[]): RepoResolution {
  const rawTrimmed = (hint ?? "").trim();
  if (!rawTrimmed) return { kind: "unresolved" };

  const all = (allowed ?? []).map((r) => (r ?? "").trim()).filter(Boolean);
  const entries = all.filter(isConcrete);
  const { hint: raw, wasLocator } = normaliseHint(rawTrimmed);
  if (!raw) return { kind: "unresolved" };

  if (raw.includes("/")) {
    // A plain `owner/repo` is taken at its word. Allow-list enforcement stays
    // where it always was (`isRepoAllowed` at plan validation), which reports a
    // disallowed repository by name instead of silently losing it here.
    if (!wasLocator) return { kind: "resolved", repo: raw, via: "explicit" };
    // A locator's trailing segments are a guess. Trust them only if they name
    // something the operator actually allowed; otherwise fall through and match
    // the basename, which is how `/home/node/workspace/StitchGuard` still finds
    // `Stitch-Vercel/StitchGuard`.
    if (allowedBy(raw, entries, all)) return { kind: "resolved", repo: raw, via: "explicit" };
  }

  if (entries.length === 0) return { kind: "unresolved" };
  const name = raw.slice(raw.lastIndexOf("/") + 1);

  const tiers: Array<(entry: string) => boolean> = [
    (entry) => basenameOf(entry) === name,
    (entry) => basenameOf(entry).toLowerCase() === name.toLowerCase(),
    (entry) => fold(basenameOf(entry)) === fold(name),
  ];

  for (const matches of tiers) {
    const hits = entries.filter(matches);
    if (hits.length === 1) return { kind: "resolved", repo: hits[0]!, via: "alias" };
    if (hits.length > 1) return { kind: "ambiguous", hint: name, candidates: hits };
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
export function renderRepoAmbiguityQuestion(hint: string, candidates: string[]): string {
  const lettered = candidates
    .map((c, i) => `(${String.fromCharCode(97 + i)}) ${c}`)
    .join("  ");
  return `Which repository do you mean by "${hint}"?  ${lettered}`;
}
