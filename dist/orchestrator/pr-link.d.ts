/**
 * rc.4: deciding whether an existing pull request really is the one a failed
 * session produced.
 *
 * A session writes `pr_number` on the ship path only. StitchGuard session
 * `112673df` pushed nine commits, opened PR #1168, and then failed before that
 * column was written -- so the harness held a session with no PR and a PR with
 * no session, and the only supported way to change PR #1168 was to build the
 * feature again.
 *
 * The obvious repair is to match on the branch name, which even encodes the
 * session id (`harness/sast-sheet-source-code-dashboard-112673df`). That is
 * exactly the check not to trust: a branch name is a string anyone can push,
 * it survives a force-push that replaced every commit under it, and it is
 * equally true of a fork pointing a same-named branch at unrelated work. What
 * makes a PR *this session's* PR is that the session's own commits are in it.
 *
 * So this module is deliberately pure and deliberately unforgiving. It takes
 * what the session recorded and what the provider says right now, and returns
 * either the evidence or the blockers. Anything it cannot establish is a
 * blocker: there is no path through here that treats missing evidence as
 * permission, because the operator asking for the link is the same person who
 * would be reassured by a false yes.
 */
/** What the session recorded about its own work, read from `sessions`/`sub_tasks`. */
export interface LinkSessionFacts {
    sessionId: string;
    /** `owner/name`, as the session ran against. */
    repo: string;
    /** The branch the session pushed to. */
    branch: string;
    /** Fork point captured at plan_ready. NULL on sessions that never planned. */
    planBaseSha: string | null;
    /** Every commit sha the sub-task ledger recorded for this session. */
    ledgerCommitShas: string[];
    /** Already-linked PR, if any. Set by a previous link or by an ordinary ship. */
    existingPrNumber: number | null;
    /** 'recovered' when a previous link wrote it; NULL when the loop opened the PR. */
    existingLinkState: string | null;
}
/** Authoritative provider metadata. Every field comes from the API, not from git. */
export interface LinkPrFacts {
    /** `owner/name` of the repository the PR lives in. */
    repo: string;
    number: number;
    /** `owner/name` of the HEAD repository. Differs from `repo` on a fork PR. */
    headRepo: string | null;
    headRef: string;
    headSha: string;
    baseRef: string;
    /** 'open' | 'closed'. */
    state: string;
    merged: boolean;
    draft: boolean;
    htmlUrl: string;
    /** Every commit sha on the PR, oldest first. */
    commitShas: string[];
    /** Merge base of head and base, when the provider could compute it. */
    mergeBaseSha: string | null;
}
export interface LinkVerification {
    ok: boolean;
    /** Human-readable lines describing what was checked and what was found. */
    evidence: string[];
    /** Machine-readable reasons the link was refused. Empty iff `ok`. */
    blockers: LinkBlocker[];
    /** True when this exact association is already recorded; applying is a no-op. */
    alreadyLinked: boolean;
    /** The commit shas the session recorded that were found on the PR. */
    matchedCommitShas: string[];
}
export interface LinkBlocker {
    kind: "repo_mismatch" | "head_repo_mismatch" | "branch_mismatch" | "base_mismatch" | "not_open" | "merged" | "no_session_commits" | "lineage_mismatch" | "base_sha_mismatch" | "conflicting_link";
    message: string;
}
/**
 * Decide whether `pr` is the pull request `session` produced.
 *
 * `expectedBaseRef` is the base branch the harness would have opened against
 * (`repos.default_base_branch`). A PR targeting something else is not
 * necessarily wrong, but it is not what this session would have produced, and
 * a revision pushed onto it would be reviewed against the wrong base.
 */
export declare function verifyPrLink(session: LinkSessionFacts, pr: LinkPrFacts, expectedBaseRef: string): LinkVerification;
/**
 * Just enough of `node:sqlite` for this module. `changes` is `number | bigint`
 * on `DatabaseSync`; only "did anything change" is ever asked of it.
 */
export interface LinkDb {
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
        run(...params: unknown[]): {
            changes: number | bigint;
        };
    };
}
export interface LinkPrDeps {
    db: LinkDb;
    audit: (event: string, payload: Record<string, unknown>, sessionId?: string) => void;
    /** Slack user ids permitted to link. */
    authorisedUsers: string[];
    /** `repos.default_base_branch`. */
    defaultBaseBranch: string;
    /**
     * Authoritative provider read. Throws when the PR cannot be read, which is
     * treated as absence of evidence rather than as a mismatch.
     */
    fetchPr: (args: {
        repo: string;
        prNumber: number;
        requester: string;
    }) => Promise<{
        headRepo: string | null;
        headRef: string;
        headSha: string;
        baseRef: string;
        state: string;
        merged: boolean;
        draft: boolean;
        htmlUrl: string;
        commitShas: string[];
        /** True when the commit list could not be read to the end. */
        commitsTruncated: boolean;
        mergeBaseSha: string | null;
    }>;
    now?: () => number;
}
export interface LinkPrArgs {
    sessionId: string;
    /** `owner/name`. Required: a PR number alone is ambiguous across repositories. */
    repo: string;
    prNumber: number;
    invokedBy: string;
    /** Default false -- a read-only dry run. */
    apply?: boolean;
    /** Required when `apply` is true; must equal the PR head the dry run saw. */
    expectedHeadSha?: string;
}
export interface LinkPrOutcome {
    ok: boolean;
    dryRun: boolean;
    applied?: boolean;
    alreadyLinked?: boolean;
    unauthorised?: boolean;
    sessionId?: string;
    repo?: string;
    prNumber?: number;
    prUrl?: string;
    headSha?: string;
    evidence?: string[];
    blockers?: {
        kind: string;
        message: string;
    }[];
    message: string;
}
export declare function linkPullRequest(deps: LinkPrDeps, args: LinkPrArgs): Promise<LinkPrOutcome>;
/** Render a verification for a human, as the tool's text body. */
export declare function renderLinkVerification(v: LinkVerification, session: LinkSessionFacts, pr: LinkPrFacts, mode: "dry_run" | "applied"): string;
//# sourceMappingURL=pr-link.d.ts.map