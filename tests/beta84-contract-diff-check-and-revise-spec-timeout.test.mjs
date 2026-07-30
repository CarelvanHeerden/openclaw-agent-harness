/**
 * beta.84 — two real harness fixes surfaced by session 1c744d70 (DR/BCP smoke),
 * confirmed against Staging's authoritative DB read.
 *
 * #1 CONTRACT-DIFF GROUND TRUTH (the "confab" fix).
 *    cyc2 seq7 declared BOTH `.../download/route.ts` AND `.../route.ts` as
 *    contract files. The worker wrote `download/route.ts` for real (2010 bytes)
 *    but never touched the base `route.ts`. The `file_committed` check for
 *    `route.ts` resolved via the fuzzy BASENAME-UNIQUE fallback to the SIBLING
 *    `download/route.ts` (the lone same-basename file) and reported PASS -- a
 *    false-positive; only the `file_written` mtime probe caught the miss.
 *    FIX: `fileCommittedSince` now (a) resolves strictly (structural matches
 *    only, no basename/test-file fuzzing) and (b) requires the EXACT matched
 *    path to have a non-zero `git diff --numstat` in base..HEAD. A commit that
 *    touches a sibling but not the contract file no longer passes. Plus the
 *    result rows now carry their contract `path` (Staging QoL nit).
 *
 * #2 REVISE-SPEC TIMEOUT.
 *    The Fable revise-spec turn is an unbounded lead call that has spun ~570s
 *    then failed on the ambient cron lane cap (beta.73 signature) -- ~10 min
 *    burned before falling back to raw findings. FIX: bound it with
 *    `revise_spec_timeout_seconds` (default 180) via withTimeout; on timeout it
 *    audits `loop.revise_spec_timeout` and falls back FAST (never worse than
 *    beta.66). runInner is private -> source-assertion wiring, matching the
 *    repo's beta.62/70/83 pattern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const readSrc = (rel) => readFileSync(join(ROOT, rel), "utf8");

let resolveContractPath, isStructuralRule, GitAdapter, verifySubTaskOutput;
try {
  ({ resolveContractPath, isStructuralRule } = await import("../dist/orchestrator/path-match.js"));
  ({ GitAdapter } = await import("../dist/adapters/git-worktree.js"));
  ({ verifySubTaskOutput } = await import("../dist/orchestrator/verify.js"));
} catch {
  resolveContractPath = null;
}
const skip = { skip: resolveContractPath === null };

// The exact cyc2-seq7 paths (trimmed for readability but same structure).
const CONTRACT_ROUTE = "src/app/api/grc/continuity-exercises/[id]/files/[fileId]/route.ts";
const SIBLING_DOWNLOAD = "src/app/api/grc/continuity-exercises/[id]/files/[fileId]/download/route.ts";

// ---------------------------------------------------------------------------
// #1a — strictContract kills the fuzzy fallbacks (the false-positive source)
// ---------------------------------------------------------------------------

test("beta.84 #1: isStructuralRule accepts only the 4 non-fuzzy rules", skip, () => {
  for (const r of ["exact", "route-group", "suffix", "basename-dir"]) {
    assert.equal(isStructuralRule(r), true, `${r} should be structural`);
  }
  for (const r of ["basename-unique", "test-file-unique", null, "nope"]) {
    assert.equal(isStructuralRule(r), false, `${r} must NOT be structural`);
  }
});

test("beta.84 #1: strictContract REJECTS the sibling that basename-unique would false-match", skip, () => {
  const committed = [SIBLING_DOWNLOAD]; // worker wrote ONLY the sibling
  // Legacy fuzzy behaviour: basename-unique matches the sibling (the bug).
  const fuzzy = resolveContractPath(committed, CONTRACT_ROUTE, { allowBasenameFallback: true });
  assert.equal(fuzzy?.rule, "basename-unique", "precondition: fuzzy path WOULD false-match the sibling");
  assert.equal(fuzzy?.file, SIBLING_DOWNLOAD);
  // beta.84: strict mode refuses it.
  const strict = resolveContractPath(committed, CONTRACT_ROUTE, { strictContract: true });
  assert.equal(strict, null, "strictContract must NOT match the sibling via basename-unique");
});

test("beta.84 #1: strictContract STILL accepts a genuine structural match", skip, () => {
  // route-group drift on the SAME file is a real structural match -> still accepted.
  const withGroup = "src/app/(portal)/api/grc/continuity-exercises/[id]/files/[fileId]/route.ts";
  const m = resolveContractPath([withGroup], CONTRACT_ROUTE, { strictContract: true });
  assert.ok(m, "structural (route-group) match must still resolve under strictContract");
  assert.ok(isStructuralRule(m.rule), `matched rule ${m.rule} should be structural`);
});

test("beta.84 #1: strictContract does not disturb the exact-match fast path", skip, () => {
  const m = resolveContractPath([CONTRACT_ROUTE, SIBLING_DOWNLOAD], CONTRACT_ROUTE, { strictContract: true });
  assert.equal(m?.rule, "exact");
  assert.equal(m?.file, CONTRACT_ROUTE);
});

// ---------------------------------------------------------------------------
// #1b — GitAdapter.fileDiffLineCount (ground-truth numstat, real git)
// ---------------------------------------------------------------------------

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "beta84-git-"));
  const wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  const g = (args) => spawnSync("git", ["-C", wt, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", wt], { encoding: "utf8" });
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  // Base commit: both files exist (mirrors cyc1 shipping route.ts + download/route.ts).
  await mkdir(join(wt, "sub", "download"), { recursive: true });
  await writeFile(join(wt, "sub", "route.ts"), "export const del = 1;\n");
  await writeFile(join(wt, "sub", "download", "route.ts"), "export const dl = 1;\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base (cycle 1)"]);
  const base = spawnSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  return { root, wt, base, g };
}

test("beta.84 #1: fileDiffLineCount returns 0 for a file the commit did NOT touch (the seq7 case)", skip, async () => {
  const { root, wt, base, g } = await makeRepo();
  try {
    // Cycle-2 seq7 reproduction: worker edits ONLY the sibling download/route.ts.
    await writeFile(join(wt, "sub", "download", "route.ts"), "export const dl = 2;\nexport const audit = true;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "fix(grc): audit-log continuity artefact file deletion"]);
    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });

    const siblingLines = await git.fileDiffLineCount(wt, base, "sub/download/route.ts");
    assert.ok(siblingLines > 0, `sibling SHOULD have diff lines, got ${siblingLines}`);

    const contractLines = await git.fileDiffLineCount(wt, base, "sub/route.ts");
    assert.equal(contractLines, 0, "the untouched contract file MUST report 0 diff lines");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("beta.84 #1: fileDiffLineCount counts real add+delete lines", skip, async () => {
  const { root, wt, base, g } = await makeRepo();
  try {
    await writeFile(join(wt, "sub", "route.ts"), "export const del = 2;\nexport const extra = 3;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "edit route"]);
    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });
    const n = await git.fileDiffLineCount(wt, base, "sub/route.ts");
    assert.ok(n >= 2, `expected >=2 changed lines (1 del + >=1 add), got ${n}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #1c — verifySubTaskOutput: file_committed carries `path` + fails on 0-diff
// ---------------------------------------------------------------------------

test("beta.84 #1: file_committed FAILS when probe reports diffLines=0, and echoes the contract path", skip, async () => {
  // The production probe returns {committed:false, diffLines:0} for a 0-diff
  // contract file; the pure verifier must surface that as a failed result that
  // carries the exact contract path.
  const probes = {
    remoteBranchExists: async () => ({ exists: false, detail: "" }),
    prUrlPresent: async () => ({ present: false, detail: "" }),
    fileWrittenSince: async () => ({ written: false, detail: "" }),
    commitMadeSince: async () => ({ made: true, detail: "HEAD moved" }),
    fileCommittedSince: async (p) =>
      p === CONTRACT_ROUTE
        ? { committed: false, diffLines: 0, detail: "matched sibling but diff EMPTY (0 lines)" }
        : { committed: true, diffLines: 12, detail: "ok" },
  };
  const outcome = await verifySubTaskOutput(
    [
      { kind: "file_committed", path: SIBLING_DOWNLOAD },
      { kind: "file_committed", path: CONTRACT_ROUTE },
    ],
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: "base" },
    probes,
  );
  assert.equal(outcome.ok, false, "a 0-diff contract file must fail verification");
  const routeResult = outcome.results.find((r) => r.path === CONTRACT_ROUTE);
  assert.ok(routeResult, "the failing result must carry the contract path (QoL nit)");
  assert.equal(routeResult.passed, false);
  const siblingResult = outcome.results.find((r) => r.path === SIBLING_DOWNLOAD);
  assert.ok(siblingResult?.passed, "the sibling (real diff) still passes");
});

// ---------------------------------------------------------------------------
// #1d — index.ts probe wiring source-asserts
// ---------------------------------------------------------------------------

test("beta.84 #1: fileCommittedSince wiring uses strictContract + numstat gate", skip, () => {
  const src = readSrc("src/index.ts");
  // strict-contract resolution (no fuzzy fallback) for the contract check.
  assert.ok(
    /fileCommittedSince[\s\S]{0,900}resolveContractPath\([^)]*\{\s*strictContract:\s*true\s*\}/.test(src),
    "fileCommittedSince must resolve with strictContract:true (no basename-unique/test-file fallback)",
  );
  // non-zero diff gate via the new git helper.
  assert.ok(
    /fileCommittedSince[\s\S]{0,1400}fileDiffLineCount\(worktreePath,\s*base,\s*matchedFile\)/.test(src),
    "fileCommittedSince must gate on git.fileDiffLineCount for the matched path",
  );
  assert.ok(
    /fileCommittedSince[\s\S]{0,1600}diffLines\s*>\s*0/.test(src),
    "committed must require diffLines > 0",
  );
});

test("beta.84 #1: verify.ts echoes the contract path on file_committed + file_written results", skip, () => {
  const src = readSrc("src/orchestrator/verify.ts");
  assert.ok(/VerifyProbeResult[\s\S]{0,900}path\?:\s*string/.test(src), "VerifyProbeResult must gain optional path");
  assert.ok(
    /case "file_committed"[\s\S]{0,600}path:\s*v\.path/.test(src),
    "file_committed result must carry v.path",
  );
  assert.ok(
    /fileCommittedSince\?:[\s\S]{0,200}diffLines\?:\s*number/.test(src),
    "fileCommittedSince probe type must expose optional diffLines",
  );
});

// ---------------------------------------------------------------------------
// #2 — revise-spec timeout: config default, manifest, loop wiring, progress
// ---------------------------------------------------------------------------

test("beta.84 #2: revise_spec_timeout_seconds default is 180 in config.ts", skip, () => {
  const src = readSrc("src/config.ts");
  assert.ok(/revise_spec_timeout_seconds\?:\s*number/.test(src), "type must declare revise_spec_timeout_seconds");
  assert.ok(/revise_spec_timeout_seconds:\s*180/.test(src), "default must be 180");
});

test("beta.84 #2: manifest declares revise_spec_timeout_seconds (additionalProperties:false lesson)", skip, () => {
  const m = JSON.parse(readSrc("openclaw.plugin.json"));
  const loop = m.configSchema.properties.loop;
  assert.equal(loop.additionalProperties, false, "loop still closed to extra props");
  assert.ok(loop.properties.revise_spec_timeout_seconds, "manifest must declare revise_spec_timeout_seconds");
  assert.equal(loop.properties.revise_spec_timeout_seconds.type, "integer");
  assert.equal(loop.properties.revise_spec_timeout_seconds.default, 180);
});

test("beta.92 SUPERSEDES beta.84 #2: the timed revise-spec turn was DELETED (no withTimeout(reviseSpecCall), no revise_spec_timeout audit)", skip, () => {
  const src = readSrc("src/orchestrator/loop.ts");
  // beta.92 deleted the LLM revise-spec turn entirely -> none of the b84 timing
  // wiring exists in the loop anymore (the whole failure mode is gone).
  assert.ok(!/withTimeout\(reviseSpecCall/.test(src), "beta.92 removed the timed revise-spec call");
  assert.ok(!/loop\.revise_spec_timeout/.test(src), "beta.92 removed the revise_spec_timeout audit");
  assert.ok(!/loop\.revise_spec_failed/.test(src), "beta.92 removed the revise_spec_failed audit");
  // Replaced by the deterministic mapping (no timeout surface).
  assert.ok(src.includes("mapFindingsToSubTasks"), "beta.92 uses the deterministic mapping");
});

test("beta.84 #2: progress fallback detection includes the timeout event", skip, () => {
  const src = readSrc("src/orchestrator/progress.ts");
  assert.ok(
    src.includes("loop.revise_spec_timeout"),
    "reviseSpecFellBack detection must treat a timeout as a raw-findings fallback",
  );
  // still reads the pre-existing fallback events (no regression to beta.83 #1)
  assert.ok(src.includes("loop.revise_spec_failed") && src.includes("loop.revise_spec_empty"));
});
