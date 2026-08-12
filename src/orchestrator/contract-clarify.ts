/**
 * beta.111: deciding whether a contract mismatch actually needs a human, and
 * saying so in language a human can act on.
 *
 * Two runs in a row paused for the same reason. A finding was written
 * conditionally ("if the handler extends `to` unconditionally, date-only
 * filters are wrong"), the worker read the code, found the condition already
 * handled, added a test pinning it, and committed only the test. The contract
 * had named a source file as well, so the harness escalated.
 *
 * The b109 run's sub-task 2 and the b110 run's sub-task 5 were both this. The
 * b110 one sat for forty minutes at $2.99 waiting for someone to type "skip",
 * on evidence the harness already held: `route.ts` had been changed for that
 * exact finding by an earlier commit on the same branch.
 *
 * And when a human IS needed, the question they got was:
 *
 *   "Was the plan's path wrong, or the worker's placement? (Reply with the
 *    path convention this repo should use ...)"
 *
 * which asks a non-expert to arbitrate between two pieces of harness jargon.
 */

import { pathMatches } from "./path-match.js";

export interface ContractMismatch {
  seq: number;
  title: string;
  commitSha: string;
  /** Contract paths the plan required. */
  expected: string[];
  /** Paths this sub-task's own commit actually touched. */
  actual: string[];
  /** The worker's justification, already relevance-selected. */
  statedReason?: string;
  /**
   * Every file changed on this branch since the plan base -- i.e. the work of
   * ALL prior sub-tasks and cycles, not just this turn.
   */
  changedOnBranch?: string[];
}

/** Expected paths this sub-task's own commit did not touch. */
export function missingFromCommit(m: ContractMismatch): string[] {
  return m.expected.filter((e) => !m.actual.some((a) => pathMatches(a, e)));
}

export interface AutoResolution {
  resolved: boolean;
  reason: string;
  /** The missing paths an earlier commit on this branch already covers. */
  coveredEarlier: string[];
}

/**
 * beta.111: can this mismatch be settled without asking anybody?
 *
 * Yes when every expected path the worker did not touch was ALREADY changed
 * earlier on this branch. That is the machine-checkable form of "the work was
 * already done" -- the same evidence a human would look at, and exactly the
 * situation the last two escalations turned out to be.
 *
 * Deliberately strict. If even one missing path has never been touched on this
 * branch, the worker may genuinely have skipped something, and that is worth a
 * human. A mismatch with nothing missing at all is not auto-resolved here
 * either; it never reaches this code, because the contract verifier passes.
 */
export function autoResolveContract(m: ContractMismatch): AutoResolution {
  const missing = missingFromCommit(m);
  if (missing.length === 0) {
    return { resolved: false, reason: "nothing missing; not a mismatch", coveredEarlier: [] };
  }
  const changed = m.changedOnBranch ?? [];
  if (changed.length === 0) {
    return { resolved: false, reason: "no branch history available to check against", coveredEarlier: [] };
  }
  const covered = missing.filter((e) => changed.some((c) => pathMatches(c, e)));
  if (covered.length !== missing.length) {
    const uncovered = missing.filter((e) => !covered.includes(e));
    return {
      resolved: false,
      reason: `${uncovered.length} expected path(s) were never changed on this branch: ${uncovered.join(", ")}`,
      coveredEarlier: covered,
    };
  }
  return {
    resolved: true,
    reason:
      `every expected path this sub-task did not touch was already changed earlier on this branch ` +
      `(${covered.join(", ")}), so the work exists and the contract is satisfied by the branch as a whole`,
    coveredEarlier: covered,
  };
}

const bullet = (opt: string, text: string): string => `  • ${opt.padEnd(15)} ${text}`;

/**
 * beta.111: the question a human actually reads.
 *
 * Ordered outcome-first. The technical contract detail goes last, because a
 * reader who needs it will scroll and a reader who does not should not have to
 * parse it to answer. Option labels are unchanged (`skip`, a path, `abort`) so
 * every existing answer still works.
 */
export function buildContractClarification(m: ContractMismatch): string {
  const missing = missingFromCommit(m);
  const auto = autoResolveContract(m);
  const lines: string[] = [];

  lines.push(
    `Sub-task ${m.seq} ("${m.title}") committed ${m.commitSha.slice(0, 7)}, but it did not change ` +
      `everything the plan expected.`,
  );
  lines.push("");
  lines.push(`It was expected to change ${missing.join(" and ")}, and did not.`);
  if (m.statedReason) lines.push(`The worker's explanation: ${m.statedReason}`);
  lines.push("");
  lines.push("How should I proceed?");
  // beta.122: these two used to be one option, described as the gentler of the
  // pair and implemented as the harsher one. On the b121 smoke the migration
  // SQL was committed and correct -- only the contract path was wrong -- and
  // the operator read "accept that this sub-task is done and carry on" and
  // answered `skip`. That wrote "Do NOT perform this work under ANY
  // circumstances" into the brief, and the re-plan dropped the migration
  // entirely. The words now match what each answer does.
  lines.push(bullet("accept", "the commit is fine and the contract path was wrong -- keep the work and carry on"));
  lines.push(bullet("skip", "drop this sub-task; do not attempt this work again in this run"));
  lines.push(bullet("<a file path>", "the work belongs somewhere else -- tell me where and I will re-plan"));
  lines.push(bullet("abort", "stop the run"));

  // Only ever recommend on evidence. `coveredEarlier` is a git fact, not a
  // judgement, so partial coverage is worth saying even when it is not enough
  // to auto-resolve.
  if (auto.coveredEarlier.length > 0) {
    lines.push("");
    lines.push(
      `Suggestion: "accept" looks right. ${auto.coveredEarlier.join(" and ")} ` +
        `${auto.coveredEarlier.length === 1 ? "was" : "were"} already changed by an earlier commit on this ` +
        `branch, which supports the worker's account that the change was already in place.`,
    );
  }

  lines.push("");
  lines.push(
    `Detail -- contract expected: ${m.expected.join(", ")}; this commit touched: ` +
      `${m.actual.join(", ") || "(no files reported)"}.`,
  );
  return lines.join("\n");
}
