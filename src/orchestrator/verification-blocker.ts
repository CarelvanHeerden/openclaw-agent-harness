/**
 * rc.3: a missing compiler is not a code defect.
 *
 * On StitchGuard PR #1168 the absent `tsc` binary became a high-severity
 * application finding, over and over. Nothing a worker could edit would produce
 * a `tsc`, so every repair cycle spent on it changed nothing, and the finding
 * came back in the next review because the binary was still missing. Four
 * cycles of a $20 run were bought by a `npm install` nobody had run.
 *
 * The harness already has the right mechanism for its own tooling facts:
 * `source: "harness_env"` classifies straight to `env` (merge-blocking,
 * non-cycle-driving) without consulting the prose. The gap is the finding the
 * MODEL authored. The adversary writes "the typecheck cannot run: tsc is not
 * installed" as `high`/`quality`, and `isNonDemotable` -- correctly, in
 * general -- refuses to let a keyword demote a high-severity finding. So the
 * one class of high-severity finding that genuinely cannot be fixed in a diff
 * is the one class the guard protects.
 *
 * This module is the narrow structural exception. It matches a tool, binary,
 * runtime or dependency being UNAVAILABLE -- not code being wrong -- and
 * nothing else. A finding about application code that happens to mention npm
 * does not match, because the pattern requires the unavailability itself.
 *
 * A verification blocker:
 *   - keeps the merge recommendation at do_not_merge (it classifies `env`,
 *     which `blocksMerge` treats as merge-blocking);
 *   - is never assigned to a code worker;
 *   - is never described as an application defect;
 *   - does not consume repair cycles;
 *   - carries a concrete human/environment action, because "the harness could
 *     not verify this" is only useful to somebody who is told what to do.
 */

import type { ReviewFinding } from "./adversary.js";

export type VerificationBlockerKind =
  | "missing_binary"
  | "missing_dependency"
  | "runtime_evidence_unavailable"
  | "network_failure"
  | "broken_worktree";

export interface VerificationBlocker {
  kind: VerificationBlockerKind;
  /** The tool or resource that was unavailable, when the text names one. */
  subject: string | null;
  /** What a human or the environment has to do; no worker can do it. */
  humanAction: string;
}

/**
 * A named tool followed by an unavailability, or an unavailability followed by
 * a named tool. Both orders occur; "tsc: not found" and "could not find tsc".
 */
const MISSING_BINARY_RE =
  /\b(tsc|typescript|eslint|prettier|jest|vitest|playwright|cypress|pytest|tsx|ts-node|node|npm|pnpm|yarn|bun|go|cargo|python3?|ruby|docker|psql|prisma)\b[^.\n]{0,8}?\b(is |was |are |were )?(not (installed|available|found|present|on the path)|unavailable|missing|cannot be (found|located|resolved)|could not be (found|located|resolved)|does not exist|: not found|command not found)/i;

const MISSING_BINARY_REVERSED_RE =
  /\b(cannot find|could not find|unable to (find|locate|run|execute)|no such (file or directory|binary|executable)|command not found|exit(ed)? (with )?(code )?12[67])\b[^.\n]{0,40}?\b(tsc|typescript|eslint|prettier|jest|vitest|playwright|cypress|pytest|tsx|ts-node|npm|pnpm|yarn|bun|cargo|python3?|docker|prisma)\b/i;

const MISSING_DEPENDENCY_RE =
  /\b(cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|node_modules (is |are )?(missing|absent|not installed)|dependencies (are )?not installed|npm (ci|install) (failed|did not run|was never run))\b/i;

const RUNTIME_EVIDENCE_RE =
  /\b(browser (is |was )?(not available|unavailable)|no (browser|headless) (binary|runtime)|playwright browsers? (are |is )?not installed|screenshot could not be (taken|captured)|preview (deploy|environment) (is )?unavailable|runtime (evidence|verification) (is )?(unavailable|impossible))\b/i;

const NETWORK_RE =
  /\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network (is )?unreachable|registry\.npmjs\.org.*(unreachable|failed)|DNS (lookup )?fail)/i;

/**
 * A title that describes a CHECK that did not happen, rather than code that is
 * wrong. This is the gate on reading the detail: "RCE in the upload handler",
 * detailed "eslint: not found in this repo, so nothing caught it", is a
 * critical defect with an aside about tooling, and demoting it to `env` on the
 * aside would be precisely the regression `isNonDemotable` exists to prevent.
 */
