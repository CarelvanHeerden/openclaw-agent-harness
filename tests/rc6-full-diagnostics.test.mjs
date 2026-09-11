/**
 * rc.6 fix #3 — a display limit is not an analysis limit.
 *
 * THE INCIDENT (StitchGuard PR #1184). The check-script runner returned exactly
 * one copy of a script's output: `outputTail`, the last 4,000 characters. The
 * typecheck gate then called `parseTscErrors(r.outputTail)` on it.
 *
 * The compliance-calendar branch's compiler run produced 40 diagnostics across
 * three changed test files:
 *
 *   - 38 transaction-runner mock cast errors in compliance-calendar-mutations
 *   - 1 unsupported Jest matcher (`toHaveSize`) in the event-types service test
 *   - 1 component overload error in the page test
 *
 * The last 4,000 characters held ONE of them. Three revise cycles were spent
 * routing workers at that single file, each ending with the gate reporting
 * "1 error(s) ... in file(s) this branch changed", while 39 diagnostics in two
 * other files stayed broken and shipped to a red CI.
 *
 * Two separate compressions, so two separate fixes:
 *
 *   1. the runner keeps the whole capture for analysis (`output`), and
 *      truncates only the copy that is displayed and prompted with, and
 *   2. the finding routes at every affected file, not the first one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let gate, conventions;
try {
  gate = await import("../dist/orchestrator/typecheck-gate.js");
  conventions = await import("../dist/orchestrator/repo-conventions.js");
} catch {
  gate = null;
}
const skip = gate === null ? "dist/ not built" : false;
const here = dirname(fileURLToPath(import.meta.url));

/**
 * The incident's diagnostic set, at the shape and scale tsc actually emits:
 * a code frame under each error, ~350 characters apiece.
 */
