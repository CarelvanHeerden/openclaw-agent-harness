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
export declare function missingFromCommit(m: ContractMismatch): string[];
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
export declare function autoResolveContract(m: ContractMismatch): AutoResolution;
/**
 * beta.111: the question a human actually reads.
 *
 * Ordered outcome-first. The technical contract detail goes last, because a
 * reader who needs it will scroll and a reader who does not should not have to
 * parse it to answer. Option labels are unchanged (`skip`, a path, `abort`) so
 * every existing answer still works.
 */
export declare function buildContractClarification(m: ContractMismatch): string;
//# sourceMappingURL=contract-clarify.d.ts.map