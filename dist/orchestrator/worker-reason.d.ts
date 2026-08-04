/**
 * beta.101: EXTRACT THE WORKER'S ACTUAL REASON FOR A PATH DEVIATION.
 *
 * b100's Fix 2 asks a human to adjudicate "was the plan's path wrong, or the
 * worker's placement?" and quotes the worker's justification to inform that
 * call. It sourced the quote from the FIRST non-empty line of the worker's
 * final message, which assumes workers lead with their reasoning. They do not.
 *
 * In the b100 smoke the operator was shown:
 *
 *   "The worker's stated reason: That's fine, it's a harmless temp file outside
 *    the repo. Sub-task complete."
 *
 * -- a remark about an unrelated temp file. The worker's real reason (the
 * planned nav file did not exist, so it edited the actual sidebar component)
 * was further down the message. The one input a human needs to decide correctly
 * was actively misleading.
 *
 * So instead of position, select on RELEVANCE: prefer a sentence that names one
 * of the paths under dispute or explains a placement decision, and fall back to
 * the old first-line behaviour only when nothing in the message qualifies.
 */
/**
 * Pure. Returns the most likely explanation for why the worker's files differ
 * from its contract, bounded to `maxChars`, or "" when the message is empty.
 *
 * Scoring, highest first: naming a disputed path (or its basename) is the
 * strongest signal of relevance; a deviation cue is the next strongest; a
 * sentence with both wins outright.
 */
export declare function extractStatedReason(finalMessage: string, expectedPaths?: string[], actualPaths?: string[], maxChars?: number): string;
//# sourceMappingURL=worker-reason.d.ts.map