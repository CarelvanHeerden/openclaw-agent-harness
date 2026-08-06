/**
 * beta.110 -- an in-worktree tool cache must never reach a commit.
 *
 * ProjectThanos PR #932, session `9217236c`. Sub-task 9 needed the prisma CLI,
 * ran an install, and npm wrote its cache to `.npm-cache-tmp/_cacache/` inside
 * the worktree because $HOME was not writable. commit()'s unscoped `git add -A`
 * swept 12,292 blobs into the schema-format commit. The adversary was handed a
 * 12,432-file diff, timed out at 900s with no result, and the run died at 55.6
 * minutes having pushed nothing -- stranding eight good commits.
 *
 * The b109 post-mortem blamed the target repo's .gitignore and the worker's
 * `git add`. Both wrong: the add is ours, in GitAdapter.commit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { GitAdapter, HARNESS_EXCLUDE_PATTERNS } from "../dist/adapters/git-worktree.js";
import { OrchestratorLoop, ScopeBlowoutError } from "../dist/orchestrator/loop.js";
import { parseHarnessConfig } from "../dist/config.js";

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const D = (p) => readFileSync(new URL(`../dist/${p}`, import.meta.url), "utf8");

// gpgsign off: a developer with a global commit.gpgsign=true otherwise fails here.
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", cwd, ...args], {
    encoding: "utf8",
  });

const LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const IDENT = { name: "Harness", email: "harness@example.com" };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "b110-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

const adapter = () => new GitAdapter({ worktreesRoot: mkdtempSync(join(tmpdir(), "b110-wt-")), logger: LOGGER });

/* ------------------------------------------------------------------ *
 * The root cause
 * ------------------------------------------------------------------ */

test("beta110: an npm cache written into the worktree does NOT reach the commit", async () => {
  const dir = repo();
  // Exactly the shape of the #932 failure: real work, plus a cache tree.
  writeFileSync(join(dir, "schema.prisma"), "model A { id Int @id }\n");
  mkdirSync(join(dir, ".npm-cache-tmp", "_cacache", "content-v2", "sha512", "ab"), { recursive: true });
  for (let i = 0; i < 25; i++) {
    writeFileSync(join(dir, ".npm-cache-tmp", "_cacache", "content-v2", "sha512", "ab", `blob-${i}`), "x");
  }

  const sha = await adapter().commit(dir, "format schema", IDENT);
  assert.ok(sha, "the real work must still commit");

  const files = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean);
  assert.deepEqual(files, ["schema.prisma"], `only the project file belongs in the commit, got: ${files.join(", ")}`);
  assert.ok(
    !files.some((f) => f.includes(".npm-cache-tmp")),
    "12,292 of these are what killed session 9217236c",
  );
});

test("beta110: each cache root is excluded on its own name, not via a nested _cacache", async () => {
  // npm also writes `_locks/` and `tmp/` under its cache root, and a cache root
  // configured somewhere else entirely still has to be caught. Without this the
  // suite only ever exercises paths that TWO patterns cover, so a broken
  // `.npm-cache-tmp/` entry hides behind the `_cacache/` one.
  const dir = repo();
  writeFileSync(join(dir, "real.ts"), "1\n");
  for (const d of [".npm-cache-tmp/_locks", ".npm-cache/tmp", ".yarn-cache/v6", ".pnpm-store/v10"]) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, "f"), "x");
  }
  await adapter().commit(dir, "work", IDENT);
  const files = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean);
  assert.deepEqual(files, ["real.ts"]);
});

test("beta110: yarn, pnpm and bare _cacache trees are covered too", async () => {
  const dir = repo();
  writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
  for (const d of [".yarn/cache", ".pnpm-store/v3", "_cacache/index-v5", ".npm-cache/x"]) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, "blob"), "x");
  }
  await adapter().commit(dir, "work", IDENT);
  const files = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean);
  assert.deepEqual(files, ["src.ts"]);
});

test("beta110: a runaway cache is excluded even under a name we never predicted", async () => {
  // The container's npm cache was ALREADY outside the worktree
  // (/home/node/.npm-cache, writable HOME), so nothing forced the in-tree
  // path -- a worker chose `.npm-cache-tmp` itself, presumably via
  // `--cache .npm-cache-tmp`. The next one is free to choose anything, so the
  // named list cannot be the only defence.
  const dir = repo();
  writeFileSync(join(dir, "real.ts"), "1\n");
  mkdirSync(join(dir, "totally-made-up-dir", "nested"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(dir, "totally-made-up-dir", "nested", `f${i}`), "x");

  // Straight through commit(), with no direct call to the guard first --
  // otherwise dropping the guard FROM commit() would change nothing here.
  const a = new GitAdapter({
    worktreesRoot: mkdtempSync(join(tmpdir(), "b110-wt-")),
    logger: LOGGER,
    runawayUntrackedThreshold: 50,
  });
  await a.commit(dir, "work", IDENT);
  const files = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean);
  assert.deepEqual(files, ["real.ts"], "the sub-task's real work still commits; the runaway does not");
});

