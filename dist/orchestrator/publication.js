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
/** Default bounded-revalidation budget. Short: this covers metadata lag, not an outage. */
export const DEFAULT_VERIFY_ATTEMPTS = 4;
export const DEFAULT_VERIFY_DELAY_MS = 1500;
/**
 * A commit id we are willing to reason about. The 7-character floor is the
 * load-bearing part: comparing two SHAs on a shorter common prefix would let
 * unrelated commits "match", and the entire publication check is a SHA
 * comparison.
 */
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Two SHAs of possibly different abbreviation lengths naming the same commit. */
export function shaMatches(a, b) {
    if (!a || !b)
        return false;
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    if (!SHA_RE.test(x) || !SHA_RE.test(y))
        return false;
    // Both sides passed SHA_RE, so the shared prefix is at least 7 characters --
    // short enough to be an abbreviation, long enough to identify a commit.
    const n = Math.min(x.length, y.length);
    return x.slice(0, n) === y.slice(0, n);
}
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
export async function verifyRemoteSha(params) {
    const expected = params.expectedSha?.trim() ?? "";
    if (!expected || !SHA_RE.test(expected)) {
        return {
            ok: false,
            kind: "candidate_unknown",
            attempts: 0,
            detail: `cannot verify publication: no candidate SHA was resolved (got ${JSON.stringify(params.expectedSha ?? "")})`,
        };
    }
    const maxAttempts = Math.max(1, params.attempts ?? DEFAULT_VERIFY_ATTEMPTS);
    const delayMs = Math.max(0, params.delayMs ?? DEFAULT_VERIFY_DELAY_MS);
    const sleep = params.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let observed;
    let lastError = "";
    let attempts = 0;
    for (let i = 0; i < maxAttempts; i++) {
        if (params.signal?.aborted)
            break;
        attempts = i + 1;
        try {
            observed = (await params.readRemoteSha())?.trim() || undefined;
            lastError = "";
            if (shaMatches(observed, expected)) {
                return { ok: true, observedSha: observed, attempts };
            }
        }
        catch (err) {
            observed = undefined;
            lastError = String(err?.message ?? err);
        }
        if (i < maxAttempts - 1 && !params.signal?.aborted && delayMs > 0) {
            await sleep(delayMs);
        }
    }
    const where = `${params.repo}@${params.branch}`;
    if (lastError) {
        return {
            ok: false,
            kind: "verification_unavailable",
            attempts,
            detail: `could not read the remote tip of ${where} to confirm ${expected} after ${attempts} attempt(s): ${lastError}`,
        };
    }
    if (!observed) {
        return {
            ok: false,
            kind: "remote_missing",
            attempts,
            detail: `${where} has no remote tip, so ${expected} is NOT published (after ${attempts} attempt(s))`,
        };
    }
    return {
        ok: false,
        kind: "remote_mismatch",
        observedSha: observed,
        attempts,
        detail: `${where} points at ${observed}, not the candidate ${expected} (after ${attempts} attempt(s))`,
    };
}
/**
 * Does `evidence` prove THIS candidate is already on the remote?
 *
 * The SHA comparison is the whole point. #1168's finalisation asked "is preview
 * mode on?"; the question that matters is "is the commit I am about to call
 * shipped the commit somebody proved was pushed?".
 */
export function evidenceCoversCandidate(evidence, candidateSha, branch) {
    if (!evidence)
        return false;
    if (branch !== undefined && evidence.branch !== branch)
        return false;
    return shaMatches(evidence.sha, candidateSha);
}
/**
 * The operator-facing terminal message for work that was NOT published.
 *
 * Written to be unmistakable, because the failure it replaces reported the
 * same situation as "shipped". It names the SHA to look for, the branch, and
 * the worktree that still holds the commits.
 */
export function describeUnpublished(input) {
    const lines = [
        `NOT PUBLISHED — the harness could not prove ${input.repo}@${input.branch} contains this run's work.`,
        ``,
        `This run is NOT shipped. ${input.detail}`,
        ``,
        `  candidate commit : ${input.expectedSha || "(unresolved)"}`,
        `  remote tip       : ${input.observedSha ?? "(unreadable / absent)"}`,
        `  branch           : ${input.branch}`,
    ];
    if (input.worktreePath) {
        lines.push(`  worktree (KEPT)  : ${input.worktreePath}`);
    }
    if (input.prUrl) {
        // A PR can exist and still describe none of this run's commits -- that is
        // exactly how #1168 looked from the outside.
        lines.push(`  existing PR      : ${input.prUrl} (does NOT contain the candidate above)`);
    }
    lines.push(``);
    switch (input.kind) {
        case "remote_mismatch":
            lines.push(`The branch tip is a commit the harness did not publish. It may be concurrent work.`, `The harness will NEVER force-push over it. Inspect both commits and reconcile by hand.`);
            break;
        case "remote_missing":
            lines.push(`The branch does not exist on the remote. Nothing from this run reached it.`);
            break;
        case "verification_unavailable":
            lines.push(`The remote could not be read, so publication is UNKNOWN, not assumed.`, `Check credentials/network, then read the branch before deciding whether to push.`);
            break;
        case "candidate_unknown":
            lines.push(`No candidate commit was resolved, so there is nothing to verify or publish.`);
            break;
    }
    lines.push(``, `The commits are preserved. Recover them with:`, `  git -C ${input.worktreePath ?? "<worktree>"} log --oneline origin/${input.branch}..HEAD`, `  git -C ${input.worktreePath ?? "<worktree>"} push origin ${input.branch}`);
    return lines.join("\n");
}
/**
 * One line for the terminal summary, keeping the three states that #1168
 * collapsed into one distinct: published is not approved, and unpublished is
 * not shipped.
 */
export function describePublicationState(input) {
    if (!input.published) {
        return "UNPUBLISHED — this run's commits are not on the remote; it is not shipped.";
    }
    const at = input.sha ? ` (${input.sha})` : "";
    return input.verdict === "pass"
        ? `PUBLISHED${at} and the review passed. Published is not merged -- CI and human approval still apply.`
        : `PUBLISHED${at} for review with an unchanged '${input.verdict ?? "revise"}' verdict and its blocking findings. Published is NOT approved: do NOT merge.`;
}
//# sourceMappingURL=publication.js.map