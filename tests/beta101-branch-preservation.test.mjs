// beta.101 — the b100 smoke destroyed six worker commits. This is the
// regression suite for the destruction and for the detectors added around it.
//
// WHAT HAPPENED (session 3c6c1608, ProjectThanos DR/BCP smoke):
//   Sub-task 7 committed real, correct work but failed verification against a
//   fictional contract path, so b100's Fix 2 paused the run in
//   awaiting_clarification -- correctly, and with the worktree preserved. The
//   operator answered. The resume then ran a FULL re-plan, which allocates a
//   fresh worktree, and allocation did:
//       git worktree add -B <branch> <new_wt> origin/main
//   `-B` RESETS the branch. Six commits (ce05f55f..88ce5f44) had never been
//   pushed, so the ref jumped to origin/main and every one of them became
//   unreachable. The adversary then reviewed a diff containing one unrelated
//   docs commit, computed `suspicious: false`, and blocked on the absence of
//   work that had in fact been written correctly.
//
// The tests below use REAL git against local file remotes -- the failure was a
// git-semantics failure, and a source-grep assertion could not have caught it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
const { buildLedgerIntegrityReport, describeLedgerIntegrityFailure } = await import("../dist/orchestrator/ledger-integrity.js");
const { findSuspectPlanPaths, describeSuspectPlanPaths } = await import("../dist/orchestrator/plan-path-validate.js");
const { extractStatedReason } = await import("../dist/orchestrator/worker-reason.js");

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const IDENT = { name: "Harness Test", email: "harness@test.local" };
// beta.103: hermetic against a developer's global git config (see b102's helper).
const git = (args, cwd) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const tmpRoots = [];
function scratch(prefix) {
  const d = mkdtempSync(join(tmpdir(), `oah-${prefix}-`));
  tmpRoots.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/**
 * Build a self-contained world: a bare "origin" with one commit on main, and a
 * harness bare repo pre-seeded at the path GitAdapter derives, so allocate()
 * skips the GitHub clone and operates entirely on local file remotes.
 */
function makeWorld(name) {
  const base = scratch(name);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const worktreesRoot = join(base, "wt");

  git(["init", "--bare", "-b", "main", origin]);
  mkdirSync(seed, { recursive: true });
  git(["init", "-b", "main"], seed);
  git(["config", "user.name", IDENT.name], seed);
  git(["config", "user.email", IDENT.email], seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(["add", "-A"], seed);
  git(["commit", "-m", "initial"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "-u", "origin", "main"], seed);

  const bare = join(worktreesRoot, ".repos", "o", "r.git");
  mkdirSync(dirname(bare), { recursive: true });
  git(["clone", "--bare", origin, bare]);

  const adapter = new GitAdapter({ worktreesRoot, logger: QUIET, bootstrapDeps: false });
  return { base, origin, seed, worktreesRoot, bare, adapter };
}

/**
 * Allocate against the local origin.
 *
 * allocate() ends with `git -C <worktree> remote set-url origin <https url>`,
 * and a worktree SHARES config with its bare repo -- so the first allocation
 * repoints the bare at github.com/o/r. Real behaviour, irrelevant in
 * production, fatal for a local-remote test. Re-pin before each call.
 */
function alloc(w, sessionId, extra = {}) {
  git(["remote", "set-url", "origin", w.origin], w.bare);
  return w.adapter.allocate({
    repoFullName: "o/r",
    baseBranch: "main",
    sessionBranch: "harness/feat-x",
    sessionId,
    ghToken: "",
    commitIdentity: IDENT,
    ...extra,
  });
}

/** Land a commit in the worktree the way the harness does. */
async function workerCommit(adapter, wt, file, body) {
  mkdirSync(dirname(join(wt, file)), { recursive: true });
  writeFileSync(join(wt, file), body);
  return adapter.commit(wt, `harness: ${file}`, IDENT);
}

/** Move origin/main forward, as an unrelated merge did mid-run in b100. */
function advanceMain(seed) {
  writeFileSync(join(seed, "unrelated-doc.md"), "a docs commit that landed on main mid-run\n");
  git(["add", "-A"], seed);
  git(["commit", "-m", "docs: unrelated checkpoint"], seed);
  git(["push", "origin", "main"], seed);
  return git(["rev-parse", "HEAD"], seed);
}

// --- 1. the fix: a resume must not lose commits ------------------------------

test("beta101: reallocating with preserveLocalBranch keeps the branch at its own tip", async () => {
  const w = makeWorld("preserve");
  const wt1 = await alloc(w, "pending-1");
  const sha = await workerCommit(w.adapter, wt1, "src/feature.ts", "export const x = 1;\n");
  assert.ok(sha, "worker commit produced a sha");
  advanceMain(w.seed);

  // The clarification resume: a NEW worktree for the SAME branch.
  const wt2 = await alloc(w, "pending-2", { preserveLocalBranch: true });

  assert.equal(git(["rev-parse", "HEAD"], wt2), sha, "new worktree HEAD is the worker commit");
  assert.equal(
    git(["rev-parse", "refs/heads/harness/feat-x"], w.bare), sha,
    "branch ref still points at the worker commit",
  );
  assert.ok(existsSync(join(wt2, "src/feature.ts")), "the committed file is present in the working tree");
});

test("beta101: preserveLocalBranch preserves a MULTI-commit chain (the b100 shape: six)", async () => {
  const w = makeWorld("chain");
  const wt1 = await alloc(w, "pending-1");
  const shas = [];
  for (let i = 1; i <= 6; i++) shas.push(await workerCommit(w.adapter, wt1, `src/step${i}.ts`, `export const s${i} = ${i};\n`));
  advanceMain(w.seed);

  const wt2 = await alloc(w, "pending-2", { preserveLocalBranch: true });
  assert.equal(git(["rev-parse", "HEAD"], wt2), shas[5], "HEAD is the last of the six");
  for (const sha of shas) {
    // Throws on a non-zero exit, i.e. if any commit is unreachable.
    git(["merge-base", "--is-ancestor", sha, "HEAD"], wt2);
  }
  for (let i = 1; i <= 6; i++) assert.ok(existsSync(join(wt2, `src/step${i}.ts`)), `step${i}.ts survived`);
});

test("beta101: preserveLocalBranch falls back to base when the branch does not exist yet", async () => {
  // A first run must be unaffected -- this is why the flag is safe to set on
  // every resume without knowing whether the branch has commits.
  const w = makeWorld("firstrun");
  const wt = await alloc(w, "pending-1", { preserveLocalBranch: true });
  assert.ok(existsSync(join(wt, "README.md")), "checked out from base");
  assert.equal(git(["rev-parse", "HEAD"], wt), git(["rev-parse", "refs/remotes/origin/main"], w.bare));
});

// --- 2. the net: no path may silently discard commits ------------------------

test("beta101: a destructive reset parks the doomed commits under a rescue ref", async () => {
  const w = makeWorld("rescue");
  const wt1 = await alloc(w, "pending-1");
  const sha = await workerCommit(w.adapter, wt1, "src/feature.ts", "export const x = 1;\n");
  const newMain = advanceMain(w.seed);

  // Reallocate WITHOUT the flag: this is verbatim the pre-b101 behaviour that
  // orphaned b100's commits. It still resets -- we do not block it -- but the
  // work must no longer be lost.
  const wt2 = await alloc(w, "pending-2");
  assert.equal(git(["rev-parse", "HEAD"], wt2), newMain, "reset to origin/main (unchanged behaviour)");

  const rescue = git(["for-each-ref", "--format=%(refname)", "refs/harness-rescue/"], w.bare)
    .split("\n").map((s) => s.trim()).filter(Boolean);
  assert.equal(rescue.length, 1, `exactly one rescue ref, got: ${JSON.stringify(rescue)}`);
  assert.equal(git(["rev-parse", rescue[0]], w.bare), sha, "rescue ref holds the doomed tip");
  // Reachable from a ref => safe from gc => recoverable with `git branch`.
  git(["merge-base", "--is-ancestor", sha, rescue[0]], w.bare);
});

test("beta101: no rescue ref is created when the reset discards nothing", async () => {
  const w = makeWorld("norescue");
  await alloc(w, "pending-1");
  // No worker commit: the branch is exactly origin/main, so a reset is a no-op.
  await alloc(w, "pending-2");
  const rescue = git(["for-each-ref", "--format=%(refname)", "refs/harness-rescue/"], w.bare);
  assert.equal(rescue, "", "no rescue refs for a lossless reset");
});

// --- 3. the detector: unreachable ledger commits -----------------------------

test("beta101: unreachableCommits identifies orphaned commits and clears reachable ones", async () => {
  const w = makeWorld("reach");
  const wt1 = await alloc(w, "pending-1");
  const kept = await workerCommit(w.adapter, wt1, "src/a.ts", "export const a = 1;\n");
  const alsoKept = await workerCommit(w.adapter, wt1, "src/b.ts", "export const b = 2;\n");
  assert.deepEqual(await w.adapter.unreachableCommits(wt1, "HEAD", [kept, alsoKept]), [],
    "commits on the branch are reachable");

  advanceMain(w.seed);
  const wt2 = await alloc(w, "pending-2"); // orphans them
  assert.deepEqual(
    (await w.adapter.unreachableCommits(wt2, "HEAD", [kept, alsoKept])).sort(),
    [kept, alsoKept].sort(),
    "after the reset BOTH recorded commits are unreachable -- the b100 signature",
  );
});

test("beta101: a nonexistent sha counts as unreachable (integrity problem either way)", async () => {
  const w = makeWorld("bogus");
  const wt = await alloc(w, "pending-1");
  const bogus = "0".repeat(40);
  assert.deepEqual(await w.adapter.unreachableCommits(wt, "HEAD", [bogus]), [bogus]);
});

// --- 4. ledger integrity report (pure) ---------------------------------------

const LEDGER = [
  { seq: 2, commitSha: "ce05f55f1111111111111111111111111111aaaa", title: "Prisma models" },
  { seq: 3, commitSha: "c52214cd2222222222222222222222222222bbbb", title: "Zod schemas" },
];

test("beta101: report is ok when nothing is unreachable", () => {
  const r = buildLedgerIntegrityReport(LEDGER, []);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 2);
  assert.equal(r.unreachable.length, 0);
});

test("beta101: report flags unreachable entries and keeps their seq + title", () => {
  const r = buildLedgerIntegrityReport(LEDGER, [LEDGER[1].commitSha]);
  assert.equal(r.ok, false);
  assert.equal(r.unreachable.length, 1);
  assert.equal(r.unreachable[0].seq, 3);
  assert.equal(r.unreachable[0].title, "Zod schemas");
});

test("beta101: sha matching is abbreviation-tolerant in both directions", () => {
  // git and audit payloads abbreviate; the ledger stores full shas.
  assert.equal(buildLedgerIntegrityReport(LEDGER, ["ce05f55"]).unreachable.length, 1);
  assert.equal(
    buildLedgerIntegrityReport([{ seq: 2, commitSha: "ce05f55" }], [LEDGER[0].commitSha]).unreachable.length, 1,
  );
});

test("beta101: entries without a sha are not counted as checkable", () => {
  const r = buildLedgerIntegrityReport([...LEDGER, { seq: 4, commitSha: "" }, { seq: 5, commitSha: "   " }], []);
  assert.equal(r.checked, 2);
  assert.equal(r.ok, true);
});

test("beta101: the failure message names the lost sub-tasks and how to recover", () => {
  const msg = describeLedgerIntegrityFailure(buildLedgerIntegrityReport(LEDGER, [LEDGER[0].commitSha]), "f208b00e");
  assert.match(msg, /seq 2/);
  assert.match(msg, /ce05f55/);
  assert.match(msg, /f208b00/, "names the HEAD that cannot reach it");
  assert.match(msg, /harness-rescue/, "points at the recovery path");
});

// --- 5. plan-time fictional-path detection -----------------------------------

// The real b100 tree shape: components/ui exists, components/layout does not.
const REPO_FILES = [
  "src/components/ui/sidebar.tsx",
  "src/components/grc/poi-inventory-table.tsx",
  "src/app/(portal)/grc/page.tsx",
  "package.json",
];

test("beta101: the b100 fictional path is flagged, naming the absent directory", () => {
  const s = findSuspectPlanPaths(["src/components/layout/grc-nav.tsx"], REPO_FILES);
  assert.equal(s.length, 1);
  assert.equal(s[0].path, "src/components/layout/grc-nav.tsx");
  assert.equal(s[0].missingDir, "src/components/layout");
});

test("beta101: a NEW file in an EXISTING directory is never flagged", () => {
  // The overwhelmingly common legitimate case: sub-tasks create files.
  assert.deepEqual(findSuspectPlanPaths(["src/components/ui/new-thing.tsx"], REPO_FILES), []);
});

test("beta101: an existing file is never flagged", () => {
  assert.deepEqual(findSuspectPlanPaths(["src/components/ui/sidebar.tsx"], REPO_FILES), []);
});

test("beta101: ancestor directories count as existing via their descendants", () => {
  // Only a deep file is listed, but every directory on its chain is real.
  assert.deepEqual(findSuspectPlanPaths(["src/app/(portal)/grc/new-page.tsx"], REPO_FILES), []);
});

test("beta101: repo-root paths and globs are never flagged", () => {
  assert.deepEqual(findSuspectPlanPaths(["CHANGELOG.md", "src/**/*.test.ts"], REPO_FILES), []);
});

test("beta101: an empty repo listing yields no opinion (fails open)", () => {
  assert.deepEqual(findSuspectPlanPaths(["src/components/layout/grc-nav.tsx"], []), []);
});

test("beta101: duplicate plan paths are reported once", () => {
  const p = "src/components/layout/grc-nav.tsx";
  assert.equal(findSuspectPlanPaths([p, p, `./${p}`], REPO_FILES).length, 1);
});

test("beta101: the worker note redirects rather than forbids", () => {
  const note = describeSuspectPlanPaths(findSuspectPlanPaths(["src/components/layout/grc-nav.tsx"], REPO_FILES));
  assert.match(note, /GUESSES/);
  assert.match(note, /src\/components\/layout/);
  assert.match(note, /search the repo/i);
});

// --- 6. the clarification question quotes the RIGHT sentence -----------------

// Verbatim shape of the b100 worker message: the misleading remark comes first.
const B100_MESSAGE = [
  "That's fine, it's a harmless temp file outside the repo. Sub-task complete.",
  "",
  "I added the continuity pages. Note that src/components/layout/grc-nav.tsx does not exist in this repo,",
  "so I added the nav entry to src/components/ui/sidebar.tsx instead, matching the existing GRC entries.",
].join("\n");

const EXPECTED = ["src/components/layout/grc-nav.tsx"];
const ACTUAL = ["src/app/(portal)/grc/continuity-exercises/page.tsx", "src/components/ui/sidebar.tsx"];

test("beta101: the b100 misleading first line is NOT selected as the reason", () => {
  const reason = extractStatedReason(B100_MESSAGE, EXPECTED, ACTUAL);
  assert.doesNotMatch(reason, /harmless temp file/, "the b100 regression: a remark about an unrelated file");
});

test("beta101: the selected reason explains the actual deviation", () => {
  const reason = extractStatedReason(B100_MESSAGE, EXPECTED, ACTUAL);
  assert.match(reason, /grc-nav\.tsx does not exist/);
});

test("beta101: content-free sign-offs are never selected", () => {
  assert.equal(extractStatedReason("Sub-task complete.", EXPECTED, ACTUAL), "");
  assert.equal(extractStatedReason("Done.\nComplete", EXPECTED, ACTUAL), "");
});

test("beta101: a message with no relevant sentence falls back to the first line", () => {
  assert.equal(extractStatedReason("Refactored the helper.\nSecond line.", EXPECTED, ACTUAL), "Refactored the helper.");
});

test("beta101: an empty message yields an empty reason (clause is then omitted)", () => {
  assert.equal(extractStatedReason("", EXPECTED, ACTUAL), "");
  assert.equal(extractStatedReason("   \n  ", EXPECTED, ACTUAL), "");
});

test("beta101: the reason is length-bounded", () => {
  const long = `The path ${EXPECTED[0]} does not exist, ${"and here is a great deal more prose. ".repeat(40)}`;
  const reason = extractStatedReason(long, EXPECTED, ACTUAL, 120);
  assert.ok(reason.length <= 123, `bounded, got ${reason.length}`);
  assert.match(reason, /\.\.\.$/);
});

test("beta101: a path mention outranks a bare deviation cue", () => {
  const msg = "I did it differently instead.\nThe file src/components/layout/grc-nav.tsx was missing.";
  assert.match(extractStatedReason(msg, EXPECTED, ACTUAL), /grc-nav\.tsx was missing/);
});

// --- 7. wiring ---------------------------------------------------------------

const loopSrc = S("src/orchestrator/loop.ts");
const gitSrc = S("src/adapters/git-worktree.ts");
const indexSrc = S("src/index.ts");
const regSrc = S("src/tools/registration.ts");

test("beta101: harness_answer marks the resume so allocation preserves the branch", () => {
  assert.match(regSrc, /brief\.resumeFromClarification = true/);
  const i = regSrc.indexOf("brief.resumeFromClarification = true");
  const j = regSrc.indexOf("UPDATE sessions SET crystallised_prompt = ?, status = 'planning'");
  assert.ok(i > 0 && j > i, "the flag is set BEFORE the brief is persisted, so recovery re-drives keep it");
});

test("beta101: index threads resumeFromClarification into preserveLocalBranch", () => {
  assert.match(indexSrc, /preserveLocalBranch: !!brief\.resumeFromClarification/);
});

test("beta101: the preserve path checks out the branch with no start-point", () => {
  // `worktree add <wt> <branch>` cannot move a ref; `-B <branch> ... <start>` can.
  assert.match(gitSrc, /"worktree", "add", wt, ctx\.sessionBranch/);
  const i = gitSrc.indexOf('"worktree", "add", wt, ctx.sessionBranch');
  const seg = gitSrc.slice(Math.max(0, i - 2500), i);
  assert.match(seg, /preserveLocalBranch/, "gated on the flag");
  assert.match(seg, /localBranchExists/, "and on the branch actually existing");
});

test("beta101: EVERY destructive -B reset is preceded by a rescue attempt", () => {
  const resets = [...gitSrc.matchAll(/"worktree", "add", "-B"/g)];
  assert.ok(resets.length >= 3, `expected the known -B call sites, found ${resets.length}`);
  for (const m of resets) {
    const before = gitSrc.slice(Math.max(0, m.index - 400), m.index);
    assert.match(before, /rescueBranchIfAhead/, `an unguarded -B reset at index ${m.index}`);
  }
});

test("beta101: the ledger guard runs BEFORE the adversary SDK call is paid for", () => {
  // b105 extracted the guard into a shared method (defined below the loop
  // body), so assert on the review CALL SITE, which is what orders it.
  const guard = loopSrc.indexOf('checkLedgerReachability(sessionId, plan.worktreePath, cycle, "review")');
  const call = loopSrc.indexOf("this.deps.runAdversary(");
  assert.ok(guard > 0 && call > guard, "guard must precede the review call");
});

test("beta101: unreachable ledger commits fail the run rather than reviewing or shipping", () => {
  assert.match(loopSrc, /loop\.ledger_commits_unreachable/);
  assert.match(loopSrc, /finaliseFailed\(sessionId, `ledger_commits_unreachable: \$\{check\.detail\}`/);
});

test("beta101: the ledger guard fails OPEN on a probe error", () => {
  const i = loopSrc.indexOf("loop.ledger_reachability_checked");
  const seg = loopSrc.slice(Math.max(0, i - 3000), i + 3000);
  assert.match(seg, /ledger reachability guard failed \(non-fatal/);
});

test("beta101: missing ledger commits now make the adversary diff suspicious", () => {
  assert.match(loopSrc, /const missingLedgerCommits = ledgerUnreachable\.length > 0/);
  assert.match(loopSrc, /const suspicious = tooManyCommits \|\| missingLedgerCommits/);
});

test("beta101: the clarification question uses relevance-based reason extraction", () => {
  assert.match(loopSrc, /extractStatedReason\(result\.finalMessage \?\? "", expected, actual\)/);
  assert.doesNotMatch(loopSrc, /const firstLine = workerNote/, "the b100 first-line heuristic is gone");
});

test("beta101: each worker is warned only about ITS OWN suspect paths", () => {
  assert.match(loopSrc, /planPathSuspects\.filter\(\(s\) => mine\.has\(s\.path\)\)/);
});

// --- 8. config ---------------------------------------------------------------

const MINIMAL_CONFIG = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["example-org/*"], default_base_branch: "main" },
};

test("beta101: both new keys default to true", async () => {
  const { parseHarnessConfig } = await import("../dist/config.js");
  const cfg = parseHarnessConfig(MINIMAL_CONFIG);
  assert.equal(cfg.loop.ledger_reachability_guard_enabled, true);
  assert.equal(cfg.loop.plan_path_validation_enabled, true);
});

test("beta101: both new keys are operator-overridable to false", async () => {
  const { parseHarnessConfig } = await import("../dist/config.js");
  const cfg = parseHarnessConfig({
    ...MINIMAL_CONFIG,
    loop: { ledger_reachability_guard_enabled: false, plan_path_validation_enabled: false },
  });
  assert.equal(cfg.loop.ledger_reachability_guard_enabled, false);
  assert.equal(cfg.loop.plan_path_validation_enabled, false);
});

test("beta101: both new keys are declared in the plugin manifest schema", () => {
  const manifest = JSON.parse(S("openclaw.plugin.json"));
  const loop = manifest.configSchema.properties.loop.properties;
  assert.equal(loop.ledger_reachability_guard_enabled.default, true);
  assert.equal(loop.plan_path_validation_enabled.default, true);
});

test("beta101: pluginVersion and package.json agree at >= beta.101", async () => {
  const { PLUGIN_VERSION } = await import("../dist/version.js");
  const pkg = JSON.parse(S("package.json"));
  assert.equal(PLUGIN_VERSION.pluginVersion, pkg.version);
  const n = Number(/beta\.(\d+)$/.exec(pkg.version)?.[1] ?? 0);
  assert.ok(n >= 101, `expected >= beta.101, got ${pkg.version}`);
});
