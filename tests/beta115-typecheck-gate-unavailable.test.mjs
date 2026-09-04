/**
 * beta.115: a typecheck gate that could not run must not read as a pass.
 *
 * The b114 DR/BCP run (session 532c706b) had the gate ENABLED, the repo had a
 * `typecheck` script, and the gate still skipped all three cycles:
 *
 *   loop.typecheck_gate_skipped cycle=1..3
 *     reason="env_unavailable: check-script binary missing (exit 127 / command not found)"
 *
 * A skip returned `[]`, and no findings reads as clean, so the loop reached a
 * `pass` verdict and shipped PR #964 -- whose CI then failed on exactly one
 * error, in a file the branch had changed:
 *
 *   src/app/api/grc/continuity-exercises/[id]/route.ts(118,12): error TS2551:
 *   Property 'updatedById' does not exist on type 'ContinuityExerciseUpdateInput'
 *
 * CI found it with `npx tsc --noEmit` on the same tree, which is the proof that
 * the compiler was reachable and only the `npm run` indirection was broken.
 *
 * These tests use REAL processes against REAL temp trees, because the entire
 * defect lives in process exit codes and binary resolution -- a mocked spawn
 * would have cheerfully "passed" the broken behaviour, which is precisely how
 * this shipped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTypecheckDirect, diagnoseCheckEnv } from "../dist/orchestrator/typecheck-fallback.js";

const dirs = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "oah-b115-"));
  dirs.push(d);
  return d;
};
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fake `tsc` in node_modules/.bin that behaves like the real one. */
function fakeTsc(dir, { exitCode = 0, output = "", executable = true } = {}) {
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const p = join(bin, "tsc");
  writeFileSync(p, `#!/bin/sh\n${output ? `echo ${JSON.stringify(output)}` : ""}\nexit ${exitCode}\n`);
  chmodSync(p, executable ? 0o755 : 0o644);
  return p;
}

// ---------------------------------------------------------------------------
// The fallback: reaching the compiler when the npm script cannot be reached
// ---------------------------------------------------------------------------

test("beta115: the repo's own pinned tsc is used, and its errors come back", () => {
  const dir = mk();
  // The exact error CI found on PR #964, which the gate reported nothing about.
  const tsErr = "src/app/api/grc/continuity-exercises/[id]/route.ts(118,12): error TS2551: Property 'updatedById' does not exist on type 'ContinuityExerciseUpdateInput'.";
  fakeTsc(dir, { exitCode: 2, output: tsErr });

  const r = runTypecheckDirect(dir, 30_000);
  assert.ok(r, "the compiler is right there in node_modules; the gate must find it");
  assert.equal(r.via, "node_modules_bin", "prefer the repo's own pinned binary");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /TS2551/, "the error text must reach the caller, not be swallowed");
});

test("beta115: a clean tree reports a clean run, not a missing one", () => {
  const dir = mk();
  fakeTsc(dir, { exitCode: 0 });
  const r = runTypecheckDirect(dir, 30_000);
  assert.equal(r.status, 0);
});

test("beta115: a non-executable tsc is not mistaken for a working one", () => {
  const dir = mk();
  // The b73 noexec-mount shape: the file is present but the OS refuses it.
  fakeTsc(dir, { executable: false });
  const r = runTypecheckDirect(dir, 30_000);
  // Either no route at all, or it fell through to npx -- what must NOT happen
  // is claiming a successful run from the binary that cannot execute.
  if (r) assert.notEqual(r.via, "node_modules_bin", "a 126 must not be reported as a run");
});

test("beta115: with no compiler anywhere, the fallback admits defeat", () => {
  const dir = mk();
  // No node_modules and an empty PATH: npx itself is unreachable, so there is
  // genuinely no route. The contract is null -- never a fabricated clean run.
  const r = runTypecheckDirect(dir, 30_000, { env: { PATH: "/nonexistent" } });
  assert.equal(r, null, "no route must return null so the caller can report unavailable");
});

test("rc1: the fallback never invokes package-installing discovery", () => {
  const dir = mk();
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { status: 127, stdout: "", stderr: "command not found" };
  };
  runTypecheckDirect(dir, 30_000, { spawn });
  assert.deepEqual(calls, [], "without a pinned local compiler, do not invoke npx or any package manager");
});

test("rc1: the observe-task scripted verifier also uses the pinned fallback", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = index.indexOf("runScriptedTsc:");
  const body = index.slice(start, start + 700);
  assert.match(body, /runTypecheckDirect\(worktreePath, timeoutMs\)/);
  assert.doesNotMatch(body, /\bnpx\b|spawnSync\(/);
});

test("rc1: a 127 from the pinned compiler is unavailable, not an npx fallback", () => {
  const dir = mk();
  const seen = [];
  const spawn = (cmd, args) => {
    seen.push(cmd);
    return { status: 127, stdout: "", stderr: "sh: tsc: command not found" };
  };
  fakeTsc(dir);
  const r = runTypecheckDirect(dir, 30_000, { spawn });
  assert.equal(r, null);
  assert.equal(seen.length, 1, "only the repository-pinned compiler may be attempted");
});

test("rc1: a silent 127 is unavailable and never falls through to package resolution", () => {
  const dir = mk();
  // The dangerous shape, and the one that produced this whole release: a route
  // that exits 127 having printed NOTHING. Sniffing the output for "command not
  // found" cannot save us here -- there is no output to sniff. If the exit code
  // is not honoured, an empty stdout gets parsed for TS errors, zero are found,
  // and a branch that was never compiled is reported as compiling cleanly.
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return { status: 127, stdout: "", stderr: "" };
  };
  fakeTsc(dir);
  const r = runTypecheckDirect(dir, 30_000, { spawn });
  assert.equal(r, null);
  assert.equal(calls, 1);
});

