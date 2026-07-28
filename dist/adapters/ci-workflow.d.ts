/**
 * beta.81 (Track B / B3): author a GitHub Actions workflow for a repo that has
 * NO CI configured, so verification runs on GitHub (Carel's directive: build
 * the CI, NEVER a local check-script fallback -- "I do not want it to run
 * locally, ever").
 *
 * `detectCheckScripts` inspects the worktree's package.json#scripts and returns
 * the subset of the canonical verification scripts (typecheck / lint / test /
 * build) it actually declares, in a stable order. `renderCiWorkflowYaml`
 * renders a minimal Node CI workflow that runs `npm ci` then each detected
 * script. `hasExistingWorkflow` reports whether the repo already ships any
 * `.github/workflows/*.yml|*.yaml` (in which case B3 authors nothing).
 *
 * All functions are PURE / fs-read-only except `authorCiWorkflow`, which writes
 * the file + stages+commits it via the injected git commit fn. Kept dependency-
 * light + injected so the loop test can exercise B3 without a real repo.
 */
/**
 * Return the subset of the canonical check scripts the worktree's package.json
 * declares, in canonical order. Empty when there is no package.json or none of
 * the canonical scripts exist. Never throws.
 */
export declare function detectCheckScripts(worktreePath: string): string[];
/** True when the worktree already ships a `.github/workflows/*.yml|*.yaml`. */
export declare function hasExistingWorkflow(worktreePath: string): boolean;
/**
 * Render a minimal Node.js GitHub Actions CI workflow that checks out the code,
 * installs deps with `npm ci`, and runs each declared check script. Pinned to
 * ubuntu-latest + actions/checkout@v4 + actions/setup-node@v4 (Node 20).
 */
export declare function renderCiWorkflowYaml(scripts: string[]): string;
/**
 * Author + stage + commit a CI workflow into the worktree when the repo has no
 * existing workflow AND declares runnable check scripts. Returns the committed
 * workflow path + the scripts it runs, or null when nothing was authored
 * (existing CI, no package.json, or no runnable scripts). Never throws.
 *
 * `gitCommit` is injected (the loop supplies git.commit with a resolved commit
 * identity) so the file is committed onto the branch and lands in the PR.
 */
export declare function authorCiWorkflow(input: {
    worktreePath: string;
    gitCommit: (worktreePath: string, message: string) => Promise<string | null>;
}): Promise<{
    path: string;
    scripts: string[];
} | null>;
//# sourceMappingURL=ci-workflow.d.ts.map