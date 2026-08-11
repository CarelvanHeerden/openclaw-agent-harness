/**
 * beta.119: WHAT A FAILED PUSH COSTS, AND WHAT TO SAY ABOUT IT.
 *
 * The CI-optimisation run against ProjectThanos did the work correctly -- one
 * line in `.github/workflows/ci.yml`, committed in the worktree -- and then
 * died at the push with:
 *
 *   refusing to allow an OAuth App to create or update workflow
 *   `.github/workflows/ci.yml` without `workflow` scope
 *
 * The loop routed that to `finaliseFailed`, which releases the worktree. The
 * branch and the commit went with it. Nothing about the failure was
 * unrecoverable -- the token needed one more scope, and the diff was one line
 * -- but the only copy of the work had been deleted by the time anyone read
 * the error.
 *
 * b62 already built `finaliseFailedPreserveWorktree` for exactly this reason
 * ("the b60-attempt-2 failure discarded 8 good commits precisely because the
 * crash path released the worktree"). It was wired to review crashes and never
 * to push failures, which is the one terminal where the commits provably exist
 * ONLY on local disk -- a push failure means, by definition, that nothing
 * reached the remote.
 *
 * This module classifies the error so the operator is told which of those it
 * hit and what to do next. Pure: no fs, no git, no network.
 */

export type PushFailureKind =
  | "missing_workflow_scope"
  | "auth"
  | "protected_branch"
  | "non_fast_forward"
  | "network"
  | "unknown";

export interface PushFailureDiagnosis {
  kind: PushFailureKind;
  /** Would the same work succeed once the operator fixes something? */
  recoverable: boolean;
  /** One-line statement of what went wrong. */
  summary: string;
  /** What the operator should do, given the work is preserved on disk. */
  remedy: string;
}

const PATTERNS: Array<{ kind: PushFailureKind; re: RegExp; recoverable: boolean; summary: string; remedy: string }> = [
  {
    kind: "missing_workflow_scope",
    // GitHub's wording, matched loosely enough to survive a rephrase.
    re: /without\s+`?workflow`?\s+scope|refusing to allow (an OAuth App|a GitHub App|a Personal Access Token) to (create or update )?workflow/i,
    recoverable: true,
    summary: "the push touched a GitHub Actions workflow file, and the token lacks the `workflow` scope",
    remedy:
      "Grant the `workflow` scope to the token this repo routes to (classic PAT: tick `workflow`; fine-grained: Repository permissions -> Workflows -> Read and write), then push the preserved branch. " +
      "GitHub's web editor can also commit workflow changes directly, which bypasses the scope check entirely.",
  },
  {
    kind: "auth",
    re: /authentication failed|invalid username or password|bad credentials|403 forbidden|401 unauthorized|could not read Username|permission to .* denied/i,
    recoverable: true,
    summary: "the remote rejected the credentials",
    remedy: "Check the PAT routing for this repo (scope, expiry, and that it can write to this remote), then push the preserved branch.",
  },
  {
    kind: "protected_branch",
    re: /protected branch|required status check|GH006|refusing to update checked out branch|cannot force-update/i,
    recoverable: true,
    summary: "a branch protection rule rejected the push",
    remedy: "Open the PR from the preserved branch manually, or adjust the protection rule.",
  },
  {
    kind: "non_fast_forward",
    re: /non-fast-forward|fetch first|Updates were rejected|behind its remote counterpart/i,
    recoverable: true,
    summary: "the remote moved ahead of this branch",
    remedy: "Rebase the preserved branch onto the updated base and push again.",
  },
  {
    kind: "network",
    re: /could not resolve host|connection (timed out|refused|reset)|network is unreachable|ETIMEDOUT|ECONNRESET|EAI_AGAIN|TLS|SSL/i,
    recoverable: true,
    summary: "the push failed on a network error",
    remedy: "Retry the push from the preserved worktree; nothing about the change needs to be redone.",
  },
];

/** Classify a push / PR-open error. Never throws. */
export function diagnosePushFailure(err: unknown): PushFailureDiagnosis {
  const msg = String((err as Error)?.message ?? err ?? "");
  for (const p of PATTERNS) {
    if (p.re.test(msg)) {
      return { kind: p.kind, recoverable: p.recoverable, summary: p.summary, remedy: p.remedy };
    }
  }
  return {
    kind: "unknown",
    // Unknown does NOT mean unrecoverable. The work is on disk either way, and
    // deleting it to save a worktree is never the right trade.
    recoverable: true,
    summary: "the push or PR-open failed",
    remedy: "Inspect the preserved worktree, resolve the error, and push the branch manually.",
  };
}

/**
 * The operator-facing terminal message. Names the branch and the worktree,
 * because the entire point is that the work still exists and can be recovered.
 */
export function describePreservedPushFailure(input: {
  diagnosis: PushFailureDiagnosis;
  branch: string;
  worktreePath: string;
  error: string;
}): string {
  return [
    `PUSH FAILED — ${input.diagnosis.summary}.`,
    ``,
    `Your work is NOT lost. Every commit this run made is preserved:`,
    `  branch:   ${input.branch}`,
    `  worktree: ${input.worktreePath}`,
    ``,
    `What to do: ${input.diagnosis.remedy}`,
    ``,
    `To push it by hand:`,
    `  cd ${input.worktreePath} && git push -u origin ${input.branch}`,
    ``,
    `Underlying error:`,
    input.error.slice(0, 1200),
  ].join("\n");
}