test("beta110: the runaway guard reports what it excluded", async () => {
  const dir = repo();
  mkdirSync(join(dir, "some-cache"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(dir, "some-cache", `f${i}`), "x");
  const a = new GitAdapter({
    worktreesRoot: mkdtempSync(join(tmpdir(), "b110-wt-")),
    logger: LOGGER,
    runawayUntrackedThreshold: 50,
  });
  assert.deepEqual(await a.excludeRunawayUntracked(dir), [{ dir: "some-cache", count: 60 }]);
});

test("beta110: an ordinary multi-file change is NOT mistaken for a runaway", async () => {
  // 807c92a0 on #932 was a legitimate 126-file OKF regeneration.
  const dir = repo();
  mkdirSync(join(dir, "okf"), { recursive: true });
  for (let i = 0; i < 126; i++) writeFileSync(join(dir, "okf", `bundle-${i}.json`), "{}\n");
  await adapter().commit(dir, "regenerate bundle", IDENT);
  const files = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean);
  assert.equal(files.length, 126, "126 new files under one root is real work, not a cache");
});

test("beta110: modified tracked files never count toward the runaway threshold", async () => {
  const dir = repo();
  mkdirSync(join(dir, "gen"), { recursive: true });
  for (let i = 0; i < 80; i++) writeFileSync(join(dir, "gen", `f${i}.json`), "{}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "generated once");
  for (let i = 0; i < 80; i++) writeFileSync(join(dir, "gen", `f${i}.json`), '{"v":2}\n');

  const a = new GitAdapter({
    worktreesRoot: mkdtempSync(join(tmpdir(), "b110-wt-")),
    logger: LOGGER,
    runawayUntrackedThreshold: 50,
  });
  assert.deepEqual(await a.excludeRunawayUntracked(dir), [], "regeneration modifies tracked files");
  await a.commit(dir, "regenerate", IDENT);
  const files = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean);
  assert.equal(files.length, 80);
});

test("beta110: loose files at the repo root are never treated as a runaway directory", async () => {
  const dir = repo();
  for (let i = 0; i < 60; i++) writeFileSync(join(dir, `root-${i}.ts`), "1\n");
  const a = new GitAdapter({
    worktreesRoot: mkdtempSync(join(tmpdir(), "b110-wt-")),
    logger: LOGGER,
    runawayUntrackedThreshold: 50,
  });
  assert.deepEqual(await a.excludeRunawayUntracked(dir), [], "excluding the repo root would commit nothing at all");
});

test("beta110: the runaway guard can be switched off", async () => {
  const dir = repo();
  mkdirSync(join(dir, "cache-x"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(dir, "cache-x", `f${i}`), "x");
  const a = new GitAdapter({
    worktreesRoot: mkdtempSync(join(tmpdir(), "b110-wt-")),
    logger: LOGGER,
    runawayUntrackedThreshold: 0,
  });
  assert.deepEqual(await a.excludeRunawayUntracked(dir), []);
});

test("beta110: the exclude goes in .git/info/exclude, NOT the repo's .gitignore", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.ts"), "1\n");
  await adapter().commit(dir, "work", IDENT);

  assert.ok(!existsSync(join(dir, ".gitignore")), "the target repo is somebody else's; do not edit their .gitignore");
  const excl = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
  for (const p of HARNESS_EXCLUDE_PATTERNS) assert.ok(excl.includes(p), `missing pattern ${p}`);
  assert.equal(git(dir, "status", "--porcelain").trim(), "", "and it must leave no dirty state behind");
});

test("beta110: an existing exclude file is preserved, and rewrites are idempotent", async () => {
  const dir = repo();
  const excludePath = join(dir, ".git", "info", "exclude");
  writeFileSync(excludePath, "# theirs\nsecret.txt\n");
  const a = adapter();

  await a.applyHarnessExcludes(dir);
  const first = readFileSync(excludePath, "utf8");
  assert.ok(first.includes("secret.txt"), "their patterns must survive");

  const added = await a.applyHarnessExcludes(dir);
  assert.deepEqual(added, [], "a second pass must add nothing");
  assert.equal(readFileSync(excludePath, "utf8"), first, "and must not grow the file");
});

