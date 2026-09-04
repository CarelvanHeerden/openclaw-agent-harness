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
{
    kind: "resolved";
    repo: string;
    via: "explicit" | "alias";
}
/** The short name matched more than one allowed repository. */
 | {
    kind: "ambiguous";
    hint: string;
    candidates: string[];
}
/** Nothing to go on, or nothing matched. The lead picks, as before. */
 | {
    kind: "unresolved";
};
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
export declare function resolveRepoAlias(hint: string | undefined, allowed: string[]): RepoResolution;
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
export declare function renderRepoAmbiguityQuestion(hint: string, candidates: string[]): string;
//# sourceMappingURL=repo-alias.d.ts.map