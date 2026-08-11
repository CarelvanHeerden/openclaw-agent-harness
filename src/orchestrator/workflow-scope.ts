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

/** GitHub Actions workflow files -- the paths that need the `workflow` scope. */
const WORKFLOW_PATH_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;

/** Does this path need a token with the `workflow` scope to push? */
export function isWorkflowPath(p: string): boolean {
  const s = (p ?? "").trim().replace(/^\.\//, "");
  return WORKFLOW_PATH_RE.test(s);
}

/** The workflow files a plan intends to touch, if any. */
export function planTouchesWorkflows(subTasks: Array<{ filesLikelyTouched?: string[] }>): string[] {
  const out: string[] = [];
  for (const st of subTasks) {
    for (const p of st.filesLikelyTouched ?? []) {
      if (typeof p !== "string") continue;
      const clean = p.trim().replace(/^\.\//, "");
      if (isWorkflowPath(clean) && !out.includes(clean)) out.push(clean);
    }
  }
  return out;
}

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
export function canPushWorkflows(scopes: string[] | null | undefined): boolean | null {
  if (!scopes || scopes.length === 0) return null;
  const set = new Set(scopes.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return set.has("workflow");
}

/** The operator-facing message for a token that provably cannot push workflows. */
export function describeMissingWorkflowScope(files: string[]): string {
  return [
    `This change edits GitHub Actions workflow file(s):`,
    ...files.map((f) => `  - ${f}`),
    ``,
    `The token routed to this repo does NOT have the \`workflow\` scope, so GitHub will reject the push no matter how good the change is.`,
    `Checked BEFORE running any sub-task, so nothing has been spent on work that could not ship.`,
    ``,
    `To proceed, either:`,
    `  1. Grant the \`workflow\` scope to the token (classic PAT: tick \`workflow\`; fine-grained: Repository permissions -> Workflows -> Read and write), then re-run; or`,
    `  2. Make the edit through GitHub's web editor, which can commit workflow changes without that scope; or`,
    `  3. Re-scope the brief so it does not touch \`.github/workflows/\`.`,
  ].join("\n");
}
