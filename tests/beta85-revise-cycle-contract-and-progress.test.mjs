/**
 * beta.85 — the REAL recurring-failure fix: revise-cycle-aware contracts.
 *
 * ROOT CAUSE (session 696226e4 cyc2 seq7, DB-confirmed by Staging; and the
 * inverse-signature 1c744d70): on a revise cycle the sub-task's contract still
 * carries its CYCLE-1 shape (e.g. BOTH `[fileId]/route.ts` AND
 * `[fileId]/download/route.ts`). A revise only needs to change the file(s) the
 * review FLAGGED. A contract file the review did NOT target was already shipped
 * correctly in a prior cycle and the worker correctly leaves it untouched
 * (buildReviseDispatchHint literally tells it "if none apply, make NO changes").
 * But the `file_written` mtime probe demanded a FRESH write this sub-task and
 * false-failed the correct, already-committed file.
 *
 * FIX: on cycle > 1, a `file_written`/`file_committed` contract entry whose path
 * is NOT named by any current review finding is marked `reviseRelaxed` -> verify
 * accepts "present + committed anywhere in the branch range" (new
 * `fileCommittedInBranch` probe) instead of a fresh write. A TARGETED file keeps
 * the strict fresh requirement.
 *
 * ORACLE (both shapes, same fix):
 *  - 1c744d70: the review TARGETED the file the worker skipped -> strict -> FAIL.
 *  - 696226e4: the review did NOT target the already-correct file -> relaxed -> PASS.
 *
 * Plus: scripted_verify_fallback default OFF (no local suite runs, ever),
 * deps-bootstrap ERESOLVE hardening, and per-sub-task native progress.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const readSrc = (rel) => readFileSync(join(ROOT, rel), "utf8");

let verifySubTaskOutput;
try {
  ({ verifySubTaskOutput } = await import("../dist/orchestrator/verify.js"));
} catch {
  verifySubTaskOutput = null;
}
const skip = { skip: verifySubTaskOutput === null };

const ROUTE = "src/app/api/grc/continuity-exercises/[id]/files/[fileId]/route.ts";
const DOWNLOAD = "src/app/api/grc/continuity-exercises/[id]/files/[fileId]/download/route.ts";

// A probe set where: route.ts was freshly written this sub-task (mtime fresh),
// download/route.ts was NOT (stale mtime, but committed in the branch earlier).
function makeProbes({ downloadFreshlyWritten = false } = {}) {
  return {
    remoteBranchExists: async () => ({ exists: false, detail: "" }),
    prUrlPresent: async () => ({ present: false, detail: "" }),
    fileWrittenSince: async () => ({ written: false, detail: "" }),
    commitMadeSince: async () => ({ made: true, detail: "HEAD moved" }),
    // strict fresh-write probe: route.ts fresh; download stale unless flagged fresh
    fileExistsOnDisk: async (path) => {
      if (path === ROUTE) return { exists: true, nonEmpty: true, detail: "fresh (2011 bytes)" };
      if (path === DOWNLOAD) {
        return downloadFreshlyWritten
          ? { exists: true, nonEmpty: true, detail: "fresh" }
          : { exists: true, nonEmpty: false, detail: "file present (1767 bytes) but its mtime predates the sub-task start -- pre-existing" };
      }
      return { exists: false, nonEmpty: false, detail: "absent" };
    },
    // branch-range probe: BOTH files were committed earlier in the branch.
    fileCommittedInBranch: async (path) => {
      if (path === ROUTE || path === DOWNLOAD) return { present: true, detail: "committed in branch (prior cycle) + present on disk" };
      return { present: false, detail: "not in branch" };
    },
  };
}

// ---------------------------------------------------------------------------
// ORACLE 696226e4 — not-targeted already-correct file must PASS
// ---------------------------------------------------------------------------

test("beta.85 [696226e4]: reviseRelaxed download/route.ts (not targeted) PASSES on present+committed-in-branch", skip, async () => {
  const contract = [
    { kind: "file_written", path: ROUTE },                     // targeted: worker DID write it fresh
    { kind: "file_written", path: DOWNLOAD, reviseRelaxed: true }, // NOT targeted: stale mtime, but committed earlier
    { kind: "commit_made" },
  ];
  const outcome = await verifySubTaskOutput(
    contract,
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "sub", branchBaseSha: "fork" },
    makeProbes({ downloadFreshlyWritten: false }),
  );
  assert.equal(outcome.ok, true, `must PASS: ${outcome.summary}`);
  const dl = outcome.results.find((r) => r.path === DOWNLOAD);
  assert.ok(dl?.passed, "the not-targeted, already-committed file must pass via revise-relaxed");
  assert.match(dl.detail, /revise-relaxed/);
});

// ---------------------------------------------------------------------------
// ORACLE 1c744d70 — TARGETED file the worker skipped must still FAIL
// ---------------------------------------------------------------------------

test("beta.85 [1c744d70]: a TARGETED file (NOT reviseRelaxed) the worker left stale still FAILS", skip, async () => {
  // The review targeted download/route.ts (audit-log fix belonged there), so it
  // is NOT relaxed -> strict fresh-write required -> stale mtime FAILS.
  const contract = [
    { kind: "file_written", path: ROUTE },                     // worker wrote this fresh
    { kind: "file_written", path: DOWNLOAD },                  // TARGETED (no reviseRelaxed) -> strict
    { kind: "commit_made" },
  ];
  const outcome = await verifySubTaskOutput(
    contract,
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "sub", branchBaseSha: "fork" },
    makeProbes({ downloadFreshlyWritten: false }),
  );
  assert.equal(outcome.ok, false, "a targeted file the worker skipped must FAIL");
  const dl = outcome.results.find((r) => r.path === DOWNLOAD && !r.detail.includes("revise-relaxed"));
  assert.ok(dl && !dl.passed, "the targeted stale file must fail strict fresh-write");
});

test("beta.85: reviseRelaxed falls back to strict probe when fileCommittedInBranch is absent (back-compat)", skip, async () => {
  const probes = makeProbes();
  delete probes.fileCommittedInBranch;
  const contract = [{ kind: "file_written", path: DOWNLOAD, reviseRelaxed: true }];
  const outcome = await verifySubTaskOutput(
    contract,
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "sub", branchBaseSha: "fork" },
    probes,
  );
  // no branch probe -> strict fs.stat path -> stale download fails (safe default)
  assert.equal(outcome.ok, false, "absent branch probe must NOT vacuously pass; falls back to strict");
});

test("beta.85: file_committed reviseRelaxed passes on branch-committed, echoes path", skip, async () => {
  const outcome = await verifySubTaskOutput(
    [{ kind: "file_committed", path: DOWNLOAD, reviseRelaxed: true }],
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "sub", branchBaseSha: "fork" },
    makeProbes(),
  );
  assert.equal(outcome.ok, true);
  const r = outcome.results.find((x) => x.path === DOWNLOAD);
  assert.ok(r?.passed && /revise-relaxed/.test(r.detail));
});

// ---------------------------------------------------------------------------
// Wiring source-asserts
// ---------------------------------------------------------------------------

test("beta.85: loop marks not-targeted revise files reviseRelaxed off review findings", skip, () => {
  const src = readSrc("src/orchestrator/loop.ts");
  assert.ok(src.includes("loop.revise_contract_relaxed"), "audits loop.revise_contract_relaxed");
  assert.ok(/cycle > 1 && lastReview\?\.findings\?\.length/.test(src), "gated on revise cycle + review findings");
  assert.ok(/reviseRelaxed: true/.test(src), "sets reviseRelaxed on not-targeted entries");
  assert.ok(/isTargeted/.test(src) && /pathMatches/.test(src), "computes targeted set via pathMatches on finding.file");
  assert.ok(/planBaseShaForVerify/.test(src) && /branchBaseSha: planBaseShaForVerify/.test(src), "threads branch base into verify ctx");
});

// beta.123 (prune): the "fileCommittedInBranch wiring" grep of index.ts lived here and was deleted.
// It asserted the probe's SOURCE TEXT, never its behaviour, so it broke the
// moment b123 lifted the probes into src/orchestrator/verify-probes.ts -- and
// it had stayed green throughout the period when file_committed could not read
// a git mv. The property it described is now asserted against a real repo in
// tests/beta123-verify-probes.test.mjs.

test("beta.85: scripted_verify_fallback defaults OFF (no local suite runs)", skip, () => {
  const src = readSrc("src/config.ts");
  assert.ok(/scripted_verify_fallback:\s*false/.test(src), "scripted_verify_fallback must default false");
});

test("beta.85: deps bootstrap hardened against ERESOLVE (legacy-peer-deps)", skip, () => {
  const src = readSrc("src/adapters/git-worktree.ts");
  assert.ok(/--legacy-peer-deps/.test(src), "npm bootstrap must pass --legacy-peer-deps");
});

test("beta.85: per-sub-task native progress fires at worker_end_turn", skip, () => {
  const src = readSrc("src/orchestrator/loop.ts");
  // the deliverProgress call must appear right after the worker_end_turn audit,
  // guarded by try/catch so a post can never fail the run.
  assert.ok(
    /loop\.worker_end_turn[\s\S]{0,2000}deliverProgress\?\.\(sessionId,\s*"executing"\)/.test(src),
    "deliverProgress must fire per worker_end_turn",
  );
});