test("beta110: it works in a LINKED worktree, where .git is a file", async () => {
  // The case that matters: every harness commit happens in a linked worktree,
  // where writing <worktree>/.git/info/exclude would silently do nothing.
  const dir = repo();
  const wt = join(mkdtempSync(join(tmpdir(), "b110-linked-")), "wt");
  git(dir, "worktree", "add", "-q", "-b", "feat", wt);
  assert.ok(readFileSync(join(wt, ".git"), "utf8").startsWith("gitdir:"), "fixture must be a linked worktree");

  writeFileSync(join(wt, "real.ts"), "1\n");
  mkdirSync(join(wt, ".npm-cache-tmp", "_cacache"), { recursive: true });
  writeFileSync(join(wt, ".npm-cache-tmp", "_cacache", "blob"), "x");

  await adapter().commit(wt, "work", IDENT);
  const files = git(wt, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean);
  assert.deepEqual(files, ["real.ts"], "resolve the real git dir via rev-parse --git-path");
});

test("beta110: a project that genuinely tracks such a path keeps working", async () => {
  // git's exclude only applies to UNTRACKED files, so an already-tracked path
  // must still be committable. Belt-and-braces against over-reach.
  const dir = repo();
  mkdirSync(join(dir, ".npm-cache-tmp"), { recursive: true });
  writeFileSync(join(dir, ".npm-cache-tmp", "kept.txt"), "v1\n");
  git(dir, "add", "-f", ".npm-cache-tmp/kept.txt");
  git(dir, "commit", "-q", "-m", "tracked on purpose");

  writeFileSync(join(dir, ".npm-cache-tmp", "kept.txt"), "v2\n");
  await adapter().commit(dir, "update tracked file", IDENT);
  const files = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean);
  assert.deepEqual(files, [".npm-cache-tmp/kept.txt"]);
});

test("beta110: a clean worktree still returns null rather than an empty commit", async () => {
  const dir = repo();
  assert.equal(await adapter().commit(dir, "nothing", IDENT), null);
});

/* ------------------------------------------------------------------ *
 * The second layer: fail fast
 * ------------------------------------------------------------------ */

const scopeLoop = (overrides = {}) => {
  const audits = [];
  const committed = overrides.committed ?? [];
  const loop = new OrchestratorLoop({
    config: { loop: { deterministic_final_scope_check: true, ...overrides.loop } },
    state: {
      audit: (event, payload) => audits.push({ event, payload }),
      db: { prepare: () => ({ get: () => ({ plan_base_sha: "b".repeat(40) }) }) },
    },
    interactionLog: { log() {} },
    logger: LOGGER,
    worktreeCommittedFiles: async () => committed,
    git: { baseSha: async () => "b".repeat(40) },
  });
  return { loop, audits };
};

const PLAN = {
  worktreePath: "/tmp/wt",
  baseSha: "b".repeat(40),
  subTasks: [{ seq: 1, filesLikelyTouched: ["prisma/schema.prisma"], verify: [] }],
};

test("beta110: 12,423 out-of-scope files ABORT the cycle, they do not become a finding", async () => {
  const committed = ["prisma/schema.prisma", ...Array.from({ length: 600 }, (_, i) => `.npm-cache-tmp/_cacache/b${i}`)];
  const { loop, audits } = scopeLoop({ committed });

  await assert.rejects(
    () => loop.runFinalScopeCheck("s1", PLAN, 1),
    (err) => {
      assert.ok(err instanceof ScopeBlowoutError, `expected ScopeBlowoutError, got ${err?.name}`);
      assert.equal(err.outOfScopeCount, 600);
      assert.match(err.message, /cannot be reviewed/);
      assert.match(err.message, /worktree is preserved/);
      return true;
    },
  );
  const blowout = audits.find((a) => a.event === "loop.scope_blowout");
  assert.ok(blowout, "the abort must be auditable");
  assert.equal(blowout.payload.outOfScopeCount, 600);
  assert.equal(blowout.payload.threshold, 500);
  assert.equal(blowout.payload.sample.length, 20, "a sample, not 12,423 paths in the audit row");
  assert.ok(!audits.some((a) => a.event === "loop.final_scope_check_out_of_scope"), "no finding path on a blowout");
});

