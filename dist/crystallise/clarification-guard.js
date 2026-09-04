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
/**
 * Absolute paths that are plainly filesystem locations.
 *
 * Anchored on real root directories rather than "anything starting with a
 * slash", because a legitimate question can quote a URL path (`/api/v2/users`)
 * or a repository-relative one, and mangling those would be its own defect.
 * Every fabricated path seen so far is a container or home directory, which is
 * exactly what this matches.
 */
const ABSOLUTE_PATH_RE = /(?:^|[\s"'`([<])(?:~\/|[A-Za-z]:\\|\/(?:home|Users|root|var|tmp|opt|mnt|srv|data|app|usr|private|workspace|Volumes)\/)[^\s"'`)\]>,;]*/g;
/**
 * Claims about repository state that only runtime inspection could support.
 *
 * Each of these asserts something exists. That is the distinguishing feature:
 * "should I open a PR" asserts nothing, "should I update the existing worktree"
 * asserts a worktree.
 */
const UNVERIFIED_STATE_RE = [
    /\bexisting\s+(?:worktree|checkout|clone|working\s+(?:copy|tree|directory))\b/i,
    /\b(?:the|that|your|current)\s+worktree\b/i,
    /\buncommitted\b/i,
    /\bunstaged\b/i,
    /\bstashed?\b/i,
    /\balready\s+(?:checked\s+out|cloned|checked-out)\b/i,
    /\blocal\s+(?:changes|edits|modifications|work)\b/i,
    /\bwork\s+in\s+progress\b/i,
    /\bpreserv\w*\s+(?:any\s+|the\s+|your\s+)?(?:changes|edits|work|modifications)\b/i,
];
/**
 * Where a branch is cut FROM. The optional `latest` matters: "checkout latest
 * main" is the exact phrasing that started this, and a pattern that stopped at
 * the first word would capture "latest" as the branch name.
 */
const BASE_PHRASE_RE = /\b(?:based?\s+(?:this\s+|it\s+)?on|start(?:ing)?\s+from|branch(?:ing)?\s+(?:off|from)|check\s?out)\s+(?:the\s+)?(?:latest\s+)?`?(?:origin\/)?([A-Za-z0-9._\-/]+)/i;
/**
 * Where the resulting PR lands.
 *
 * The verb must be attached to a PR/merge noun. A bare "to" matches "to open a
 * PR", which would read the word "open" as a branch name.
 */
const PR_TARGET_RE = /(?:(?:PR|pull\s+request)\s+(?:against|into|to)|merged?\s+in?to|target(?:ing)?\s+branch)\s+(?:the\s+)?`?(?:origin\/)?([A-Za-z0-9._\-/]+)/i;
function normaliseBranch(b) {
    return b.trim().replace(/^origin\//, "").replace(/[.,;:!?)\]`'"]+$/, "").toLowerCase();
}
/** Absolute paths in the text that the harness has not verified. */
export function unverifiedPathsIn(text, g) {
    const verified = g.continuation?.worktreePath?.trim();
    const found = text.match(ABSOLUTE_PATH_RE) ?? [];
    return found
        // Trailing sentence punctuation is not part of the path. Leaving it on made
        // a correctly-quoted VERIFIED worktree fail its own equality check.
        .map((m) => m.trim().replace(/^[\s"'`([<]+/, "").replace(/[.,;:!?)\]}>`'"]+$/, ""))
        .filter((p) => p.length > 0)
        // A verified worktree may legitimately be named, and so may anything
        // underneath it -- that is real state someone checked.
        .filter((p) => !(verified && (p === verified || p.startsWith(`${verified}/`))));
}
/**
 * True when the question asserts repository state nobody established.
 *
 * A verified continuation earns the right to discuss its own worktree: the
 * whole point of the resume flow is asking whether to keep work that provably
 * exists.
 */
export function claimsUnverifiedState(text, g) {
    if (g.continuation)
        return false;
    return UNVERIFIED_STATE_RE.some((re) => re.test(text));
}
/**
 * True when the question presents "base on latest main" and "PR against main"
 * as if the requester had to choose.
 *
 * They are the same instruction seen from two ends: a branch is cut from the
 * latest `origin/main` and merges back into `main`. Requiring both branch names
 * to match keeps a genuine question -- basing on `main` while targeting
 * `release/1.4` -- askable.
 */
export function isFalseBaseConflict(text) {
    const baseBranch = normaliseBranch(BASE_PHRASE_RE.exec(text)?.[1] ?? "");
    const targetBranch = normaliseBranch(PR_TARGET_RE.exec(text)?.[1] ?? "");
    if (!baseBranch || !targetBranch)
        return false;
    return baseBranch === targetBranch;
}
/**
 * Decide whether a proposed clarification may reach the user.
 *
 * Withholding does not discard the request. The caller continues down the
 * ordinary path, which is the correct handling of a question whose only content
 * was a guess at mechanics the harness performs the same way every time.
 */
export function guardClarification(question, grounding, reason) {
    const text = (question ?? "").trim();
    if (!text)
        return { action: "withhold", question: text, suppressed: ["harness_owned_checkout"] };
    const suppressed = [];
    if (unverifiedPathsIn(text, grounding).length > 0)
        suppressed.push("invented_filesystem_path");
    if (claimsUnverifiedState(text, grounding))
        suppressed.push("unverified_worktree_state");
    if (isFalseBaseConflict(text))
        suppressed.push("harness_owned_checkout");
    if (suppressed.length > 0)
        return { action: "withhold", question: text, suppressed };
    return { action: "ask", question: text, reason };
}
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
export function renderGroundingBlock(g) {
    const lines = [
        "",
        "VERIFIED CONTEXT (this is everything the harness knows; you have no other source):",
    ];
    lines.push(g.allowedRepos.length > 0
        ? `- Repositories this harness may touch: ${g.allowedRepos.join(", ")}`
        : "- The operator has not restricted which repositories may be touched.");
    if (g.continuation) {
        lines.push(`- This continues session ${g.continuation.sessionId}, on branch ${g.continuation.branch} of ${g.continuation.repo}, in a worktree that has been checked and still exists. You may refer to it.`);
    }
    else {
        lines.push("- There is NO active session, NO worktree, NO checkout and NO uncommitted work associated with this request. None has been created yet.");
    }
    lines.push("", "CHECKOUT IS HARNESS-OWNED. Every new run fetches the remote, creates a fresh isolated worktree on a new namespaced branch based on the latest " +
        `origin/${g.defaultBaseBranch || "<default branch>"}, and opens its PR against ${g.defaultBaseBranch || "the default branch"}. Consequences you must respect:`, "- \"checkout latest main\", \"start from latest main\" and \"base this on origin/main\" all DESCRIBE THAT DEFAULT. They are confirmations, not new instructions, and never a reason to clarify.", "- Basing on the latest main and opening a PR against main are THE SAME normal workflow. Never present them as conflicting or ask the user to choose between them.", "- You have no filesystem knowledge. NEVER write an absolute path, name a directory, or refer to a worktree, checkout, clone, uncommitted change or local edit. You cannot know whether any exists, and asserting one is a defect.", "- Never ask the user to decide checkout mechanics (which directory, whether to reuse a worktree, whether to fetch, what to do with local changes). The harness owns all of it.", "");
    return lines.join("\n");
}
//# sourceMappingURL=clarification-guard.js.map