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
export const SCOUT_ALLOWED_TOOLS = ["Read", "Glob", "Grep"];
/** Tools explicitly denied, as a second layer behind the allow-list. */
export const SCOUT_DENIED_TOOLS = ["Task", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];
/**
 * Default ceiling on the report folded into the planning prompt.
 *
 * beta.107: raised from 20000. The b106 smoke (session 06b91509) reported
 * `reportChars: 20049`, which is not a report that happened to be that long --
 * it is the exact arithmetic of `boundScoutReport` truncating at 20000 and
 * appending its notice. The scout had more to say and we cut between 1k and 10k
 * characters of it, silently, and the audit said nothing.
 */
export const SCOUT_REPORT_MAX_CHARS = 32000;
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
export const SCOUT_REPORT_TAIL_SHARE = 0.25;
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
export const SCOUT_MAX_TURNS = 60;
export function buildScoutSystemPrompt() {
    return [
        "You are the lead planner's SCOUT. You are about to plan a change to this repository, and this turn is your ONE chance to look at it.",
        "",
        "You have READ-ONLY tools: Read, Glob, Grep. You cannot write, edit, or run commands. Do not try.",
        "",
        "## Why this turn exists",
        "In the next turn you must produce an implementation plan naming REAL file paths and quoting REAL code, and you will have NO repo access then. Cheap worker models execute your plan mechanically and are told not to re-explore. If you name a path that does not exist, they either write to the wrong place or waste a turn rediscovering the right one. Everything you fail to establish now becomes a guess later.",
        "",
        "## What to establish",
        "1. WHERE this kind of code actually lives. Do not assume conventional layouts. Find a close existing analogue of what is being asked for and read it. If the repo uses route groups, nested app directories, or an unusual test location, find out now -- these are the details that are most often guessed wrong.",
        "2. The EXACT paths you intend the plan to touch. Verify each one with Glob or Read. For a file that does not exist yet, verify its PARENT DIRECTORY exists and name a sibling that proves the convention.",
        "3. The code a worker will need to see: the analogue's imports, the auth/validation wrapper the repo uses, the shared helpers, the schema or model style. Quote the real lines with their paths.",
        "4. Traps: framework version quirks, generated files, repo rules that apply to this change.",
        "",
        "## Your budget",
        `You have roughly ${SCOUT_MAX_TURNS} tool calls and a few minutes of wall clock. That is deliberately enough to find ONE good analogue, read it properly, verify the specific paths the plan will name, and note the traps -- and deliberately NOT enough to survey the codebase.`,
        "Go straight at the analogue. Glob for the feature area, read the closest match, and follow only the imports a worker will actually need. Do not enumerate directories you have no plan to touch, do not read a file twice, and do not keep looking for confirmation once you have an answer.",
        "Stop as soon as you can name the real paths and quote the real code. Running out of budget mid-exploration is far worse than reporting early with an honest gap: the planner proceeds with whatever you had.",
        "There is a length ceiling on the report. If you exceed it the MIDDLE is dropped and both ends are kept, so put the locations at the very start and the traps at the very end, and let the excerpts in the middle be the part that gives way.",
        "",
        "## How to report",
        "Reply in plain prose and code blocks -- NOT JSON, this turn has no schema.",
        "Write the report as you go rather than saving it all for the end, so a partial report is still useful. Locations and conventions FIRST, code excerpts next, traps last.",
        "Anchor every claim to a path you actually opened. Quote code verbatim with its file path and line numbers.",
        "If you could not determine something, SAY SO explicitly and say what you checked. An honest gap is useful; a confident guess is the exact failure this turn exists to prevent.",
        "Do not write the plan itself. Report what you found; the planning turn will decompose it.",
    ].join("\n");
}
/** The scout's task framing: what the run is about to attempt. */
export function buildScoutUserMessage(brief) {
    const lines = [
        `Investigate this repository so the change below can be planned against reality.`,
        ``,
        `Title: ${brief.title}`,
        `Motivation: ${brief.motivation}`,
    ];
    const ac = brief.acceptanceCriteria ?? [];
    if (ac.length > 0) {
        lines.push(`Acceptance criteria:`, ...ac.map((c) => `  - ${c}`));
    }
    const guess = (brief.filesLikelyTouched ?? []).filter(Boolean);
    if (guess.length > 0) {
        lines.push(``, `The upstream request guessed these paths. Treat them as UNVERIFIED and check each one -- confirm it, or find the real location and say what it actually is:`, ...guess.map((f) => `  - ${f}`));
    }
    const out = (brief.outOfScope ?? []).filter(Boolean);
    if (out.length > 0) {
        lines.push(``, `Explicitly out of scope:`, ...out.map((f) => `  - ${f}`));
    }
    return lines.join("\n");
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
export function boundScoutReportDetailed(text, maxChars = SCOUT_REPORT_MAX_CHARS) {
    const t = (text ?? "").trim();
    const originalChars = t.length;
    if (!t)
        return { text: "", truncated: false, originalChars: 0, omittedChars: 0 };
    if (maxChars <= 0 || originalChars <= maxChars) {
        return { text: t, truncated: false, originalChars, omittedChars: 0 };
    }
    const tail = Math.floor(maxChars * SCOUT_REPORT_TAIL_SHARE);
    const head = maxChars - tail;
    const omittedChars = originalChars - maxChars;
    const notice = `\n\n... (repo report truncated in the middle, ${omittedChars} chars omitted; the closing section follows)\n\n`;
    return {
        text: `${t.slice(0, head)}${notice}${t.slice(originalChars - tail)}`,
        truncated: true,
        originalChars,
        omittedChars,
    };
}
/** String-only wrapper, for callers that do not need the bounding detail. */
export function boundScoutReport(text, maxChars = SCOUT_REPORT_MAX_CHARS) {
    return boundScoutReportDetailed(text, maxChars).text;
}
/**
 * Render the report for the planning prompt.
 *
 * The framing matters as much as the content: without it the planner treats the
 * report as background reading and keeps inventing paths anyway. It is stated
 * as the authority on repo facts, and as the planner's ONLY source for them.
 */
export function renderScoutForPrompt(report) {
    const r = (report ?? "").trim();
    if (!r)
        return "";
    return [
        "",
        "## Repo investigation (YOUR OWN findings from this repository)",
        "You investigated this repository in the previous turn. Below is your report. You have NO repo access now, so this is the ONLY source of repo facts available to you.",
        "Every path you name in `filesLikelyTouched` and `verify`, and every excerpt you put in `workerContext.codeExcerpts`, MUST come from this report. Do NOT invent a path that does not appear here, and do NOT reconstruct code from memory of similar projects.",
        "Where the report says a location could not be determined, plan a short observe sub-task to establish it rather than guessing.",
        "",
        r,
    ].join("\n");
}
//# sourceMappingURL=lead-scout.js.map