test("beta115: when every route exits 127 in silence, the answer is null", () => {
  const dir = mk();
  const spawn = () => ({ status: 127, stdout: "", stderr: "" });
  fakeTsc(dir);
  assert.equal(
    runTypecheckDirect(dir, 30_000, { spawn }),
    null,
    "an unrunnable compiler must never be reported as a run that found no errors",
  );
});

// ---------------------------------------------------------------------------
// The diagnosis: explaining a 127 without needing the worktree to still exist
// ---------------------------------------------------------------------------

test("beta115: a healthy worktree diagnoses as healthy", () => {
  const dir = mk();
  fakeTsc(dir);
  const d = diagnoseCheckEnv(dir);
  assert.equal(d.nodeModules, "present");
  assert.equal(d.binDir, "present");
  assert.equal(d.tsc, "executable");
});

test("beta115: the aborted-install shape is visible in the diagnosis", () => {
  const dir = mk();
  // b114's worktree was reclaimed before anyone could look at it, so the 127
  // was never explained. An entry count separates "npm ci died early" from
  // "node_modules was never created".
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  const d = diagnoseCheckEnv(dir);
  assert.equal(d.nodeModules, "present");
  assert.equal(d.nodeModulesEntries, 0, "a present-but-empty tree is the signature of an aborted install");
  assert.equal(d.tsc, "missing");
  assert.equal(d.binDir, "missing");
});

test("beta115: a present-but-unexecutable tsc is distinguished from a missing one", () => {
  const dir = mk();
  fakeTsc(dir, { executable: false });
  assert.equal(diagnoseCheckEnv(dir).tsc, "present_not_executable", "noexec and absent need different fixes");
});

test("beta115: a dangling symlink is not reported as an executable compiler", () => {
  const dir = mk();
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(dir, "node_modules", "typescript", "bin", "tsc"), join(bin, "tsc"));
  assert.notEqual(diagnoseCheckEnv(dir).tsc, "executable", "a link to nothing is not a compiler");
});

test("beta115: npm's absence from PATH is recorded", () => {
  const dir = mk();
  assert.equal(diagnoseCheckEnv(dir, { env: { PATH: "/nonexistent" } }).npm, "not_on_path");
  assert.equal(diagnoseCheckEnv(dir).npm, "on_path");
});

test("beta115: the diagnosis survives JSON, since it goes into the audit log", () => {
  const dir = mk();
  fakeTsc(dir);
  const round = JSON.parse(JSON.stringify(diagnoseCheckEnv(dir)));
  assert.equal(round.tsc, "executable");
  assert.ok((round.path ?? "").length <= 400, "PATH is trimmed so it cannot bloat every audit row");
});

// ---------------------------------------------------------------------------
// The wiring: what the loop does when no route exists
// ---------------------------------------------------------------------------

test("beta115: an unavailable gate blocks the merge but does not drive revise cycles", async () => {
  const { classifyFinding, isBlockingFinding } = await import("../dist/orchestrator/finding-classify.js");
  // The finding the gate emits when nothing can run. Its two required
  // properties pull in opposite directions and both matter:
  //   - it must STOP a merge recommendation (>= medium severity), and
  //   - it must NOT sustain revise cycles, because no code change can repair a
  //     missing binary; the worktree bootstrap owns that.
  //
  // rc.3: `source: "harness_env"` is now what makes this `env`, rather than
  // "command not found" appearing in the detail text. The rc.3 rule that a HIGH
  // severity finding is not demoted on keywords would otherwise promote this
  // one, and it is deliberately high (to stop the merge) AND deliberately
  // non-blocking (no code change repairs a missing binary). The marker states
  // that directly instead of relying on the wording.
  const f = {
    title: "Typecheck gate could not run: the branch is unverified, not verified",
    detail: "The repo declares a `typecheck` script but it could not be executed (exit 127 / command not found) and invoking the compiler directly did not work either.",
    severity: "high",
    dimension: "runtime",
    source: "harness_env",
  };
  const cls = classifyFinding(f);
  assert.equal(cls, "env", "env/tooling breakage, not a diff defect");

  // The marker is what the loop actually emits, not just what this test passes.
  const { readFileSync } = await import("node:fs");
  const loopSrc = readFileSync(new URL("../src/orchestrator/loop.ts", import.meta.url), "utf8");
  const emitted = loopSrc.slice(loopSrc.indexOf("Typecheck gate could not run"));
  assert.match(emitted.slice(0, 1200), /source: "harness_env"/);
  assert.equal(isBlockingFinding(f, cls), false, "a worker cannot fix a missing binary, so this must not cycle");

  const { deriveMergeRecommendation } = await import("../dist/orchestrator/merge-recommendation.js");
  const rec = deriveMergeRecommendation({ verdict: "pass", findings: [f] });
  assert.notEqual(rec.recommendation, "merge", "an unverified branch must never be recommended for merge");
});

test("beta115: the gate's own source keeps the unavailable path loud", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/orchestrator/loop.ts", import.meta.url), "utf8");
  const gate = src.slice(src.indexOf("private async runTypecheckGate"));
  const body = gate.slice(0, gate.indexOf("\n  private ", 10));
  assert.match(body, /typecheck_gate_unavailable/, "the no-route case must be its own audit event, not a generic skip");
  assert.match(body, /runTypecheckDirect/, "the skip path must attempt the direct route before giving up");
  assert.match(body, /severity:\s*"high"/, "an unverifiable branch is a high-severity fact about the review");
});
