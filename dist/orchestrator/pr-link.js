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
/** Provider shas are hex; compare case-insensitively and tolerate abbreviation. */
function sameSha(a, b) {
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    if (!x || !y)
        return false;
    const short = x.length <= y.length ? x : y;
    const long = short === x ? y : x;
    // A 7-char abbreviation is a legitimate way to record a sha, but anything
    // shorter is not evidence of anything.
    if (short.length < 7)
        return false;
    return long.startsWith(short);
}
/** Repo full names are case-insensitive on GitHub; nothing else about them is. */
function sameRepo(a, b) {
    if (!a || !b)
        return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}
/**
 * Decide whether `pr` is the pull request `session` produced.
 *
 * `expectedBaseRef` is the base branch the harness would have opened against
 * (`repos.default_base_branch`). A PR targeting something else is not
 * necessarily wrong, but it is not what this session would have produced, and
 * a revision pushed onto it would be reviewed against the wrong base.
 */
export function verifyPrLink(session, pr, expectedBaseRef) {
    const blockers = [];
    const evidence = [];
    // A repeat of the identical request is a no-op, not a conflict. It is checked
    // first so an operator retrying after a dropped connection reads "already
    // linked" rather than a wall of re-verification.
    const alreadyLinked = session.existingPrNumber === pr.number && sameRepo(session.repo, pr.repo);
    if (!sameRepo(session.repo, pr.repo)) {
        blockers.push({
            kind: "repo_mismatch",
            message: `Session ${session.sessionId} ran against ${session.repo}, but the PR is in ${pr.repo}. A PR number means nothing across repositories.`,
        });
    }
    else {
        evidence.push(`Repository matches: ${pr.repo}.`);
    }
    // A fork PR has a head the harness cannot push to, so a revision would
    // silently open a second PR instead of updating this one.
    if (!sameRepo(pr.headRepo, pr.repo)) {
        blockers.push({
            kind: "head_repo_mismatch",
            message: `PR #${pr.number} is from a fork (head repository ${pr.headRepo ?? "unknown"}, not ${pr.repo}). The harness cannot push revisions to a fork head.`,
        });
    }
    else {
        evidence.push(`Head repository is the same repository, not a fork.`);
    }
    if (pr.headRef.trim() !== session.branch.trim()) {
        blockers.push({
            kind: "branch_mismatch",
            message: `PR #${pr.number} head branch is '${pr.headRef}', but session ${session.sessionId} pushed '${session.branch}'.`,
        });
    }
    else {
        evidence.push(`Head branch matches the session branch: ${pr.headRef}.`);
    }
    if (pr.baseRef.trim() !== expectedBaseRef.trim()) {
        blockers.push({
            kind: "base_mismatch",
            message: `PR #${pr.number} targets base '${pr.baseRef}', but this repository's harness base is '${expectedBaseRef}'. A revision would be reviewed against the wrong base.`,
        });
    }
    else {
        evidence.push(`Base branch matches the configured harness base: ${pr.baseRef}.`);
    }
    if (pr.merged) {
        blockers.push({
            kind: "merged",
            message: `PR #${pr.number} is already merged. There is nothing for a revision to update.`,
        });
    }
    else if (pr.state.trim().toLowerCase() !== "open") {
        blockers.push({
            kind: "not_open",
            message: `PR #${pr.number} is ${pr.state}. Reopen it before linking; the harness will not reopen a PR on an operator's behalf.`,
        });
    }
    else {
        // A draft PR is open and pushable, which is all a revision needs. Say so
        // rather than staying silent, because "draft" reads like a blocker.
        evidence.push(`PR is open and unmerged${pr.draft ? " (draft, which a revision can still update)" : ""}.`);
    }
    // ---- lineage: the check the branch name cannot stand in for ----
    //
    // The session's ledger holds a commit sha for every sub-task that committed.
    // If none of them is on the PR, then whatever the branch is called, this PR
    // does not contain this session's work.
    const matchedCommitShas = session.ledgerCommitShas.filter((s) => pr.commitShas.some((c) => sameSha(s, c)));
    if (session.ledgerCommitShas.length === 0) {
        blockers.push({
            kind: "no_session_commits",
            message: `Session ${session.sessionId} recorded no commit shas, so there is no evidence tying it to any PR. ` +
                `A matching branch name is not evidence. Link refused rather than guessed.`,
        });
    }
    else if (matchedCommitShas.length === 0) {
        blockers.push({
            kind: "lineage_mismatch",
            message: `None of the ${session.ledgerCommitShas.length} commit(s) session ${session.sessionId} recorded appear on PR #${pr.number}. ` +
                `The branch may have been force-pushed, or this is a different PR.`,
        });
    }
    else {
        evidence.push(`Commit lineage confirmed: ${matchedCommitShas.length} of ${session.ledgerCommitShas.length} recorded session commit(s) are on the PR ` +
            `(${matchedCommitShas.map((s) => s.slice(0, 12)).join(", ")}).`);
    }
    // The fork point is a second, independent tie. It is only checked when both
    // sides know it: a session that failed before plan_ready has no
    // `plan_base_sha`, and that absence is already covered by the ledger check.
    if (session.planBaseSha && pr.mergeBaseSha) {
        if (sameSha(session.planBaseSha, pr.mergeBaseSha)) {
            evidence.push(`Fork point matches the session's recorded plan base: ${pr.mergeBaseSha.slice(0, 12)}.`);
        }
        else {
            blockers.push({
                kind: "base_sha_mismatch",
                message: `PR #${pr.number} forks from ${pr.mergeBaseSha.slice(0, 12)}, but session ${session.sessionId} planned against ` +
                    `${session.planBaseSha.slice(0, 12)}. The PR was built on a different base.`,
            });
        }
    }
    // A session already linked to a DIFFERENT PR is a conflict. Overwriting it
    // would silently move the association, and the operator who set the first one
    // would have no way to know.
    if (session.existingPrNumber !== null &&
        session.existingPrNumber !== pr.number) {
        blockers.push({
            kind: "conflicting_link",
            message: `Session ${session.sessionId} is already associated with PR #${session.existingPrNumber}` +
                `${session.existingLinkState === "recovered" ? " (a previously recovered link)" : ""}. ` +
                `Refusing to move it to #${pr.number}. Unlinking is deliberately not offered.`,
        });
    }
    return {
        ok: blockers.length === 0,
        evidence,
        blockers,
        alreadyLinked,
        matchedCommitShas,
    };
}
export async function linkPullRequest(deps, args) {
    const { sessionId, repo, prNumber, invokedBy, apply, expectedHeadSha } = args;
    const dryRun = apply !== true;
    const now = deps.now ?? Date.now;
    if (!invokedBy || !deps.authorisedUsers.includes(invokedBy)) {
        return {
            ok: false,
            dryRun,
            unauthorised: true,
            message: `Invoker ${invokedBy || "(missing)"} is not in slack.authorised_users. Linking a PR to a session is an authorised action.`,
        };
    }
    if (!repo || !repo.includes("/")) {
        return { ok: false, dryRun, message: `repo must be a full 'owner/name'. A PR number alone is ambiguous across repositories.` };
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
        return { ok: false, dryRun, message: `prNumber must be a positive integer.` };
    }
    const row = deps.db
        .prepare(`SELECT id, repo, branch, requester, status, plan_base_sha, pr_number, final_pr_url, pr_link_state
         FROM sessions WHERE id = ?`)
        .get(sessionId);
    if (!row)
        return { ok: false, dryRun, message: `No session ${sessionId}.` };
    // The operator naming a different repo than the session ran against means the
    // request itself is confused, and no amount of provider evidence resolves it.
    if (row.repo.trim().toLowerCase() !== repo.trim().toLowerCase()) {
        return {
            ok: false,
            dryRun,
            sessionId,
            message: `Session ${sessionId} ran against ${row.repo}, but the request names ${repo}. Refusing to link across repositories.`,
        };
    }
    // Another session already holding this PR cannot be seen from this row alone.
    // Revise sessions legitimately share a PR with the session they revise, so
    // only a RECOVERED link elsewhere counts: two operators recovering the same
    // PR onto different sessions is the case worth refusing.
    const rival = deps.db
        .prepare(`SELECT id FROM sessions
        WHERE pr_number = ? AND lower(repo) = lower(?) AND id != ? AND pr_link_state = 'recovered'
        LIMIT 1`)
        .get(prNumber, repo, sessionId);
    if (rival) {
        const blockers = [
            {
                kind: "conflicting_link",
                message: `${repo}#${prNumber} is already recovered onto session ${rival.id}. Refusing to link it to a second session.`,
            },
        ];
        deps.audit("tool.pr_link_refused", { sessionId, repo, prNumber, invokedBy, blockers: ["conflicting_link"] }, sessionId);
        return {
            ok: false,
            dryRun,
            sessionId,
            repo,
            prNumber,
            blockers,
            message: `${repo}#${prNumber} is already linked to session ${rival.id}. Refusing a conflicting association.`,
        };
    }
    // ---- authoritative provider metadata ----
    let pr;
    try {
        pr = await deps.fetchPr({ repo, prNumber, requester: row.requester });
    }
    catch (err) {
        // A provider failure is not a mismatch and must not read like one. It is
        // also not permission: with no evidence there is nothing to link on.
        return {
            ok: false,
            dryRun,
            sessionId,
            repo,
            prNumber,
            message: `Could not read ${repo}#${prNumber} from the provider, so there is no evidence to link on: ${String(err)}`,
        };
    }
    const ledgerCommitShas = deps.db
        .prepare(`SELECT commit_sha FROM sub_tasks WHERE session_id = ? AND commit_sha IS NOT NULL AND commit_sha != ''`)
        .all(sessionId).map((r) => r.commit_sha);
    const sessionFacts = {
        sessionId: row.id,
        repo: row.repo,
        branch: row.branch,
        planBaseSha: row.plan_base_sha,
        ledgerCommitShas,
        existingPrNumber: row.pr_number,
        existingLinkState: row.pr_link_state,
    };
    const prFacts = {
        repo,
        number: prNumber,
        headRepo: pr.headRepo,
        headRef: pr.headRef,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        state: pr.state,
        merged: pr.merged,
        draft: pr.draft,
        htmlUrl: pr.htmlUrl,
        commitShas: pr.commitShas,
        mergeBaseSha: pr.mergeBaseSha,
    };
    const verification = verifyPrLink(sessionFacts, prFacts, deps.defaultBaseBranch);
    // A truncated commit list can turn a genuine match into a false refusal, so
    // say so rather than letting "not found" pass for "not there".
    if (pr.commitsTruncated) {
        verification.blockers = verification.blockers.map((b) => b.kind === "lineage_mismatch"
            ? { ...b, message: `${b.message} (The PR has more commits than could be listed, so absence here is not conclusive.)` }
            : b);
    }
    const common = {
        sessionId,
        repo,
        prNumber,
        prUrl: pr.htmlUrl,
        headSha: pr.headSha,
        evidence: verification.evidence,
        blockers: verification.blockers,
    };
    // ---- dry run: report and write nothing ----
    if (dryRun) {
        deps.audit("tool.pr_link_dry_run", {
            sessionId, repo, prNumber, headSha: pr.headSha, invokedBy,
            ok: verification.ok, blockers: verification.blockers.map((b) => b.kind),
        }, sessionId);
        return {
            ...common,
            ok: verification.ok,
            dryRun: true,
            alreadyLinked: verification.alreadyLinked,
            message: renderLinkVerification(verification, sessionFacts, prFacts, "dry_run"),
        };
    }
    // ---- apply ----
    //
    // Already pointing at this PR means there is nothing to recover, whether an
    // operator linked it or the loop opened it. The second case matters: writing
    // here would stamp `pr_link_state = 'recovered'` onto a session that shipped
    // its PR normally, and the column exists precisely to tell those apart.
    if (verification.alreadyLinked) {
        return {
            ...common,
            ok: true,
            dryRun: false,
            applied: false,
            alreadyLinked: true,
            message: row.pr_link_state === "recovered"
                ? `Session ${sessionId} is already linked to ${repo}#${prNumber}. Nothing to do.`
                : `Session ${sessionId} already owns ${repo}#${prNumber} — the loop recorded it, so there is nothing to recover.`,
        };
    }
    if (!verification.ok) {
        deps.audit("tool.pr_link_refused", { sessionId, repo, prNumber, headSha: pr.headSha, invokedBy, blockers: verification.blockers.map((b) => b.kind) }, sessionId);
        return {
            ...common,
            ok: false,
            dryRun: false,
            applied: false,
            message: renderLinkVerification(verification, sessionFacts, prFacts, "dry_run"),
        };
    }
    // Applying against evidence the operator never saw is the failure this
    // parameter exists for: between the dry run and the apply the branch can be
    // force-pushed, and the commits that justified the link stop being the
    // commits on the PR.
    if (!expectedHeadSha) {
        return {
            ...common,
            ok: false,
            dryRun: false,
            applied: false,
            message: `apply requires expectedHeadSha, the PR head the dry run reported. ` +
                `The current head is ${pr.headSha}. Re-read the dry run before applying.`,
        };
    }
    if (expectedHeadSha.trim().toLowerCase() !== pr.headSha.trim().toLowerCase()) {
        deps.audit("tool.pr_link_refused", { sessionId, repo, prNumber, headSha: pr.headSha, expectedHeadSha, invokedBy, blockers: ["head_moved"] }, sessionId);
        return {
            ...common,
            ok: false,
            dryRun: false,
            applied: false,
            blockers: [
                { kind: "head_moved", message: `The PR head was ${expectedHeadSha} when the dry run ran and is ${pr.headSha} now.` },
            ],
            message: `Refusing to apply: ${repo}#${prNumber} has moved since the dry run ` +
                `(expected ${expectedHeadSha.slice(0, 12)}, found ${pr.headSha.slice(0, 12)}). Re-run the dry run and check the evidence again.`,
        };
    }
    // One statement, guarded on the state it verified. A concurrent apply that
    // got here first has already set `pr_link_state`, so the second changes no
    // rows and reports the link rather than overwriting it.
    //
    // Note what is NOT in the SET list: status, the review verdict, the merge
    // recommendation, cost, cycles. A recovered PR is an association, and the
    // failure it came from stands.
    const ts = now();
    const evidenceJson = JSON.stringify({
        checkedAt: ts,
        headSha: pr.headSha,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        matchedCommitShas: verification.matchedCommitShas,
        ledgerCommitCount: ledgerCommitShas.length,
        mergeBaseSha: pr.mergeBaseSha,
        evidence: verification.evidence,
    });
    const res = deps.db
        .prepare(`UPDATE sessions
          SET pr_number = ?, final_pr_url = ?, pr_link_state = 'recovered',
              pr_linked_at = ?, pr_linked_by = ?, pr_link_head_sha = ?, pr_link_evidence = ?,
              updated_at = ?
        WHERE id = ? AND pr_link_state IS NULL AND (pr_number IS NULL OR pr_number = ?)`)
        .run(prNumber, pr.htmlUrl, ts, invokedBy, pr.headSha, evidenceJson, ts, sessionId, prNumber);
    // `changes` is number|bigint; 0n === 0 is false, so normalise before asking.
    if (Number(res.changes) === 0) {
        const after = deps.db
            .prepare(`SELECT pr_number, pr_link_state FROM sessions WHERE id = ?`)
            .get(sessionId);
        if (after?.pr_number === prNumber && after?.pr_link_state === "recovered") {
            return {
                ...common,
                ok: true,
                dryRun: false,
                applied: false,
                alreadyLinked: true,
                message: `Session ${sessionId} is already linked to ${repo}#${prNumber} (applied concurrently). Nothing to do.`,
            };
        }
        return {
            ...common,
            ok: false,
            dryRun: false,
            applied: false,
            message: `Could not apply the association: session ${sessionId} changed while it was being verified. Re-run the dry run.`,
        };
    }
    deps.audit("tool.pr_link_applied", {
        sessionId,
        repo,
        prNumber,
        prUrl: pr.htmlUrl,
        headSha: pr.headSha,
        invokedBy,
        requester: row.requester,
        sessionStatus: row.status,
        matchedCommitShas: verification.matchedCommitShas,
        mergeBaseSha: pr.mergeBaseSha,
        evidence: verification.evidence,
    }, sessionId);
    return {
        ...common,
        ok: true,
        dryRun: false,
        applied: true,
        message: renderLinkVerification(verification, sessionFacts, prFacts, "applied"),
    };
}
/** Render a verification for a human, as the tool's text body. */
export function renderLinkVerification(v, session, pr, mode) {
    const head = `${mode === "dry_run" ? "Proposed" : "Applied"} association: session ${session.sessionId} → ${pr.repo}#${pr.number} (${pr.htmlUrl})`;
    const at = `PR head ${pr.headSha.slice(0, 12)} on branch ${pr.headRef}.`;
    const ev = v.evidence.length ? [`Evidence:`, ...v.evidence.map((e) => `  • ${e}`)] : [];
    const bl = v.blockers.length ? [`Blockers:`, ...v.blockers.map((b) => `  ✖ [${b.kind}] ${b.message}`)] : [];
    const tail = mode === "dry_run"
        ? v.ok
            ? [
                ``,
                `Nothing has been written. To apply, call harness_link_pr again with apply: true and`,
                `expectedHeadSha: "${pr.headSha}". The apply re-reads the PR and refuses if the head has moved.`,
            ]
            : [``, `Nothing has been written, and the association was NOT proposed. Resolve the blockers above first.`]
        : [
            ``,
            `The session's status, review findings, spend and history are unchanged. Linking a PR is not`,
            `an approval: the merge gate still reads the adversary verdict, and this session has not passed one.`,
        ];
    return [head, at, ...ev, ...bl, ...tail].join("\n");
}
//# sourceMappingURL=pr-link.js.map