test("beta110: ordinary scope creep is STILL just a medium finding", async () => {
  const { loop, audits } = scopeLoop({ committed: ["prisma/schema.prisma", "src/stray.ts", "src/other.ts"] });
  const findings = await loop.runFinalScopeCheck("s1", PLAN, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /Out-of-scope file write/);
  assert.ok(audits.some((a) => a.event === "loop.final_scope_check_out_of_scope"));
  assert.ok(!audits.some((a) => a.event === "loop.scope_blowout"), "two strays is not a blowout");
});

test("beta110: the threshold is the boundary, and 0 disables the tripwire", async () => {
  const strays = (n) => Array.from({ length: n }, (_, i) => `.npm-cache-tmp/b${i}`);

  const under = scopeLoop({ committed: ["prisma/schema.prisma", ...strays(499)] });
  assert.equal((await under.loop.runFinalScopeCheck("s", PLAN, 1)).length, 1, "499 stays a finding");

  const at = scopeLoop({ committed: ["prisma/schema.prisma", ...strays(500)] });
  await assert.rejects(() => at.loop.runFinalScopeCheck("s", PLAN, 1), ScopeBlowoutError, "500 aborts");

  const off = scopeLoop({
    committed: ["prisma/schema.prisma", ...strays(5000)],
    loop: { scope_blowout_file_threshold: 0 },
  });
  assert.equal((await off.loop.runFinalScopeCheck("s", PLAN, 1)).length, 1, "0 restores pre-b110 behaviour");
});

test("beta110: a custom threshold is honoured", async () => {
  const { loop } = scopeLoop({
    committed: ["prisma/schema.prisma", ...Array.from({ length: 12 }, (_, i) => `junk/${i}`)],
    loop: { scope_blowout_file_threshold: 10 },
  });
  await assert.rejects(() => loop.runFinalScopeCheck("s", PLAN, 1), ScopeBlowoutError);
});

/* ------------------------------------------------------------------ *
 * The observability gap
 * ------------------------------------------------------------------ */

test("beta110: a failed review still emits phase_timing", () => {
  // Session 9217236c's audit log has ONE phase_timing event -- `executing`.
  // The 15 minutes the adversary spent hanging had no number against it.
  const loop = D("orchestrator/loop.js");
  const i = loop.indexOf("adversary review crashed");
  assert.ok(i > 0);
  const after = loop.slice(i, i + 1500);
  assert.match(after, /emitPhaseTiming\(sessionId, "review", cycle, reviewStart/);
  assert.match(after, /isTimeout/);
  assert.match(after, /verdict: null/);
  // and it must run BEFORE the crash finaliser returns
  const timing = after.indexOf("emitPhaseTiming");
  const finalise = after.indexOf("finaliseReviewCrash");
  assert.ok(timing >= 0 && finalise > timing, "timing must be emitted before the run terminates");
});

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

test("beta110: commit() excludes BEFORE it stages", () => {
  const src = S("src/adapters/git-worktree.ts");
  const i = src.indexOf("async commit(worktreePath");
  const body = src.slice(i, i + 600);
  assert.ok(
    body.indexOf("applyHarnessExcludes") < body.indexOf('"add", "-A"'),
    "excluding after staging would be useless",
  );
});

test("beta110: the blowout is not swallowed at the call site", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("const scopeFindings = await this.runFinalScopeCheck");
  assert.ok(i > 0);
  // No try/catch wrapping the call itself -- it must propagate to loop.failed.
  assert.ok(!/try\s*\{[^}]*runFinalScopeCheck/s.test(src.slice(Math.max(0, i - 200), i + 100)));
});

test("beta110: the config key defaults to 500 and is overridable", () => {
  const MIN = { slack: { authorised_users: ["U1"] }, repos: { allowed: ["a/*"], default_base_branch: "main" } };
  assert.equal(parseHarnessConfig(MIN).loop.scope_blowout_file_threshold, 500);
  assert.equal(
    parseHarnessConfig({ ...MIN, loop: { scope_blowout_file_threshold: 0 } }).loop.scope_blowout_file_threshold,
    0,
  );
});

test("beta110: the key is declared in both schemas", () => {
  for (const f of ["src/config.schema.json", "openclaw.plugin.json"]) {
    assert.match(S(f), /scope_blowout_file_threshold/, `${f} missing the key`);
  }
});

test("beta110: pluginVersion and package.json agree at >= beta.110", () => {
  const betaNum = (s) => Number(/beta\.(\d+)/.exec(s)?.[1] ?? -1);
  const pkg = JSON.parse(S("package.json")).version;
  assert.ok(betaNum(pkg) >= 110, `expected >= beta.110, got ${pkg}`);
  assert.ok(S("src/version.ts").includes(pkg));
});
