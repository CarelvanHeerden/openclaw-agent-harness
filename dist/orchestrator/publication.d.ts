/**
 * rc.5 (#2): PUBLICATION EVIDENCE — proving a commit reached the remote.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 * -------------------------------
 * Stitch-Vercel/StitchGuard PR #1168 (2026-09-10). Two revision sessions built
 * 24 and 11 local commits respectively, ended with review verdict `revise`, and
 * were recorded as SHIPPED. GitHub received neither history. Their worktrees
 * were then released, so the only copy of 35 commits was deleted, and the next
 * revision started from the stale remote implementation.
 *
 * The chain was entirely inside the harness:
 *   1. Preview verification was enabled.
 *   2. The preview push ran ONLY for review verdict `pass` (a `revise` verdict
 *      therefore never pushed anything).
 *   3. Finalisation nonetheless selected `openPullRequest` whenever preview
 *      verification was ENABLED -- a flag about configuration, read as if it
 *      were a fact about what had happened.
 *   4. `openPullRequest` creates/finds the PR and posts the review comment. It
 *      does not push. On a revision the PR already existed, so it succeeded.
 *   5. Finalisation took that success as publication, polled CI on the LOCAL
 *      worktree HEAD, found nothing red about a SHA GitHub had never seen, and
 *      recorded `loop.shipped`.
 *
 * THE RULE
 * --------
 * Publication is a fact about the REMOTE, and the only thing that establishes
 * it is reading the remote back. Not a config flag, not a resolved callback,
 * not an existing PR URL, not a posted review comment, not a local branch name.
 * Every one of those was true for #1168.
 *
 * So publication evidence is minted in exactly one place -- {@link verifyRemoteSha}
 * observing the expected SHA at the branch tip -- and it names the SHA it
 * covers. Evidence for one SHA says nothing about another, which is what makes
 * a HEAD change after publication (the harness authors a CI workflow and
 * commits it) invalidating rather than invisible.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It never pushes, force-pushes, or mutates a remote. It reads. The caller
 * decides what to do about a `remote_mismatch`, and "overwrite it" is not
 * among the options -- a tip that is neither the old nor the expected SHA is
 * somebody else's work.
 */
/**
 * Why a candidate could not be proven published. Every one of these is a
 * REFUSAL to claim publication, never a downgrade to a warning.
 */
export type PublicationFailureKind = 
/** The remote branch does not exist, or has no tip. */
"remote_missing"
/** The remote branch exists and points at a DIFFERENT commit. */
 | "remote_mismatch"
/** The remote could not be read at all (network, credentials, no probe). */
 | "verification_unavailable"
/** We never resolved a candidate SHA, so there is nothing to verify. */
 | "candidate_unknown";
/**
 * Proof that `sha` was observed at `repo`'s `branch` tip on the remote.
 *
 * Deliberately carries the SHA rather than a boolean: a `published: true` flag
 * is precisely the shape of state that let #1168 attribute one commit's
 * (non-)publication to another.
 */
export interface PublicationEvidence {
    /** The exact commit observed on the remote branch tip. */
    sha: string;
    branch: string;
    repo: string;
    /** Epoch ms of the observation. Evidence is a reading, and readings age. */
    verifiedAt: number;
    /** How the SHA got there: a push this run made, or one already present. */
    via: "pushed" | "already_present";
}
export interface RemoteVerifyOk {
    ok: true;
    observedSha: string;
    /** How many reads it took. >1 means we rode out provider metadata lag. */
    attempts: number;
}
export interface RemoteVerifyFailure {
    ok: false;
    kind: PublicationFailureKind;
    /** The tip we actually saw, when we saw one. Absent means unreadable. */
    observedSha?: string;
    attempts: number;
    /** Operator-facing one-liner. Always names the expected SHA. */
    detail: string;
}
export type RemoteVerifyResult = RemoteVerifyOk | RemoteVerifyFailure;
/** Default bounded-revalidation budget. Short: this covers metadata lag, not an outage. */
export declare const DEFAULT_VERIFY_ATTEMPTS = 4;
export declare const DEFAULT_VERIFY_DELAY_MS = 1500;
/** Two SHAs of possibly different abbreviation lengths naming the same commit. */
export declare function shaMatches(a: string | undefined, b: string | undefined): boolean;
/**
 * Read the remote branch tip until it equals `expectedSha`, up to a bounded
 * number of attempts.
 *
 * The retry exists for ONE observed phenomenon, seen during the #1168 recovery:
 * GitHub's PR metadata can briefly lag a successful git push, so the first read
 * disagreed with the ref that had demonstrably just landed and both subsequent
 * reads agreed. It is NOT a retry for "the push might work if we try again" --
 * this function never pushes, and a caller must not treat a bounded failure as
 * a cue to push blindly.
 *
 * Cancellable via `signal`, so a run being torn down does not sit here.
 */
export declare function verifyRemoteSha(params: {
    expectedSha: string;
    branch: string;
    repo: string;
    /** Reads the true remote tip. Resolve `undefined` for "no such branch". */
    readRemoteSha: () => Promise<string | undefined>;
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: {
        aborted: boolean;
    };
}): Promise<RemoteVerifyResult>;
/**
 * Does `evidence` prove THIS candidate is already on the remote?
 *
 * The SHA comparison is the whole point. #1168's finalisation asked "is preview
 * mode on?"; the question that matters is "is the commit I am about to call
 * shipped the commit somebody proved was pushed?".
 */
export declare function evidenceCoversCandidate(evidence: PublicationEvidence | null | undefined, candidateSha: string, branch?: string): boolean;
/**
 * The operator-facing terminal message for work that was NOT published.
 *
 * Written to be unmistakable, because the failure it replaces reported the
 * same situation as "shipped". It names the SHA to look for, the branch, and
 * the worktree that still holds the commits.
 */
export declare function describeUnpublished(input: {
    kind: PublicationFailureKind;
    expectedSha: string;
    observedSha?: string;
    branch: string;
    repo: string;
    worktreePath?: string;
    prUrl?: string;
    detail: string;
}): string;
/**
 * One line for the terminal summary, keeping the three states that #1168
 * collapsed into one distinct: published is not approved, and unpublished is
 * not shipped.
 */
export declare function describePublicationState(input: {
    published: boolean;
    verdict?: string;
    sha?: string;
}): string;
//# sourceMappingURL=publication.d.ts.map