const VERIFICATION_TITLE_RE =
  /\b(could not|cannot|can't|unable to|failed to|was not able to|did not)\s+(be\s+)?(run|ran|execute|verify|be verified|check|compile|typecheck|lint|test|build|complete|start|install|capture|observe|establish|confirm)|(verification|typecheck|type check|lint|test suite|build|check)\s+(is |was |were )?(blocked|unavailable|not run|never ran|skipped|impossible|unverifiable)|\bexit(ed)? (with )?(code )?12[67]\b|\bunverified\b/i;

const BROKEN_WORKTREE_RE =
  /\b(worktree (is )?(broken|corrupt|incomplete)|lock ?file (is )?(missing|corrupt)|package\.json (is )?(missing|unreadable)|the worktree has no (node_modules|dependencies))\b/i;

/**
 * Detect a verification blocker in a finding, or return null.
 *
 * Deliberately conservative. Every pattern requires the UNAVAILABILITY, not
 * merely a mention of tooling -- "the build script should run tsc in strict
 * mode" is a real diff-addressable finding and must stay one. A false positive
 * here silently stops a genuine defect driving repair cycles, which is exactly
 * the failure mode `isNonDemotable` exists to prevent, so the bar is high.
 */
export function detectVerificationBlocker(f: ReviewFinding): VerificationBlocker | null {
  // A CI failure is the repo's own suite running against this commit. It is
  // never an environment blocker, whatever its log happens to contain -- the
  // same reasoning that makes `source: "ci"` short-circuit classification.
  if (f.source === "ci") return null;

  const title = f.title ?? "";
  const detail = f.detail ?? "";

  // The blocker has to be what the finding is ABOUT. Either the title carries
  // the unavailability itself, or the title says a check did not happen and the
  // detail says why. A finding that asserts a code defect and mentions tooling
  // in passing is a code defect.
  const titleIsAboutVerification =
    VERIFICATION_TITLE_RE.test(title) || anyBlockerPattern(title);
  if (!titleIsAboutVerification) return null;

  const text = `${title} ${detail}`;

  // Order matters. "Playwright browsers are not installed" satisfies the
  // missing-binary pattern too, and the runtime reading is the useful one: the
  // action is to provide evidence, not to add a devDependency.
  const runtime = RUNTIME_EVIDENCE_RE.exec(text);
  if (runtime) {
    return {
      kind: "runtime_evidence_unavailable",
      subject: namedSubject(runtime[0]),
      humanAction:
        "Provide the runtime evidence the check needs -- a preview deployment, an uploaded log, or an installed " +
        "browser runtime -- and re-run the review. The diff cannot manufacture its own evidence.",
    };
  }
  // Before the dependency reading, because "npm install failed: getaddrinfo
  // ENOTFOUND" satisfies both and the action is to restore the network, not to
  // run the install again.
  const network = NETWORK_RE.exec(text);
  if (network) {
    return {
      kind: "network_failure",
      subject: namedSubject(network[0]),
      humanAction:
        "Restore network access from the harness environment (registry, DNS or proxy) and re-run. " +
        "This is an environment fault, not a defect in the branch.",
    };
  }
  const dependency = MISSING_DEPENDENCY_RE.exec(text);
  if (dependency) {
    return {
      kind: "missing_dependency",
      subject: namedSubject(dependency[0]),
      humanAction:
        "Install the worktree's dependencies (for example `npm ci`) in the harness environment and re-run the review. " +
        "No code change in this diff can supply a module that was never installed.",
    };
  }
  // The subject is read from the MATCHED span, not from the whole finding.
  // "Running `npm run typecheck` failed: sh: tsc: not found" names two tools
  // and only one of them is missing.
  const binary = MISSING_BINARY_RE.exec(text) ?? MISSING_BINARY_REVERSED_RE.exec(text);
  if (binary) {
    const subject = namedSubject(binary[0]);
    return {
      kind: "missing_binary",
      subject,
      humanAction:
        `Make ${subject ?? "the missing tool"} available on the harness PATH (install it, or add it to the repo's ` +
        "devDependencies and install), then re-run the check. A worker cannot create a binary by editing the diff.",
    };
  }
  const worktree = BROKEN_WORKTREE_RE.exec(text);
  if (worktree) {
    return {
      kind: "broken_worktree",
      subject: namedSubject(worktree[0]),
      humanAction:
        "Repair or re-create the harness worktree (re-clone and re-install) and re-run. The branch's contents are " +
        "not what is broken here.",
    };
  }
  return null;
}

function anyBlockerPattern(text: string): boolean {
  return (
    RUNTIME_EVIDENCE_RE.test(text) ||
    NETWORK_RE.test(text) ||
    MISSING_DEPENDENCY_RE.test(text) ||
    MISSING_BINARY_RE.test(text) ||
    MISSING_BINARY_REVERSED_RE.test(text) ||
    BROKEN_WORKTREE_RE.test(text)
  );
}

const SUBJECT_RE =
  /\b(tsc|typescript|eslint|prettier|jest|vitest|playwright|cypress|pytest|tsx|ts-node|npm|pnpm|yarn|bun|cargo|python3?|docker|prisma|node_modules)\b/i;

function namedSubject(text: string): string | null {
  const m = SUBJECT_RE.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * The line a human reads. Says what could not be verified, why no worker was
 * given it, and what to do -- in that order, because the first question an
 * operator asks a stalled run is "why did nobody fix this".
 */
export function describeVerificationBlocker(f: ReviewFinding, b: VerificationBlocker): string {
  return [
    `Verification blocked: ${f.title}`,
    `This is an environment fault, not a defect in the branch, so it was not assigned to a code worker and did not consume repair cycles.`,
    `The merge recommendation stays do_not_merge until it is cleared.`,
    `Action required: ${b.humanAction}`,
  ].join("\n");
}