function stitchGuardTypecheckOutput() {
  const frame = (file, line, code, msg) =>
    `${file}(${line},13): error ${code}: ${msg}\n` +
    `\n  ${line}     await runInTransaction(mockTx as unknown as TransactionRunner, async (tx) => {\n` +
    `      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n` +
    `    src/lib/db/transaction.ts:42:3\n      42   runner: TransactionRunner,\n         ~~~~~~\n` +
    `    The expected type comes from property 'runner'.\n\n`;
  const parts = [];
  // The two lone diagnostics come FIRST, which is what puts them outside a tail.
  parts.push(frame("src/__tests__/api/grc/compliance-calendar-event-types-service.test.ts", 309, "TS2339",
    "Property 'toHaveSize' does not exist on type 'JestMatchers<number>'."));
  parts.push(frame("src/__tests__/components/compliance-calendar-page.test.tsx", 581, "TS2769",
    "No overload matches this call."));
  for (let i = 0; i < 38; i++) {
    parts.push(frame("src/__tests__/lib/grc/compliance-calendar-mutations.test.ts", 803 + i, "TS2345",
      "Argument of type 'Mock<...>' is not assignable to parameter of type 'TransactionRunner'."));
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// 1. The loss, and that it is gone
// ---------------------------------------------------------------------------

test("rc6: the 4,000-character tail loses most of the compiler's diagnostics", { skip }, () => {
  // Not a regression test -- a demonstration that the mechanism is real, so the
  // fix below is measured against the actual loss rather than an assumed one.
  const full = stitchGuardTypecheckOutput();
  const fromFull = gate.parseTscErrors(full);
  const fromTail = gate.parseTscErrors(full.slice(-4000));

  assert.equal(fromFull.length, 40, "the compiler reported 40");
  assert.ok(fromTail.length < 15, `the tail sees ${fromTail.length}`);
  const filesIn = (errs) => new Set(errs.map((e) => e.file));
  assert.equal(filesIn(fromFull).size, 3);
  assert.equal(filesIn(fromTail).size, 1, "and only one of the three files, which is what got repaired");
});

test("rc6: the runner returns a full capture alongside the display tail", { skip }, () => {
  const full = stitchGuardTypecheckOutput();
  const [r] = conventions.runCheckScripts({
    repoRoot: "/tmp/x",
    discovered: [{ name: "typecheck", command: "tsc --noEmit" }],
    allowlist: ["typecheck"],
    timeoutSeconds: 60,
    runScript: () => ({ status: 2, stdout: full, stderr: "" }),
  });

  assert.equal(r.ran, true);
  assert.equal(r.exitCode, 2);
  assert.equal(r.output, full, "analysis gets the whole stream");
  assert.equal(r.outputTail.length, 4000, "display stays bounded");
  assert.ok(r.output.length > r.outputTail.length);
  assert.equal(r.outputTruncated, undefined, "nothing was clipped at this size");
  assert.equal(gate.parseTscErrors(r.output).length, 40, "and all 40 survive the runner");
});

test("rc6: the analysis ceiling still exists, and says when it bit", { skip }, () => {
  const huge = "x".repeat(conventions.OUTPUT_ANALYSIS_CHARS + 5000);
  const [r] = conventions.runCheckScripts({
    repoRoot: "/tmp/x",
    discovered: [{ name: "typecheck", command: "tsc --noEmit" }],
    allowlist: ["typecheck"],
    timeoutSeconds: 60,
    runScript: () => ({ status: 2, stdout: huge, stderr: "" }),
  });

  assert.equal(r.output.length, conventions.OUTPUT_ANALYSIS_CHARS, "a runaway script cannot exhaust memory");
  assert.equal(r.outputTruncated, true, "and 'we saw everything' must stay distinct from 'we saw our limit'");
});

test("rc6: a clean or empty run is unchanged by the second capture", { skip }, () => {
  const [ok] = conventions.runCheckScripts({
    repoRoot: "/tmp/x",
    discovered: [{ name: "typecheck", command: "tsc --noEmit" }],
    allowlist: ["typecheck"],
    timeoutSeconds: 60,
    runScript: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.output, "");
  assert.equal(ok.outputTail, "");

  const [skipped] = conventions.runCheckScripts({
    repoRoot: "/tmp/x",
    discovered: [{ name: "lint", command: "eslint ." }],
    allowlist: ["typecheck"],
    timeoutSeconds: 60,
    runScript: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.equal(skipped.ran, false);
  assert.equal(skipped.output, "", "a skipped script still has the field, so callers need no fallback");
});

// ---------------------------------------------------------------------------
// 2. The gate reads the full capture
// ---------------------------------------------------------------------------

test("rc6: analysis reads the full capture, not the display tail", { skip }, () => {
  const full = stitchGuardTypecheckOutput();
  const result = { output: full, outputTail: full.slice(-4000) };

  assert.equal(gate.diagnosticsFrom(result).length, 40, "the tail would have yielded a handful");
  assert.ok(
    gate.diagnosticsFrom(result).length > gate.parseTscErrors(result.outputTail).length,
    "and that difference is the whole point of the field",
  );
  const files = new Set(gate.diagnosticsFrom(result).map((e) => e.file));
  assert.equal(files.size, 3, "all three broken files must be visible to repair routing");
});

test("rc6: a synthesised result with only a tail still parses rather than throwing", { skip }, () => {
  // The direct-compiler fallback builds its own result. The fallback must not
  // be the thing that makes the gate return "no diagnostics" on a failed run.
  const errs = gate.diagnosticsFrom({ outputTail: "src/a.ts(1,2): error TS2551: nope" });
  assert.equal(errs.length, 1);
  assert.deepEqual(gate.diagnosticsFrom({}), []);
});

test("rc6: the gate routes both of its parses through the full-capture rule", { skip }, () => {
  const src = readFileSync(resolve(here, "..", "src", "orchestrator", "loop.ts"), "utf8");
  assert.equal(
    (src.match(/diagnosticsFrom\(r\)/g) ?? []).length,
    2,
    "the primary parse and the wrapper-retry parse must both use it",
  );
  assert.doesNotMatch(src, /parseTscErrors\(/, "no call site may reach the raw parser with a tail again");
});

// ---------------------------------------------------------------------------
// 3. Routing reaches every affected file
// ---------------------------------------------------------------------------

test("rc6: the finding names every affected file, not just the first", { skip }, () => {
  const errors = gate.parseTscErrors(stitchGuardTypecheckOutput());
  const finding = gate.buildTypecheckFinding(errors, "typecheck");

  assert.match(finding.title, /40 error\(s\)/);
  assert.match(finding.title, /3 file\(s\)/, "the title carried '1 file' through three repair cycles");

  const named = [finding.file, ...(finding.relatedFiles ?? [])];
  assert.equal(named.length, 3, "a fix spanning three files must hand a worker all three");
  for (const f of ["compliance-calendar-mutations.test.ts", "compliance-calendar-page.test.tsx",
    "compliance-calendar-event-types-service.test.ts"]) {
    assert.ok(named.some((n) => n.endsWith(f)), `${f} must reach routing`);
  }
});

test("rc6: the sample reaches every file, even when one file holds most errors", { skip }, () => {
  // 38 of the 40 are in one file. Listing the first ten errors shows only that
  // file, which is how the other two stayed invisible for three cycles.
  const errors = gate.parseTscErrors(stitchGuardTypecheckOutput());
  const detail = gate.buildTypecheckFinding(errors, "typecheck").detail;
  for (const f of ["compliance-calendar-mutations.test.ts", "compliance-calendar-page.test.tsx",
    "compliance-calendar-event-types-service.test.ts"]) {
    assert.ok(detail.includes(f), `${f} must appear in the detail a worker reads`);
  }
  assert.match(detail, /Every affected file must be fixed/);
});

test("rc6: the detail stays bounded when the errors are spread very wide", { skip }, () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    file: `src/f${i}.ts`, line: i + 1, column: 1, code: "TS2551", message: "nope",
  }));
  const finding = gate.buildTypecheckFinding(many, "typecheck");
  assert.ok(finding.detail.length < 4000, "naming every file must not itself blow the review prompt");
  assert.match(finding.detail, /more file\(s\)/, "and the omission has to be disclosed");
  assert.equal(finding.relatedFiles.length, 119, "routing is structured data, so it keeps all of them");
});

test("rc6: a single-file failure gains no spurious related files", { skip }, () => {
  const finding = gate.buildTypecheckFinding(
    [{ file: "src/a.ts", line: 1, column: 1, code: "TS2551", message: "nope" }],
    "typecheck",
  );
  assert.equal(finding.file, "src/a.ts");
  assert.equal(finding.relatedFiles, undefined, "one file is one file");
  assert.match(finding.title, /1 file\(s\)/);
});
