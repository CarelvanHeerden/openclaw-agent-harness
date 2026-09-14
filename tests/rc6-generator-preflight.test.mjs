// The generator-config preflight: what a deployment's `verify.generators` and
// `repos.never_commit_paths` will actually do, before a run finds out.
//
// The answer this reports reversed between rc.6 and rc.7, and the tests moved
// with it. rc.6 refused an overlap outright and the script proposed a narrowing
// to escape it. rc.7 made the exclusion spare whatever the committing sub-task
// is contracted to generate, so the overlap is no longer a fault -- it is the
// configuration an operator with a checked-in generated bundle wants, and the
// narrowing the script used to propose is actively harmful, because enumerating
// siblings loses protection for every directory added later.
//
// So the script now reports ownership coverage, and the question worth asking
// is "is every excluded path something can commit owned by a declared
// generator", not "do these overlap".
//
// The symlink cases are load-bearing and predate the reversal. The first
// version of the walker called statSync on a link and descended when the target
// was a directory, contradicting the comment above it. Two ways that bites a
// tool whose job is scanning someone else's repository:
//
//   1. A link out of the repo walks out of it, and everything found out there
//      is reported as though it were repo-relative.
//   2. A link to an ancestor never terminates.
//
// A symlink is a leaf, which is what git stores: a blob holding the target, not
// the tree at the other end.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SCRIPT = join(root, "scripts", "generator-config-preflight.mjs");
const skipDist = {
  skip: existsSync(join(root, "dist", "orchestrator", "generated-artifacts.js")) ? false : "dist not built",
};

/**
 * Run the preflight and hand back its output and status. A non-zero exit is an
 * expected result (it is how the script gates a rollout), so it must not throw.
 */
function preflight(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      // Generous relative to the ~200ms this takes, but finite: a walker that
      // stopped terminating should fail this suite rather than hang it.
      timeout: 30_000,
    });
    return { code: 0, stdout };
  } catch (err) {
    if (err.killed || err.signal) assert.fail(`preflight did not terminate: ${err.signal ?? "killed"}`);
    return { code: err.status, stdout: `${err.stdout ?? ""}` };
  }
}

const GENERATORS = [
  { script: "okf", produces: ["okf/bundle.json"], inputs: ["okf/src/"] },
  { script: "okf:index", produces: ["okf/index.json"] },
  { script: "codegen", produces: ["src/generated/"] },
];

