/**
 * What actually happened when a worker ended its turn with nothing committed.
 *
 * rc.2, observed failure (session 40f71a12-a3e5-4874-8e16-4f1cc8a0f037, sub-task
 * "Add tenant-scoped SAST persistence"). A Kimi/OpenCode worker tried to inspect
 * an XLSX with an inline Python command. The bash guard denied it correctly and
 * said what to do instead -- write a script file. The worker then ended its turn
 * with pure narration:
 *
 *   "Now let me check the workbook headers quickly, the tenant extension
 *    mechanism, and package.json prisma scripts."
 *
 * No files, no commit. The harness classified that sentence as a REFUSAL and
 * asked the operator "How should it proceed?" -- a question with no answer,
 * because the recovery was already written in the denial the worker had just
 * received.
 *
 * The classifier it went through was:
 *
 *   const looksLikeRefusal = NO_CHANGE_ONLY && !result.commitSha && text.length > 0;
 *
 * That is not refusal detection. It is "the worker said something and did not
 * commit", which is equally true of a refusal, a half-finished thought, and a
 * worker that got its command syntax wrong. Meanwhile `WorkerResult` already
 * carried `deniedToolCalls` -- the structured record of exactly which command
 * was denied and why -- and nothing consulted it.
 *
 * This module separates the outcomes that need a human from the ones the
 * harness can fix by itself. The rule behind every judgement here: a human is
 * worth interrupting only for something a human can decide. A command-format
 * mistake, a guard denial, or an unfinished sentence is not that.
 */
/** One denial, as the ACP adapter records it. */
export interface DeniedToolCall {
    kind?: string | null;
    title?: string;
    reason?: string;
}
export type WorkerOutcomeKind = 
/** A guard denial whose reason names a permitted alternative. Retry it. */
"recoverable_tool_denial"
/** The turn ended describing what it was about to do. Retry it. */
 | "progress_only"
/** Something only a human can settle. Ask. */
 | "genuine_blocker"
/** The worker declined the work on its merits. Ask. */
 | "refusal"
/** Nothing happened and the worker said nothing useful about why. Retry it. */
 | "incomplete";
export interface RecoveryGuidance {
    /** Coarse bucket for metrics: `inline_code`, `heredoc`, `git_push`, `guided`. */
    category: string;
    /** The guard's own words, verbatim. The retry prompt quotes these. */
    reason: string;
    /** The command that was denied, when the backend reported one. */
    title?: string;
    /** The permitted route to the same result, in the imperative. */
    remedy: string;
}
export interface WorkerOutcome {
    kind: WorkerOutcomeKind;
    /** Present only for `recoverable_tool_denial`. */
    recoverable?: RecoveryGuidance;
    /**
     * The worker's message with progress narration removed. `undefined` when
     * nothing substantive was left -- which is precisely when there is nothing to
     * show a human, and the old code showed them the narration anyway.
     */
    explanation?: string;
    /** Which of the human-decidable categories fired. Metrics only. */
    blockerKind?: string;
}
/**
 * Break a message into the units worth judging separately.
 *
 * Sentence level, not line level. The observed failure was a single sentence on
 * a single line, and a message can just as easily pair one narrated intention
 * with one real finding -- stitching those together is how a "blocker
 * explanation" gets assembled out of fragments that never claimed to be one.
 */
export declare function splitFragments(text: string): string[];
/** Is this fragment an announcement rather than a result? */
export declare function isProgressFragment(fragment: string): boolean;
/**
 * What is left once the announcements are removed.
 *
 * Empty means the worker reported no result at all -- and therefore that there
 * is nothing to quote at a human, however long the message was.
 */
export declare function stripProgressNarration(text: string): string;
/** The first denial that names a way forward, if any. */
export declare function recoverableDenialFrom(denied: DeniedToolCall[] | undefined): RecoveryGuidance | undefined;
/**
 * Decide what a zero-commit turn actually was.
 *
 * Precedence, strongest claim first:
 *
 *   1. An explicit refusal. The worker addressed the task and declined it; that
 *      is a position a human has to overrule, and it outranks any denial that
 *      happened along the way.
 *   2. A genuine blocker. Something external is missing.
 *   3. A recoverable denial. The guard already said what to do instead.
 *   4. Progress only. The turn ended mid-thought.
 *   5. Incomplete. Nothing happened and nothing was explained.
 *
 * Refusal and blocker are the only two that may reach a human.
 */
export declare function classifyWorkerOutcome(input: {
    finalMessage?: string;
    commitSha?: string;
    deniedToolCalls?: DeniedToolCall[];
}): WorkerOutcome;
/**
 * The verification contract in plain sentences.
 *
 * The retry prompt has to restate what will actually be checked. Dumping the
 * contract JSON invites the worker to reason about the harness's schema
 * instead of about the repository; naming the observable facts keeps the
 * conversation on what has to be true in Git when the turn ends.
 */
export declare function describeContractForRetry(contract: ReadonlyArray<{
    kind: string;
    path?: string;
    branch?: string;
    state?: string;
}> | undefined): string;
/**
 * The corrective prompt for a retry.
 *
 * Built to the rc.2 brief: quote the denial verbatim, name the permitted route,
 * restate the observable contract, forbid ending on narration, and say when the
 * worker is allowed to stop. The verbatim quote matters -- a paraphrase of a
 * guard message is another chance to describe a rule slightly wrong.
 */
export declare function buildProtocolRetryHint(params: {
    outcome: WorkerOutcome;
    /** What the harness will check, in the worker's own contract language. */
    contractSummary: string;
    /** Files the previous turn left dirty, if any. */
    uncommittedFiles?: string[];
    attempt: number;
    maxAttempts: number;
}): string;
//# sourceMappingURL=worker-outcome.d.ts.map