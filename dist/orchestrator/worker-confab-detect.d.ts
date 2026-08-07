/**
 * beta.92 (charter item #3): LOG-ONLY worker self-contradiction detector.
 *
 * The b91 seq-6 confab: the worker's OWN final message said it "did not touch"
 * `.../[fileId]/download/route.ts`, yet that file was a contract-required
 * commit. The b84 strict verifier caught it correctly at verify time -- but the
 * worker had already lexically admitted the miss in its final message, so we
 * could bark EARLIER with a clearer error.
 *
 * SCOPE (agreed with Staging, deliberately conservative): b92 is LOG-ONLY.
 * We emit `loop.worker_confab_suspected` when the worker's finalMessage
 * contains a "not touched / already correct / left unchanged" phrase applied to
 * a file that is a contract-required path THIS sub-task must change. We do NOT
 * hard-fail on it in b92 (false-positive risk: a worker may legitimately say
 * "I did not touch X" for a not-targeted, revise-relaxed contract file). The
 * hard-fail decision is deferred to b93 once we have audit data on how often
 * this fires and whether it correlates with genuine confabs.
 *
 * Pure/deterministic. No fs, no git, no SDK.
 */
export interface ConfabProbe {
    suspected: boolean;
    /** contract-required paths the worker's message lexically claims it left alone. */
    offenders: string[];
    /** the matched "not touched" phrase (first hit), for the audit payload. */
    phrase?: string;
}
/**
 * Detect a suspected worker confabulation from its final message.
 *
 * @param finalMessage      the worker's end-of-turn message
 * @param requiredPaths     contract paths THIS sub-task is REQUIRED to change
 *                          (NOT revise-relaxed) -- a "not touched" claim about
 *                          one of these is the confab signal.
 */
export declare function detectWorkerConfab(finalMessage: string | undefined, requiredPaths: string[], 
/**
 * beta.112: paths the commit actually contains. A file that is demonstrably
 * in the diff cannot have been skipped, whatever the prose says.
 *
 * ProjectThanos PR #952 fired `worker_confab_suspected` on
 * `.../exceptions/stats/route.ts` in the same breath as a `file_committed`
 * contract check passing on it. The worker had been handed a plan-path
 * warning about that file (also wrong -- see plan-path-validate.ts) and its
 * final message discussed what it had NOT done in response. Prose lost to
 * git elsewhere in this codebase after b100; it should lose here too.
 */
committedPaths?: string[]): ConfabProbe;
//# sourceMappingURL=worker-confab-detect.d.ts.map