function world({ neverCommit = ["okf/**"], generators = GENERATORS, nested = true, links = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const repo = join(dir, "repo");
  for (const d of ["okf/src", "okf/generated", "okf/vendor", "src/generated"]) {
    mkdirSync(join(repo, d), { recursive: true });
  }
  writeFileSync(join(repo, "okf", "bundle.json"), "x");
  writeFileSync(join(repo, "okf", "index.json"), "x");
  for (const i of [1, 2, 3]) {
    writeFileSync(join(repo, "okf", "src", `s${i}.md`), "x");
    writeFileSync(join(repo, "okf", "generated", `g${i}.md`), "x");
  }
  writeFileSync(join(repo, "okf", "vendor", "v1.md"), "x");

  if (links) {
    // Outside the repository entirely, holding a file whose name must never
    // appear in the output.
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "leak.md"), "secret");
    symlinkSync(outside, join(repo, "okf", "escape"));
    // And a loop back to an ancestor of the link itself.
    symlinkSync(join(repo, "okf"), join(repo, "okf", "vendor", "cycle"));
  }

  const inner = { repos: { never_commit_paths: neverCommit }, verify: { generators } };
  const config = nested
    ? { plugins: { entries: { "openclaw-agent-harness": { config: inner } } } }
    : inner;
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { dir, repo, configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Symlinks
// ---------------------------------------------------------------------------

test("preflight: a symlink out of the repository is not followed", skipDist, (t) => {
  const w = world({ links: true });
  t.after(w.cleanup);
  const { stdout } = preflight([w.configPath, "--repo", w.repo], w.dir);

  assert.ok(!stdout.includes("leak.md"), "a file outside the repository must never be reported as inside it");
  assert.ok(!stdout.includes("outside/"), "nor may an out-of-tree directory appear in the report");
  // The discriminating assertion. A walker that descends through the link finds
  // the out-of-tree file and counts it, and no filename is printed for the
  // counted set -- so asserting only on `leak.md` above passes against the
  // broken walker. The count does not.
  assert.match(stdout, /Excluded files in this checkout: 11/, "9 real files plus 2 links, nothing from outside");
});

test("preflight: a symlink to an ancestor terminates", skipDist, (t) => {
  const w = world({ links: true });
  t.after(w.cleanup);
  // preflight() fails the test on a timeout kill, so arriving here is itself
  // the assertion; the count pins that the cycle was seen once, as a leaf.
  const { stdout } = preflight([w.configPath, "--repo", w.repo], w.dir);
  assert.match(stdout, /Excluded files in this checkout: 11/);
});

// ---------------------------------------------------------------------------
// Ownership coverage
// ---------------------------------------------------------------------------

test("preflight: an overlap is reported as fine, and says why no edit is needed", skipDist, (t) => {
  const w = world();
  t.after(w.cleanup);
  const { stdout, code } = preflight([w.configPath, "--repo", w.repo], w.dir);

  assert.equal(code, 0, "an overlap is no longer a fault, so it must not gate a rollout");
  assert.match(stdout, /2 declared output\(s\) are covered by the exclusion list/);
  assert.match(stdout, /okf\/bundle\.json -- owned by 'okf'/);
  assert.match(stdout, /okf\/index\.json -- owned by 'okf:index'/);
  assert.match(stdout, /No config edit is|no config edit is/i);
  // The reversal has to be explicit, or an operator who read the rc.6 advice
  // goes ahead and narrows anyway.
  assert.match(stdout, /narrowing the list by hand would lose protection/i);
});

test("preflight: excluded files nothing owns are counted and named", skipDist, (t) => {
  // The case that genuinely cannot be satisfied: no generator claims these, so
  // no sub-task can ever commit them.
  const w = world();
  t.after(w.cleanup);
  const { stdout } = preflight([w.configPath, "--repo", w.repo], w.dir);

  assert.match(stdout, /owned by a generator \(committable by the sub-task that owns them\): 2/);
  assert.match(stdout, /owned by nothing \(revert applies to every turn\):\s+7/);
  assert.match(stdout, /okf\/src\/s1\.md/, "and they are named, since a contract on one reads as a dead generator");
});

test("preflight: no overlap at all is reported plainly", skipDist, (t) => {
  const w = world({ neverCommit: ["vendor/**"] });
  t.after(w.cleanup);
  const { stdout, code } = preflight([w.configPath, "--repo", w.repo], w.dir);
  assert.equal(code, 0);
  assert.match(stdout, /No declared output is covered by the exclusion list/);
});

// ---------------------------------------------------------------------------
// Mapping faults, which ARE still blocking
// ---------------------------------------------------------------------------

test("preflight: an ambiguously-owned path is still a rejected mapping", skipDist, (t) => {
  const w = world({
    generators: [
      { script: "okf", produces: ["okf/bundle.json"] },
      { script: "okf-alt", produces: ["okf/bundle.json"] },
    ],
  });
  t.after(w.cleanup);
  const { stdout, code } = preflight([w.configPath, "--repo", w.repo], w.dir);

  assert.equal(code, 1, "a rejected mapping still blocks runs, so it still gates a rollout");
  assert.match(stdout, /1 rejected mapping\(s\)/);
  assert.match(stdout, /ownership is ambiguous/);
});

// ---------------------------------------------------------------------------
// Inputs it has to accept
// ---------------------------------------------------------------------------

test("preflight: the plugin block is accepted on its own, not just the whole file", skipDist, (t) => {
  // An operator reaching for this is mid-incident. Requiring them to extract
  // the right sub-object first is a way to get a wrong answer from a correct
  // tool.
  const w = world({ nested: false });
  t.after(w.cleanup);
  const { stdout } = preflight([w.configPath, "--repo", w.repo], w.dir);
  assert.match(stdout, /read as a plugin config block/);
  assert.match(stdout, /2 declared output\(s\) are covered/);
});

test("preflight: without --repo it reports ownership but invents no tree", skipDist, (t) => {
  const w = world();
  t.after(w.cleanup);
  const { stdout } = preflight([w.configPath], w.dir);
  assert.match(stdout, /2 declared output\(s\) are covered/);
  assert.ok(!stdout.includes("Excluded files in this checkout"), "it must not report on a tree it never read");
  assert.match(stdout, /Re-run with `--repo/);
});

test("preflight: a config with no generators has nothing to report", skipDist, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ repos: { never_commit_paths: ["okf/**"] } }));
  const { stdout, code } = preflight([configPath], dir);
  assert.equal(code, 0, "an exclusion list on its own is an ordinary, correct configuration");
  assert.match(stdout, /no interaction to report/);
});

test("preflight: it writes nothing", skipDist, (t) => {
  const w = world({ links: true });
  t.after(w.cleanup);
  const before = execFileSync("find", [w.dir, "-type", "f", "-exec", "shasum", "{}", ";"], { encoding: "utf8" });
  preflight([w.configPath, "--repo", w.repo], w.dir);
  const after = execFileSync("find", [w.dir, "-type", "f", "-exec", "shasum", "{}", ";"], { encoding: "utf8" });
  assert.equal(after, before, "a preflight that edits the thing it is inspecting is not a preflight");
});
