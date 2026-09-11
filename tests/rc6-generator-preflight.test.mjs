// rc.6 -- the preflight that tells an operator what rc.6 will refuse, before
// they install it.
//
// rc.6 turns a `verify.generators` path that `repos.never_commit_paths` also
// covers into a blocking finding on every cycle. That is the right behaviour
// and it resolves nothing on its own: a deployment carrying the contradiction
// keeps loading and keeps failing until somebody edits the config. The
// preflight exists so that edit can be made from evidence rather than from the
// first blocked run.
//
// The symlink cases below are the reason this file exists at all. The first
// version of the walker called statSync on a link and descended when the target
// was a directory, directly contradicting the comment above it. Two ways that
// bites a tool whose whole job is scanning someone else's repository:
//
//   1. A link pointing outside the repo walks out of it, and every file found
//      out there is reported as though it were repo-relative -- so the operator
//      is told to keep protecting paths that do not exist in their tree, or
//      worse, shown the contents of an unrelated directory.
//   2. A link pointing at an ancestor never terminates.
//
// A symlink is now a leaf, which is also what git thinks it is: a blob holding
// the target path, not the tree at the other end. The thing that can be
// committed is the link.
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
 * expected result here (it is how the script gates a rollout), so it must not
 * be thrown.
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

function world({ neverCommit = ["okf/**"], nested = true, links = false } = {}) {
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

  const inner = { repos: { never_commit_paths: neverCommit }, verify: { generators: GENERATORS } };
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

test("rc.6 preflight: a symlink out of the repository is not followed", skipDist, (t) => {
  const w = world({ links: true });
  t.after(w.cleanup);
  const { stdout } = preflight([w.configPath, "--repo", w.repo], w.dir);

  assert.ok(!stdout.includes("leak.md"), "a file outside the repository must never be reported as inside it");
  assert.ok(!stdout.includes("outside/"), "nor may an out-of-tree directory appear in the proposal");
  // The discriminating assertions. A walker that descends through the link
  // reports the out-of-tree file under a repo-relative name -- `okf/escape/
  // leak.md` -- which inflates the count and turns the proposal into
  // `okf/escape/**`. Neither filename is printed on its own, so asserting only
  // on `leak.md` above passes against the broken walker; these do not.
  assert.ok(!stdout.includes("okf/escape/"), "nothing beneath the link may be reported: it is not in this tree");
  assert.match(stdout, /"okf\/escape"$/m, "the link is a committable leaf and stays in the proposal as one");
  assert.match(stdout, /currently covers 11 file\(s\)/, "9 real files plus 2 links, and nothing from outside");
});

test("rc.6 preflight: a symlink to an ancestor terminates", skipDist, (t) => {
  const w = world({ links: true });
  t.after(w.cleanup);
  // preflight() fails the test on a timeout kill, so arriving here at all is
  // the assertion. The count pins that the cycle was seen once, as a leaf.
  const { stdout, code } = preflight([w.configPath, "--repo", w.repo], w.dir);
  assert.equal(code, 1, "conflicts are still reported");
  assert.match(stdout, /currently covers 11 file\(s\)/, "9 real files plus 2 links, each counted once");
});

// ---------------------------------------------------------------------------
// What it reports
// ---------------------------------------------------------------------------

test("rc.6 preflight: every contradiction is named with the pattern that causes it", skipDist, (t) => {
  const w = world();
  t.after(w.cleanup);
  const { stdout, code } = preflight([w.configPath, "--repo", w.repo], w.dir);

  assert.equal(code, 1, "a contradiction must be able to gate a rollout");
  assert.match(stdout, /2 contradiction\(s\)/);
  assert.match(stdout, /script 'okf' produces 'okf\/bundle\.json'/);
  assert.match(stdout, /script 'okf:index' produces 'okf\/index\.json'/);
  assert.match(stdout, /excluded by never_commit_paths: okf\/\*\*/);
  // The mapping that is fine has to be visible as fine, or an operator cannot
  // tell a working config from an unexamined one.
  assert.match(stdout, /1 mapping\(s\) rc\.6 accepts as-is/);
  assert.match(stdout, /'codegen' -> src\/generated\//);
});

test("rc.6 preflight: the narrowing warns against simply deleting the pattern", skipDist, (t) => {
  const w = world();
  t.after(w.cleanup);
  const { stdout } = preflight([w.configPath, "--repo", w.repo], w.dir);

  // The two resolutions are not equivalent and the tool must not present them
  // as though they were: deleting the pattern reinstates the sweep it exists
  // to prevent.
  assert.match(stdout, /Do not simply delete/);
  assert.match(stdout, /141 of 154/, "the warning carries the evidence for itself");
  for (const p of ['"okf/generated/**"', '"okf/src/**"', '"okf/vendor/**"']) {
    assert.ok(stdout.includes(p), `the proposal keeps protecting ${p}`);
  }
  assert.ok(!stdout.includes('"okf/bundle.json"'), "and lifts the exclusion from the declared output");
});

test("rc.6 preflight: the proposed narrowing actually resolves the contradiction", skipDist, (t) => {
  // The proposal is worth nothing if applying it does not produce a clean run,
  // so the round trip is the test.
  const w = world({ neverCommit: ["okf/generated/**", "okf/src/**", "okf/vendor/**"] });
  t.after(w.cleanup);
  const { stdout, code } = preflight([w.configPath, "--repo", w.repo], w.dir);

  assert.equal(code, 0);
  assert.match(stdout, /No generator\/never_commit_paths contradiction/);
  assert.match(stdout, /3 mapping\(s\) rc\.6 accepts as-is/);
});

// ---------------------------------------------------------------------------
// Inputs it has to accept
// ---------------------------------------------------------------------------

test("rc.6 preflight: the plugin block is accepted on its own, not just the whole file", skipDist, (t) => {
  // An operator reaching for this is mid-incident. Requiring them to extract
  // the right sub-object first is a way to get a wrong answer from a correct
  // tool.
  const w = world({ nested: false });
  t.after(w.cleanup);
  const { stdout, code } = preflight([w.configPath, "--repo", w.repo], w.dir);
  assert.equal(code, 1);
  assert.match(stdout, /read as a plugin config block/);
  assert.match(stdout, /2 contradiction\(s\)/);
});

test("rc.6 preflight: without --repo it still names the patterns, without inventing a tree", skipDist, (t) => {
  const w = world();
  t.after(w.cleanup);
  const { stdout, code } = preflight([w.configPath], w.dir);
  assert.equal(code, 1);
  assert.match(stdout, /2 contradiction\(s\)/);
  assert.match(stdout, /Patterns needing attention: okf\/\*\*/);
  assert.ok(!stdout.includes("currently covers"), "it must not report on a tree it never read");
});

test("rc.6 preflight: a config with no generators is not a finding", skipDist, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ repos: { never_commit_paths: ["okf/**"] } }));
  const { stdout, code } = preflight([configPath], dir);
  assert.equal(code, 0, "an exclusion list on its own is an ordinary, correct configuration");
  assert.match(stdout, /No verify\.generators declared/);
});

test("rc.6 preflight: it writes nothing", skipDist, (t) => {
  const w = world({ links: true });
  t.after(w.cleanup);
  const before = execFileSync("find", [w.dir, "-type", "f", "-exec", "shasum", "{}", ";"], { encoding: "utf8" });
  preflight([w.configPath, "--repo", w.repo], w.dir);
  const after = execFileSync("find", [w.dir, "-type", "f", "-exec", "shasum", "{}", ";"], { encoding: "utf8" });
  assert.equal(after, before, "a preflight that edits the thing it is inspecting is not a preflight");
});
