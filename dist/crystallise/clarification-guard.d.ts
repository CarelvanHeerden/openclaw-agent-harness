/**
 * Grounding guard for clarification questions.
 *
 * rc.2, observed failure. A user named the repository "StitchGuard", said
 * "checkout latest main", and asked for a PR against main. The harness replied:
 *
 *   "Should I implement this in `/home/node/.openclaw/workspace/Stitch-Vercel/
 *    StitchGuard` and update the existing worktree to `origin/main`, preserving
 *    any uncommitted changes?"
 *
 * Every concrete noun in that sentence was fabricated. The path did not exist,
 * no session was active, there was no worktree and nothing uncommitted to
 * preserve. And the premise was wrong too: basing a branch on the latest
 * `origin/main` and opening a PR against `main` are the same ordinary workflow,
 * not a fork someone has to choose between.
 *
 * The cause is structural rather than a bad model day. The classifier and the
 * crystalliser are handed the raw request and NOTHING else -- no allow-list, no
 * session row, no worktree, no filesystem access (their tool lists are empty).
 * So when a prompt asks them for "ONE crisp question naming the fork", any
 * specific detail in that question is necessarily invented; the model has no
 * source for it. Asking the models to be more careful does not change what they
 * were given, which is why the prompt hardening in claude-code.ts is paired
 * with this deterministic check rather than trusted on its own.
 *
 * The rule this encodes: a clarification may only assert repository state the
 * harness has actually verified. For a new run the harness has verified none,
 * so any such assertion is withheld. Withholding is safe -- the request
 * continues down the normal path, which fetches the remote and allocates a
 * fresh worktree, which is what the question was fumbling toward anyway.
 */
/** Why the harness is asking. Recorded on every clarification it surfaces. */
export type ClarificationReason = 
/** A short repository name matched more than one entry in `repos.allowed`. */
"repository_ambiguous"
/** No base branch could be determined from config or the request. */
 | "base_branch_unknown"
/** A VERIFIED continuation genuinely conflicts with what was asked. */
 | "verified_continuation_conflict"
/** A real fork in what would be built. The ordinary bimodality pause. */
 | "substantive_ambiguity";
/** Why a model-proposed clarification was withheld from the user. */
export type SuppressionReason = 
/** Named an absolute filesystem path the harness never established. */
"invented_filesystem_path"
/** Claimed a worktree, checkout or uncommitted work that is not verified. */
 | "unverified_worktree_state"
/** Asked the human to decide checkout mechanics the harness owns. */
 | "harness_owned_checkout";
/**
 * Continuation state read from the session row and CHECKED against the
 * filesystem -- not a plan's recollection of where a worktree used to be.
 *
 * Absent for a new run, which is the case the defect got wrong.
 */
export interface VerifiedContinuation {
    sessionId: string;
    repo: string;
    branch: string;
    worktreePath: string;
}
export interface ClarificationGrounding {
    /** `repos.allowed`, verbatim. */
    allowedRepos: string[];
    /**
     * The branch a new run bases on. Known from `repos.default_base_branch` in
     * every shipped configuration, so `base_branch_unknown` is close to
     * unreachable; it exists so the reason code is available rather than the
     * harness inventing a base.
     */
    defaultBaseBranch?: string;
    /** Only present for an explicit, verified continuation. */
    continuation?: VerifiedContinuation;
}
export type GuardVerdict = {
    action: "ask";
    question: string;
    reason: ClarificationReason;
} | {
    action: "withhold";
    question: string;
    suppressed: SuppressionReason[];
};
/** Absolute paths in the text that the harness has not verified. */
export declare function unverifiedPathsIn(text: string, g: ClarificationGrounding): string[];
/**
 * True when the question asserts repository state nobody established.
 *
 * A verified continuation earns the right to discuss its own worktree: the
 * whole point of the resume flow is asking whether to keep work that provably
 * exists.
 */
export declare function claimsUnverifiedState(text: string, g: ClarificationGrounding): boolean;
/**
 * True when the question presents "base on latest main" and "PR against main"
 * as if the requester had to choose.
 *
 * They are the same instruction seen from two ends: a branch is cut from the
 * latest `origin/main` and merges back into `main`. Requiring both branch names
 * to match keeps a genuine question -- basing on `main` while targeting
 * `release/1.4` -- askable.
 */
export declare function isFalseBaseConflict(text: string): boolean;
/**
 * Decide whether a proposed clarification may reach the user.
 *
 * Withholding does not discard the request. The caller continues down the
 * ordinary path, which is the correct handling of a question whose only content
 * was a guess at mechanics the harness performs the same way every time.
 */
export declare function guardClarification(question: string, grounding: ClarificationGrounding, reason: ClarificationReason): GuardVerdict;
/**
 * The grounding block both model roles receive.
 *
 * Two jobs. It supplies the facts that make the common clarifications
 * unnecessary -- the allow-list, so a bare repository name resolves, and the
 * checkout policy, so "latest main" is recognised as the default rather than a
 * decision. And it states plainly that the model has no filesystem knowledge,
 * because the failure was not the model reasoning badly from what it had; it
 * was the model furnishing detail it was never given.
 */
export declare function renderGroundingBlock(g: ClarificationGrounding): string;
//# sourceMappingURL=clarification-guard.d.ts.map