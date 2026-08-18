/**
 * beta.127: turn a red CI run into findings the revise loop can act on.
 *
 * Until b127 a CI failure reached exactly one place: the merge recommendation,
 * as `needs_human_review` plus a log excerpt. The loop had already finished. So
 * the harness would run four cycles of adversary review, ship, discover CI was
 * red, and write "Do NOT merge" onto a PR nobody had fixed.
 *
 * The b126 smoke is the shape of it. 33 sub-tasks, zero verification failures,
 * an extra cycle granted for converging findings, 107 minutes, $18.78 -- and a
 * PR failing 2 tests out of 8836. One was a pre-existing test the run broke by
 * inserting a sidebar entry into the middle of a group asserted to be
 * contiguous; the other was a test the run wrote itself, comparing a Date to
 * the string it becomes after JSON serialisation. Both one-liners. Neither was
 * visible to any cycle, because the only thing that runs the repo's suite is
 * CI, and CI ran after the last cycle had ended.
 *
 * This module is the translation layer: job log in, `ReviewFinding[]` out,
 * shaped so the existing revise machinery routes them like any other finding.
 */
import type { ReviewFinding } from "./fable5-adversary.js";

/** Paths that look like they belong to the repo rather than to a tool. */
const PATH_RE = /\b((?:src|app|lib|test|tests|packages|apps|prisma|components|pages|server|scripts)\/[\w.@/-]+\.[a-z]{1,4})\b/gi;

/** A jest/vitest per-file failure header. */
const FAIL_FILE_RE = /^\s*(?:FAIL|✕\s+FAIL)\s+(\S+)/;

/** The test name jest prints under a failing file. */
const TEST_NAME_RE = /^\s*●\s+(.+?)\s*$/;

/** Lines that are jest's own epilogue rather than a failure. */
const EPILOGUE_RE = /^(Test Suites:|Tests:|Snapshots:|Time:|Ran all test suites|Test results written)/;

