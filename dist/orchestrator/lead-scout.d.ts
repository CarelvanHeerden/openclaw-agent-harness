/**
 * beta.104: THE LEAD GETS TO SEE THE REPOSITORY.
 *
 * THE DEFECT, which is older and larger than any single smoke.
 *
 * Every lead call runs through `structuredCall`, which sets `tools: []` and
 * disallows `Read`, `Glob`, `Grep` and the rest. The worktree does not exist
 * yet either -- `runLeadPlanner` calls `callLeadModel` first and
 * `allocateWorktree` afterwards. So the lead plans an entire feature -- file
 * paths, code excerpts, change specs -- having never opened a single file of
 * the repository it is planning against.
 *
 * Meanwhile the lead's own prompt demands, and the b67 plan gate ENFORCES,
 * that every mutate sub-task carry `workerContext.codeExcerpts`: "the ACTUAL
 * code you read, verbatim, with path and startLine". The lead read nothing. So
 * the harness mandates plausible fabrication and then spends the rest of the
 * run detecting and repairing it:
 *
 *   - b63 ingests repo conventions -- AFTER the plan.
 *   - b76 rederives contract paths against files the run really touched.
 *   - b100 reconciles drifted test paths.
 *   - b101 flags plan paths whose parent directory does not exist.
 *   - b103 writes the corrections back into the plan.
 *
 * Five mechanisms, all downstream of one blindfold. In the b102 smoke the lead
 * planned `src/app/(app)/...` (the repo uses `(portal)`) and
 * `src/components/layout/sidebar.tsx` (the repo uses `components/ui`), and
 * `loop.plan_paths_suspect` counted SEVEN fictional paths in a single plan.
 *
 * The cost is not only correctness. The founding architecture is "smart
 * expensive planner, cheap mechanical executors": workers are explicitly told
 * not to re-explore. But context that is confidently wrong is worse than none,
 * so workers re-explore anyway -- 18 cold sub-task turns each re-deriving the
 * same repo shape the planner should have established once.
 *
 * THE FIX: a SCOUT turn. Before planning, the lead gets a real worktree and
 * READ-ONLY tools, and investigates. Its findings are handed to the existing,
 * unchanged, toolless planning call as input.
 *
 * Why two turns rather than simply giving the planning call tools: the
 * `tools: []` restriction is not incidental. b28 and b40 record the planner
 * wandering off and WRITING its plan to a file instead of returning JSON, and
 * `structuredCall`'s toolless, tightly-validated shape is what stopped that.
 * Splitting exploration from emission keeps that protection exactly as it is --
 * the JSON contract, the retry, the truncation salvage and the validation all
 * run against a call that still has no tools.
 *
 * INDEPENDENCE IS PRESERVED. The report reaches the lead and, through
 * `workerContext`, the workers. It does NOT reach the adversary: that prompt is
 * built from a hand-written projection (title, motivation, acceptance criteria)
 * in index.ts, never from the brief object, so the reviewer keeps forming its
 * own view of the diff from the diff.
 *
 * This module is pure -- prompt construction and bounding only. The SDK call
 * lives in claude-sdk.ts and the orchestration in fable5-lead.ts.
 */
/**
 * The ONLY tools the scout may use. Read-only by construction: no `Write`, no
 * `Edit`, no `Bash`, no `Task`. The scout observes; it must not be able to
 * change the worktree the run is about to build in, and it must not be able to
 * spawn sub-agents or shell out.
 */
export declare const SCOUT_ALLOWED_TOOLS: readonly ["Read", "Glob", "Grep"];
/** Tools explicitly denied, as a second layer behind the allow-list. */
export declare const SCOUT_DENIED_TOOLS: readonly ["Task", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];
/**
 * Default ceiling on the report folded into the planning prompt.
 *
 * beta.107: raised from 20000. The b106 smoke (session 06b91509) reported
 * `reportChars: 20049`, which is not a report that happened to be that long --
 * it is the exact arithmetic of `boundScoutReport` truncating at 20000 and
 * appending its notice. The scout had more to say and we cut between 1k and 10k
 * characters of it, silently, and the audit said nothing.
 */
export declare const SCOUT_REPORT_MAX_CHARS = 32000;
/**
 * beta.107: share of a truncated report kept from the TAIL.
 *
 * b104 kept the head only, reasoning that locations and conventions come first
 * and are the load-bearing part. That reasoning was right about the head and
 * wrong about the consequence: the prompt orders the report locations, then
 * excerpts, then TRAPS -- so head-only truncation removes precisely the section
 * about framework quirks, generated files and repo rules.
 *
 * The b106 run is the illustration. Its one finding that no cycle could close
 * was a repo rule (`help-content.ts` must be updated alongside a new page) that
 * the adversary raised every cycle, that no sub-task owned, and that a surviving
 * traps section is exactly what would have put into the plan.
 */
export declare const SCOUT_REPORT_TAIL_SHARE = 0.25;
/**
 * beta.106: hard ceiling on scout agent turns.
 *
 * The b105 smoke (session b08502aa) scouted for FOURTEEN MINUTES against a 600s
 * budget. A wall-clock abort cannot interrupt a tool call already in flight, so
 * the only bound that reliably holds is the SDK's own turn cap.
 *
 * The number is a judgement about what the job needs, not a guess: find an
 * analogue, read it, verify the handful of paths the plan will name, note the
 * traps. That is tens of reads, not hundreds. The prompt now states the same
 * budget in words, because a model that knows its budget spends it deliberately
 * -- the cap alone would just truncate mid-exploration.
 */
export declare const SCOUT_MAX_TURNS = 60;
export declare function buildScoutSystemPrompt(): string;
/** The scout's task framing: what the run is about to attempt. */
export declare function buildScoutUserMessage(brief: {
    title: string;
    motivation: string;
    acceptanceCriteria?: string[];
    filesLikelyTouched?: string[];
    outOfScope?: string[];
}): string;
/** What bounding did, so the audit can say so rather than leaving it to arithmetic. */
export interface ScoutReportBounds {
    text: string;
    truncated: boolean;
    /** Length of the scout's report before bounding. */
    originalChars: number;
    /** Characters removed from the middle. 0 when nothing was cut. */
    omittedChars: number;
}
/**
 * Bound the report before it is folded into the planning prompt and persisted
 * on the brief.
 *
 * beta.107: truncation is MIDDLE-OUT, keeping both ends. The head carries
 * locations and conventions, the tail carries the traps, and the excerpts in
 * between are the most compressible part of the report -- a worker that is
 * missing an excerpt reads the file, but a plan that is missing a repo rule
 * violates it and no revise cycle can find its way back. b98 remains the reason
 * a ceiling exists at all: an oversized lead input costs a whole run when the
 * reply breaches the output ceiling.
 */
export declare function boundScoutReportDetailed(text: string, maxChars?: number): ScoutReportBounds;
/** String-only wrapper, for callers that do not need the bounding detail. */
export declare function boundScoutReport(text: string, maxChars?: number): string;
/**
 * Render the report for the planning prompt.
 *
 * The framing matters as much as the content: without it the planner treats the
 * report as background reading and keeps inventing paths anyway. It is stated
 * as the authority on repo facts, and as the planner's ONLY source for them.
 */
export declare function renderScoutForPrompt(report: string | undefined): string;
//# sourceMappingURL=lead-scout.d.ts.map