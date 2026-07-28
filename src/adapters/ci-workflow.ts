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

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Canonical verification scripts, in the order they should run in CI. */
const CANONICAL_SCRIPTS = ["typecheck", "lint", "test", "build"] as const;

/**
 * Return the subset of the canonical check scripts the worktree's package.json
 * declares, in canonical order. Empty when there is no package.json or none of
 * the canonical scripts exist. Never throws.
 */
export function detectCheckScripts(worktreePath: string): string[] {
  try {
    const pkgPath = join(worktreePath, "package.json");
    if (!existsSync(pkgPath)) return [];
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = pkg.scripts ?? {};
    return CANONICAL_SCRIPTS.filter((s) => typeof scripts[s] === "string" && (scripts[s] as string).trim().length > 0);
  } catch {
    return [];
  }
}

/** True when the worktree already ships a `.github/workflows/*.yml|*.yaml`. */
export function hasExistingWorkflow(worktreePath: string): boolean {
  try {
    const dir = join(worktreePath, ".github", "workflows");
    if (!existsSync(dir)) return false;
    return readdirSync(dir).some((f) => /\.ya?ml$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Render a minimal Node.js GitHub Actions CI workflow that checks out the code,
 * installs deps with `npm ci`, and runs each declared check script. Pinned to
 * ubuntu-latest + actions/checkout@v4 + actions/setup-node@v4 (Node 20).
 */
export function renderCiWorkflowYaml(scripts: string[]): string {
  const steps = scripts
    .map((s) => `      - name: ${s}\n        run: npm run ${s} --if-present`)
    .join("\n");
  return [
    "# Authored by openclaw-agent-harness (beta.81 B3): this repo had no CI, so",
    "# the harness added this workflow to run the declared checks on GitHub.",
    "name: harness-ci",
    "on:",
    "  push:",
    "  pull_request:",
    "jobs:",
    "  checks:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 20",
    "      - name: install",
    "        run: npm ci",
    steps,
    "",
  ].join("\n");
}

/**
 * Author + stage + commit a CI workflow into the worktree when the repo has no
 * existing workflow AND declares runnable check scripts. Returns the committed
 * workflow path + the scripts it runs, or null when nothing was authored
 * (existing CI, no package.json, or no runnable scripts). Never throws.
 *
 * `gitCommit` is injected (the loop supplies git.commit with a resolved commit
 * identity) so the file is committed onto the branch and lands in the PR.
 */
export async function authorCiWorkflow(input: {
  worktreePath: string;
  gitCommit: (worktreePath: string, message: string) => Promise<string | null>;
}): Promise<{ path: string; scripts: string[] } | null> {
  try {
    if (hasExistingWorkflow(input.worktreePath)) return null;
    const scripts = detectCheckScripts(input.worktreePath);
    if (scripts.length === 0) return null;
    const relPath = ".github/workflows/harness-ci.yml";
    const dir = join(input.worktreePath, ".github", "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(input.worktreePath, relPath), renderCiWorkflowYaml(scripts), "utf8");
    await input.gitCommit(input.worktreePath, "ci: add harness-authored GitHub Actions workflow (beta.81 B3)");
    return { path: relPath, scripts };
  } catch {
    return null;
  }
}