function uniq(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

function pathsIn(text: string): string[] {
  return uniq([...text.matchAll(PATH_RE)].map((m) => m[1]!));
}

/**
 * Split a log excerpt into one block per failing test file.
 *
 * Falls back to a single unattributed block when the runner is not one we
 * recognise, which still produces a usable finding -- it just broadcasts
 * instead of routing.
 */
function splitByFailingFile(lines: string[]): Array<{ file: string; body: string[] }> {
  const blocks: Array<{ file: string; body: string[] }> = [];
  let current: { file: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = FAIL_FILE_RE.exec(line);
    if (m) {
      if (current) blocks.push(current);
      current = { file: m[1]!, body: [] };
      continue;
    }
    if (EPILOGUE_RE.test(line.trim())) {
      if (current) { blocks.push(current); current = null; }
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

export interface CiFindingOptions {
  /** Cap on findings produced, so a catastrophic red build cannot flood a cycle. */
  maxFindings?: number;
  /** The commit CI actually ran against, quoted in the detail. */
  sha?: string;
}

/**
 * Build blocking findings from the failing-CI log excerpt.
 *
 * Each finding carries:
 *   - `file`: the failing TEST file, so the sub-task that owns it is targeted.
 *   - `relatedFiles`: every repo path named in the failure body, so co-fix
 *     routing can reach the source file when the test names it.
 *   - `detail`: the verbatim excerpt, because the worker needs the assertion,
 *     not a summary of it.
 *
 * When no file can be identified the finding is returned with no `file`, which
 * the mapper treats as a miss and broadcasts to every sub-task. That is the
 * right default: a red build is a property of the whole branch, and it is
 * better to show it to everyone than to route it confidently to the wrong
 * owner.
 */
export function buildCiFailureFindings(logs: string, opts: CiFindingOptions = {}): ReviewFinding[] {
  const max = opts.maxFindings ?? 6;
  const text = (logs ?? "").trim();
  if (!text) return [];

  const lines = text.split("\n");
  const blocks = splitByFailingFile(lines);
  const shaNote = opts.sha ? ` on ${opts.sha.slice(0, 8)}` : "";

  if (blocks.length === 0) {
    // Unrecognised runner, or a failure with no per-file structure (a build
    // step, a lint run, an install). Still blocking, just unrouted.
    const related = pathsIn(text);
    return [{
      source: "ci",
      dimension: "quality",
      severity: "high",
      title: `CI is failing${shaNote}`,
      detail:
        `GitHub CI failed on this branch. This is the repository's own pipeline running against ` +
        `the exact commit this run produced, so it is not advisory.\n\n` +
        `Failing output:\n${text.slice(0, 3000)}`,
      file: related[0] ?? null,
      relatedFiles: related.length > 1 ? related.slice(1, 8) : null,
    }];
  }

  const findings: ReviewFinding[] = [];
  for (const block of blocks.slice(0, max)) {
    const body = block.body.join("\n").trim();
    const testName = block.body.map((l) => TEST_NAME_RE.exec(l)?.[1]).find(Boolean);
    // The source files a fix probably lives in are the ones the failure text
    // names that are not the test file itself.
    const related = pathsIn(body).filter((p) => p !== block.file);
    findings.push({
      source: "ci",
      dimension: "quality",
      severity: "high",
      title: testName
        ? `CI: ${block.file} — ${testName.slice(0, 120)}`
        : `CI: ${block.file} is failing`,
      detail:
        `This test fails in GitHub CI${shaNote}. It ran against the exact commit this run produced, ` +
        `so it is a fact about the branch rather than a review opinion. Fix the cause; do not ` +
        `delete, skip or weaken the test to make it pass.\n\n` +
        `${body.slice(0, 2500)}`,
      file: block.file,
      relatedFiles: related.length > 0 ? related.slice(0, 8) : null,
    });
  }

  if (blocks.length > max) {
    findings.push({
      source: "ci",
      dimension: "quality",
      severity: "high",
      title: `CI has ${blocks.length} failing test files${shaNote}`,
      detail:
        `${blocks.length} test files are failing; the first ${max} are itemised as separate findings. ` +
        `A failure count this size usually has one shared cause -- look for it before fixing them one by one.\n\n` +
        `All failing files:\n${blocks.map((b) => `  - ${b.file}`).join("\n")}`,
      file: null,
      relatedFiles: null,
    });
  }

  return findings;
}

/**
 * beta.131: the title of the sub-task that owns an unroutable CI failure.
 *
 * Stable, because a second repair cycle finds the existing one by it rather
 * than adding another.
 */
export const CI_REPAIR_SUBTASK_TITLE = "Fix the failing CI check";

/**
 * beta.131: the brief handed to the sub-task above.
 *
 * The raw failing output verbatim, because the whole reason this sub-task
 * exists is that nothing in the harness could work out which file to blame --
 * so summarising it would throw away the only evidence there is.
 */
export function renderCiRepairIntent(detail: string): string {
  return [
    "GitHub CI is failing on this branch and the failing output did not name a file, so no other",
    "sub-task could be given this to fix. That is why this one exists.",
    "",
    "Read the output below, work out which file is actually responsible, and fix the cause there.",
    "You are not limited to any declared file scope for this task -- but stay inside the change this",
    "run was asked to make, and do not rewrite unrelated code you happen to pass on the way.",
    "",
    "Do NOT delete, skip, rename or weaken a test to make the check pass. If the test is correct and",
    "the code is wrong, fix the code. If the test genuinely encodes the old behaviour and this run",
    "deliberately changed it, update the test to assert the NEW behaviour and say so in your summary.",
    "",
    "Failing CI output:",
    detail,
  ].join("\n");
}

/**
 * A short, stable line for the audit trail and the ship note.
 */
export function describeCiFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "no CI findings";
  const files = uniq(findings.map((f) => f.file ?? "").filter(Boolean));
  return files.length > 0
    ? `${findings.length} CI finding(s) across ${files.length} file(s): ${files.slice(0, 5).join(", ")}`
    : `${findings.length} CI finding(s), unrouted`;
}
