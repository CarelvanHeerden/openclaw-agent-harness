/**
 * beta.119: FIND OUT BEFORE DOING THE WORK, NOT AFTER.
 *
 * The CI-optimisation run planned a one-line change to
 * `.github/workflows/ci.yml`, executed it, reviewed it, and only discovered at
 * the push -- the very last step -- that the token could not write workflow
 * files at all:
 *
 *   refusing to allow an OAuth App to create or update workflow
 *   `.github/workflows/ci.yml` without `workflow` scope
 *
 * Everything the run spent was unrecoverable at that point, and the answer was
 * available before the first worker started: the plan named the file, and
 * GitHub reports a token's scopes on the header of any authenticated request.
 *
 * b119 preserves the worktree on that failure (see push-failure.ts), which
 * saves the work. This saves the *time*, by asking the question up front.
 *
 * Pure except for the caller-injected scope reader.
 */
/** Does this path need a token with the `workflow` scope to push? */
export declare function isWorkflowPath(p: string): boolean;
/** The workflow files a plan intends to touch, if any. */
export declare function planTouchesWorkflows(subTasks: Array<{
    filesLikelyTouched?: string[];
}>): string[];
/**
 * Can a token with these scopes push a workflow file?
 *
 * `scopes` is GitHub's `x-oauth-scopes` response header, split. The header is
 * only populated for classic PATs and OAuth tokens; a fine-grained PAT or a
 * GitHub App installation token returns it EMPTY, and those can be perfectly
 * capable. An absent header therefore means "cannot tell", never "cannot
 * push" -- guessing the latter would block every fine-grained-token
 * deployment from ever editing CI.
 */
export declare function canPushWorkflows(scopes: string[] | null | undefined): boolean | null;
/** The operator-facing message for a token that provably cannot push workflows. */
export declare function describeMissingWorkflowScope(files: string[]): string;
//# sourceMappingURL=workflow-scope.d.ts.map