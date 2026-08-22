/**
 * beta.95 — revise-cycle verifier DIFF-WINDOW fix.
 *
 * Root cause (session 98cea58f, cyc2 seq2, prisma/schema.prisma): on a revise
 * cycle a TARGETED contract file (the review DID target it, so reviseRelaxed is
 * NOT set) is verified against the worker-session-start SHA + an mtime-predates-
 * sub-task-start freshness heuristic. Both read the WRONG window:
 *   - `file_written` mtime: cycle-1 already touched the file, so its mtime is
 *     OLDER than cycle-2's sub-task start -> false "pre-existing" fail.
 *   - `file_committed` strict-match: base = worker-session-start, so cycle-1's
 *     commit of the file sits OUTSIDE the range; the diff seen was only the two
 *     `.commit-msg-tmp.txt` / `.git-commit-msg.txt` scratch files -> false fail.
 * The worker's cycle-2 edit was genuine (real commit e75c669 over base 202720e;
 * commit_made passed). This is a deterministic verifier bug, NOT a confab.
 *
 * Fix: on cycle > 1 (kill-switch loop.revise_targeted_planbase_window), verify a
 * TARGETED file against the BRANCH fork-point window (plan_base_sha / branchBaseSha)
 * via the committed-in-branch predicate. Cycle 1 keeps the strict fresh-write path.
 * Plus: strip `.commit-msg` scratch files from listCommitted/ChangedFiles so they
 * can neither spoof nor mask the real contract path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const readSrc = (rel) => readFileSync(join(ROOT, rel), "utf8");

let verify;
try {
  verify = await import("../dist/orchestrator/verify.js");
} catch {
  verify = null;
}
let gitmod;
try {
  gitmod = await import("../dist/adapters/git-worktree.js");
} catch {
  gitmod = null;
}
const vskip = { skip: verify === null };

const SCHEMA = "prisma/schema.prisma";
const NOISE_A = ".commit-msg-tmp.txt";
const NOISE_B = ".git-commit-msg.txt";

test("beta.95: version >= beta.95", () => {
  const betaNum = betaOrdinal;
  assert.ok(betaNum(JSON.parse(readSrc("package.json")).version) >= 95);
});

// ---------------------------------------------------------------------------
// Behaviour: the 98cea58f repro. TARGETED file, cycle 2, stale mtime + strict-
// match sees only noise -> WITHOUT the fix this false-fails; WITH the fix it
// passes via the plan-base-window committed-in-branch predicate.
// ---------------------------------------------------------------------------

// Strict cycle-1-shaped probes: mtime predates start (file_written fails),
// and fileCommittedSince against worker-session-start sees only noise (fails).
const strictWindowProbes = {
  remoteBranchExists: async () => ({ exists: false, detail: "n/a" }),
  prUrlPresent: async () => ({ present: false, detail: "n/a" }),
  fileWrittenSince: async () => ({ written: false, detail: "mtime predates sub-task start" }),
  commitMadeSince: async () => ({ made: true, detail: "HEAD e75c669 != base 202720e" }),
  fileExistsOnDisk: async (_p, sinceMs) => ({
    exists: true, nonEmpty: false,
    detail: `file present (169365 bytes) but its mtime predates the sub-task start -- pre-existing, not written by this sub-task (sinceMs=${sinceMs})`,
  }),
  // worker-session-start window: only the commit-msg scratch files are in range.
  fileCommittedSince: async (_p, base) => ({
    committed: false, diffLines: 0,
    detail: `contract path not committed via a structural (non-fuzzy) match (2 file(s) in ${String(base).slice(0, 7)}..HEAD: ${NOISE_A}, ${NOISE_B})`,
  }),
  // plan-base window: the schema IS present + committed in the branch range.
  fileCommittedInBranch: async (_p, branchBase) => ({
    present: true, detail: `present + committed in branch via exact match (${SCHEMA}) [base ${String(branchBase).slice(0, 7)}]`,
  }),
};

test("beta.95: TARGETED file_written on cycle>1 PASSES via plan-base window (98cea58f repro)", vskip, async () => {
  const out = await verify.verifySubTaskOutput(
    [{ kind: "file_written", path: SCHEMA }],
    {
      defaultBranch: "harness/feat-grc-continuity-resilience",
      subTaskStartMs: 9_999_999_999_999, // far future -> mtime always "predates"
      baseSha: "202720e", branchBaseSha: "planbaseSHA",
      cycle: 2, reviseTargetedPlanbaseWindow: true,
    },
    strictWindowProbes,
  );
  assert.equal(out.ok, true, `expected PASS on revise-cycle plan-base window, got: ${out.summary}`);
  assert.match(out.results[0].detail, /revise-targeted \(plan-base window\)/);
});

test("beta.95: TARGETED file_committed on cycle>1 PASSES via plan-base window (not the noise-only strict window)", vskip, async () => {
  // On the plan-base window fileCommittedSince now sees the real schema commit.
  const probes = {
    ...strictWindowProbes,
    fileCommittedSince: async (_p, base) =>
      String(base) === "planbaseSHA"
        ? { committed: true, diffLines: 42, detail: `file appears in ${SCHEMA} via exact match (+/-42 lines)` }
        : { committed: false, diffLines: 0, detail: `only noise in ${String(base).slice(0, 7)}..HEAD: ${NOISE_A}, ${NOISE_B}` },
  };
  const out = await verify.verifySubTaskOutput(
    [{ kind: "file_committed", path: SCHEMA }],
    { defaultBranch: "x", subTaskStartMs: 0, baseSha: "202720e", branchBaseSha: "planbaseSHA", cycle: 2, reviseTargetedPlanbaseWindow: true },
    probes,
  );
  assert.equal(out.ok, true, `expected PASS via plan-base committed window, got: ${out.summary}`);
  assert.match(out.results[0].detail, /revise-targeted \(plan-base window\)/);
});

test("beta.95: cycle 1 KEEPS the strict fresh-write window (a genuinely stale/uncommitted file still FAILS)", vskip, async () => {
  const out = await verify.verifySubTaskOutput(
    [{ kind: "file_written", path: SCHEMA }, { kind: "file_committed", path: SCHEMA }],
    { defaultBranch: "x", subTaskStartMs: 9_999_999_999_999, baseSha: "202720e", branchBaseSha: "planbaseSHA", cycle: 1, reviseTargetedPlanbaseWindow: true },
    strictWindowProbes,
  );
  assert.equal(out.ok, false, "cycle 1 must NOT get the widened window -> stale/noise-only still fails");
});

test("beta.95: kill-switch OFF restores the beta.94 strict window on cycle>1 (targeted file false-fails)", vskip, async () => {
  const out = await verify.verifySubTaskOutput(
    [{ kind: "file_written", path: SCHEMA }, { kind: "file_committed", path: SCHEMA }],
    { defaultBranch: "x", subTaskStartMs: 9_999_999_999_999, baseSha: "202720e", branchBaseSha: "planbaseSHA", cycle: 2, reviseTargetedPlanbaseWindow: false },
    strictWindowProbes,
  );
  assert.equal(out.ok, false, "with the kill-switch off, cycle>1 falls back to the beta.94 strict (false-failing) window");
});

test("beta.95: reviseRelaxed (NOT-targeted) file still uses the beta.85 relaxed path, unaffected", vskip, async () => {
  const out = await verify.verifySubTaskOutput(
    [{ kind: "file_written", path: SCHEMA, reviseRelaxed: true }],
    { defaultBranch: "x", subTaskStartMs: 9_999_999_999_999, baseSha: "202720e", branchBaseSha: "planbaseSHA", cycle: 2, reviseTargetedPlanbaseWindow: true },
    strictWindowProbes,
  );
  assert.equal(out.ok, true);
  assert.match(out.results[0].detail, /revise-relaxed \(not targeted this cycle\)/);
});

// ---------------------------------------------------------------------------
// commit-msg noise filter
// ---------------------------------------------------------------------------

test("beta.95: isCommitMsgNoise matches the scratch files, not real contract paths", { skip: gitmod === null || !gitmod.isCommitMsgNoise }, () => {
  const { isCommitMsgNoise } = gitmod;
  for (const f of [NOISE_A, NOISE_B, ".gitmessage", "COMMIT_EDITMSG", "sub/dir/.commit-msg-tmp.txt", ".git-commit-msg"]) {
    assert.equal(isCommitMsgNoise(f), true, `${f} should be flagged as commit-msg noise`);
  }
  for (const f of [SCHEMA, "src/app/api/route.ts", "docs/commit-guidelines.md", "src/message.ts"]) {
    assert.equal(isCommitMsgNoise(f), false, `${f} must NOT be flagged as noise`);
  }
});

// ---------------------------------------------------------------------------
// wiring source-asserts
// ---------------------------------------------------------------------------

test("beta.95: verify.ts routes targeted revise-cycle files to the plan-base window", () => {
  const src = readSrc("src/orchestrator/verify.ts");
  assert.ok(/const reviseCycle = \(ctx\.cycle \?\? 1\) > 1 && ctx\.reviseTargetedPlanbaseWindow !== false/.test(src),
    "reviseCycle gate must combine cycle>1 with the kill-switch");
  assert.ok(/reviseCycle && probes\.fileCommittedInBranch/.test(src), "file_written targeted revise path present");
  assert.ok(/reviseCycle && probes\.fileCommittedSince/.test(src), "file_committed targeted revise path present");
  assert.ok(/planBaseWindow = ctx\.branchBaseSha \?\? ctx\.baseSha/.test(src), "plan-base window derived from branchBaseSha");
});

test("beta.95: both loop.ts verify call sites thread cycle + kill-switch (incl. the retry path)", () => {
  const src = readSrc("src/orchestrator/loop.ts");
  const hits = src.match(/reviseTargetedPlanbaseWindow: this\.deps\.config\.loop\.revise_targeted_planbase_window !== false/g) ?? [];
  assert.ok(hits.length >= 2, `both verify call sites must pass the flag (found ${hits.length})`);
  // the retry call previously dropped branchBaseSha -- assert it is restored.
  assert.ok(/beta\.95: the retry path dropped branchBaseSha/.test(src), "retry path branchBaseSha restore comment present");
});

test("beta.95: git-worktree strips commit-msg noise from committed + changed file listings", () => {
  const src = readSrc("src/adapters/git-worktree.ts");
  const hits = src.match(/\.filter\(\(f\) => !isCommitMsgNoise\(f\)\)/g) ?? [];
  assert.ok(hits.length >= 2, `both listCommittedFiles and listChangedFiles must filter noise (found ${hits.length})`);
});

test("beta.95: config default revise_targeted_planbase_window = true", () => {
  const src = readSrc("src/config.ts");
  assert.ok(/revise_targeted_planbase_window\?: boolean;/.test(src), "config type field present");
  assert.ok(/revise_targeted_planbase_window: true,/.test(src), "default is true (fix on by default)");
});
