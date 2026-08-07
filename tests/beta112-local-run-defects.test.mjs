/**
 * beta.112 regression suite.
 *
 * Every defect here was found by driving the harness directly from a laptop
 * rather than reading a report of a production run. Three of the four surfaced
 * inside half an hour on the first two local runs; the merge-recommendation one
 * had survived every release since b109 because it only shows on a `pass`
 * verdict and ProjectThanos PR #932 -- the only PR being exercised -- never
 * produced one.
 *
 * 1. Harness git ops inherited the host's ambient credential helper.
 * 2. A `pass` review carrying a medium finding was reported as carrying none.
 * 3. A new route segment was described to the worker as a hallucinated path.
 * 4. Confabulation fired on a file that was demonstrably in the commit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { deriveMergeRecommendation } from "../dist/orchestrator/merge-recommendation.js";
import { findSuspectPlanPaths, describeSuspectPlanPaths } from "../dist/orchestrator/plan-path-validate.js";
import { detectWorkerConfab } from "../dist/orchestrator/worker-confab-detect.js";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const tmp = (label) => mkdtempSync(join(tmpdir(), `b112-${label}-`));

// ---------------------------------------------------------------------------
// 1. ambient credential helper
// ---------------------------------------------------------------------------

test("beta112: an ambient credential.helper no longer shadows the harness's own", () => {
  const repo = tmp("cred");
  git(repo, "init", "-q");
  // Stand in for the host's global config: osxkeychain on a Mac, `manager` on
  // Windows, `store` on plenty of CI images. Repo-local config is read after
  // it, which is what made this survivable in the Docker container and fatal
  // everywhere else.
  //
  // Not asserted as the only entry, because on macOS it usually is not: Apple's
  // git has osxkeychain compiled in as a default, so it appears here even under
  // GIT_CONFIG_SYSTEM=/dev/null with a hermetic GIT_CONFIG_GLOBAL. There is no
  // config file to remove it from. That is the ambient helper that hijacked the
  // first local ProjectThanos run, and it is why the reset has to be explicit.
  git(repo, "config", "--local", "credential.helper", "ambient-host-helper");
  const before = git(repo, "config", "--get-all", "credential.helper").split("\n").filter(Boolean);
  assert.ok(before.includes("ambient-host-helper"), "the ambient helper should be visible before the reset");

  // The sequence installCredHelper now runs, in the order it runs it.
  git(repo, "config", "--replace-all", "credential.helper", "");
  git(repo, "config", "--add", "credential.helper", "/tmp/oah-cred/credential-helper.sh");

  const helpers = git(repo, "config", "--get-all", "credential.helper").split("\n");
  const reset = helpers.indexOf("");
  assert.ok(reset >= 0, "the inherited-helper reset is missing");
  assert.deepEqual(
    helpers.slice(reset + 1),
    ["/tmp/oah-cred/credential-helper.sh"],
    "ours must be the only helper after the reset; anything before it is discarded by git",
  );
  // Apple's git keeps osxkeychain in the list no matter what, so "is it still
  // listed" is the wrong question. "Which one does git actually ask" is the
  // right one, and the only one the failing run cared about.
  assert.ok(before.every((h) => helpers.indexOf(h) < reset), "an ambient helper survived past the reset");
});

test("beta112: git asks the harness's helper, not the host's", () => {
  // The failing run's symptom was a bare "remote: Repository not found" on a
  // private repo: git had authenticated fine, just as the wrong user. Nothing
  // in the config output says that. Only asking git who it would send does.
  const repo = tmp("fill");
  const bin = tmp("bin");
  git(repo, "init", "-q");

  const helper = (name, user) => {
    const path = join(bin, `${name}.sh`);
    writeFileSync(path, `#!/bin/sh\n[ "$1" = get ] || exit 0\necho username=${user}\necho password=${user}-token\n`);
    chmodSync(path, 0o700);
    return path;
  };
  const ambient = helper("ambient", "wrong-user");
  const ours = helper("harness", "harness-user");

  git(repo, "config", "--local", "credential.helper", ambient);
  const asks = () =>
    execFileSync("git", ["-C", repo, "credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      // Never let a real secret reach an assertion message.
    }).replace(/^password=.*$/gm, "password=<redacted>");

  // Whoever wins here, it must not be us -- we have not been configured yet.
  // On macOS the winner is the developer's own login keychain, which is the
  // production bug verbatim: Apple's git lists osxkeychain from a compiled-in
  // default that no config file contains, it answers first, and the harness
  // ends up talking to GitHub as whoever is logged into the laptop. On Linux
  // CI the winner is the `ambient` script above. Either proves the same point.
  assert.ok(!asks().includes("username=harness-user"), "precondition: an ambient helper answers before ours");

  git(repo, "config", "--replace-all", "credential.helper", "");
  git(repo, "config", "--add", "credential.helper", ours);

  const filled = asks();
  assert.match(filled, /username=harness-user/, "git must authenticate as the harness's identity");
  assert.ok(!filled.includes("CarelvanHeerden") && !filled.includes("wrong-user"), "no ambient identity may reach the remote");
});

test("beta112: the reset is written before the helper, not after", () => {
  // Order is the whole fix: git treats an empty value as "discard the list so
  // far", so reset-then-add works and add-then-reset leaves nothing at all.
  const src = readFileSync("dist/adapters/git-worktree.js", "utf8");
  const reset = src.indexOf('"credential.helper", ""');
  const add = src.indexOf('"--add", "credential.helper"');
  assert.ok(reset > 0, "the inherited-helper reset is missing");
  assert.ok(add > 0, "the harness helper is never added to the generic section");
  assert.ok(reset < add, "reset must be written before the helper is added");
});

// ---------------------------------------------------------------------------
// 2. a pass verdict that carries a blocking finding
// ---------------------------------------------------------------------------

// ProjectThanos PR #952, cycle 2, exactly as the adversary returned it.
const PR952 = [
  {
    severity: "medium",
    dimension: "codebase-fit",
    title: "Recycled, still unfixed: mandated help-content update is absent from the diff",
  },
  { severity: "low", dimension: "quality", title: "byStatus/byRating typed as Record<string, number>" },
  { severity: "info", dimension: "quality", title: "Expiring-count test tolerates wrong horizon values" },
  { severity: "info", dimension: "quality", title: "Rows with null residualRiskRating" },
  { severity: "info", dimension: "runtime", title: "Local verification green" },
];

const pass = (findings, extra = {}) =>
  deriveMergeRecommendation({
    review: { verdict: "pass", summary: "", findings },
    reachedCleanPass: true,
    ciStatus: "success",
    ...extra,
  });

test("beta112: a pass carrying a medium finding is not reported as clean", () => {
  const rec = pass(PR952, { blockingFindings: 1 });
  assert.equal(rec.recommendation, "do_not_merge");
  assert.match(rec.reason, /1 blocking finding\(s\) at medium severity or above/);
  assert.match(rec.reason, /help-content/, "the reason must name the finding it is withholding on");
  assert.ok(
    !/none blocking/.test(rec.reason),
    "this exact string shipped on #952 while loop.blocking_findings recorded 1",
  );
});

test("beta112: the recommendation agrees with the count the loop logged", () => {
  // The bug was two definitions of "blocking" in one module: the caller counted
  // with isBlockingFinding (medium and above), the pass path scanned a set that
  // omitted medium. Same review, two answers.
  for (const blockingFindings of [1, 2, 5]) {
    const rec = pass(PR952, { blockingFindings });
    assert.equal(rec.recommendation, "do_not_merge", `blockingFindings=${blockingFindings}`);
    assert.match(rec.reason, new RegExp(`${blockingFindings} blocking finding`));
  }
});

test("beta112: a genuinely clean pass still merges", () => {
  const clean = PR952.filter((f) => f.severity !== "medium");
  const rec = pass(clean, { blockingFindings: 0 });
  assert.equal(rec.recommendation, "merge");
  assert.match(rec.reason, /no blocking findings/);
  assert.match(rec.reason, /4 informational\/low/);
});

test("beta112: one definition of blocking, whether or not the caller counted", () => {
  assert.equal(pass([{ severity: "high", title: "h" }]).recommendation, "do_not_merge");
  assert.equal(pass([{ severity: "critical", title: "c" }]).recommendation, "do_not_merge");
  // No blockingFindings supplied. The old code fell back to a severity set that
  // omitted medium -- i.e. straight back into the #952 bug. It must not.
  assert.equal(pass(PR952).recommendation, "do_not_merge", "medium blocks even when the caller did not count");
  assert.equal(pass([{ severity: "low", title: "l" }]).recommendation, "merge");
  assert.equal(pass([{ severity: "info", title: "i" }]).recommendation, "merge");
});

test("beta112: red CI still wins over everything", () => {
  const rec = pass([{ severity: "low", title: "l" }], { blockingFindings: 0, ciStatus: "failure" });
  assert.equal(rec.recommendation, "do_not_merge");
  assert.match(rec.reason, /CI checks are failing/);
});

// ---------------------------------------------------------------------------
// 3. new directory vs invented directory
// ---------------------------------------------------------------------------

// Both real cases, from the repo listings they actually ran against.
const THANOS_FILES = [
  "src/app/api/grc/exceptions/route.ts",
  "src/app/api/grc/key-management/stats/route.ts",
  "src/app/api/grc/poi/stats/route.ts",
  "src/components/ui/sidebar.tsx",
  "src/components/grc/poi-inventory-table.tsx",
];
const NEW_SEGMENT = "src/app/api/grc/exceptions/stats/route.ts"; // #952, correct
const INVENTED = "src/components/layout/grc-nav.tsx"; // b100, hallucinated

test("beta112: a new route segment with a sibling is not called a guess", () => {
  const s = findSuspectPlanPaths([NEW_SEGMENT], THANOS_FILES);
  assert.equal(s.length, 1);
  // The evidence is precedent, not depth. `stats/` already exists under
  // `src/app/api/grc/`, one level above this path's nearest real ancestor.
  assert.equal(s[0].precedent, "src/app/api/grc/key-management/stats");
  const note = describeSuspectPlanPaths(s);
  assert.match(note, /NEW DIRECTORY NOTE/);
  assert.match(note, /key-management\/stats/, "the note should cite the sibling it is reasoning from");
  assert.ok(!note.includes("GUESSES"), "this went to a worker whose path was correct and had two siblings");
  assert.ok(!note.includes("PLAN PATH WARNING"), "a path may not appear in both buckets");
});

test("beta112: an invented directory still gets the strong warning", () => {
  // The real b100 path. Also one level below a directory that exists, which is
  // why depth alone could not tell these two apart and precedent is the test.
  const s = findSuspectPlanPaths([INVENTED], THANOS_FILES);
  assert.equal(s.length, 1);
  assert.equal(s[0].missingDepth, 1, "same depth as the correct path above");
  assert.equal(s[0].precedent, undefined, "nothing named layout/ exists anywhere near src/components");
  const note = describeSuspectPlanPaths(s);
  assert.match(note, /PLAN PATH WARNING/);
  assert.match(note, /Treat these as GUESSES/);
  assert.ok(
    !note.includes("NEW DIRECTORY NOTE"),
    "an invented path must not also be blessed as an expected new directory",
  );
});

test("beta112: a common directory name far away does not vouch for a path", () => {
  // Precedent is scoped to the ancestor's parent. A `stats/` under some other
  // top-level tree must not license `src/components/layout/`.
  const s = findSuspectPlanPaths([INVENTED], [...THANOS_FILES, "server/jobs/layout/run.ts"]);
  assert.equal(s[0].precedent, undefined);
  assert.match(describeSuspectPlanPaths(s), /GUESSES/);
});

test("beta112: a mixed plan says both things, each about the right path", () => {
  const s = findSuspectPlanPaths([NEW_SEGMENT, INVENTED], THANOS_FILES);
  const note = describeSuspectPlanPaths(s);
  assert.match(note, /PLAN PATH WARNING/);
  assert.match(note, /NEW DIRECTORY NOTE/);
  const warn = note.indexOf("PLAN PATH WARNING");
  const newDir = note.indexOf("NEW DIRECTORY NOTE");
  assert.ok(note.slice(warn, newDir).includes("grc-nav.tsx"), "the guess bucket holds the invented path");
  assert.ok(!note.slice(warn, newDir).includes("stats/route.ts"), "and only the invented path");
  assert.ok(note.slice(newDir).includes("stats/route.ts"), "the new-directory bucket holds the real one");
  assert.ok(!note.slice(newDir).includes("grc-nav.tsx"), "and only the real one");
});

test("beta112: an existing directory is never flagged at all", () => {
  assert.deepEqual(findSuspectPlanPaths(["src/app/api/grc/exceptions/new-file.ts"], THANOS_FILES), []);
  assert.deepEqual(findSuspectPlanPaths(["README.md"], THANOS_FILES), []);
});

// ---------------------------------------------------------------------------
// 4. confabulation vs the commit
// ---------------------------------------------------------------------------

const ROUTE = "src/app/api/grc/exceptions/stats/route.ts";

test("beta112: no confab warning about a file that is in the commit", () => {
  const probe = detectWorkerConfab("I did not touch route.ts in this pass.", [ROUTE], [ROUTE]);
  assert.equal(probe.suspected, false, "#952 fired this while file_committed passed on the same path");
  assert.deepEqual(probe.offenders, []);
});

test("beta112: a genuine skip is still caught", () => {
  const probe = detectWorkerConfab("I did not touch route.ts in this pass.", [ROUTE], ["src/unrelated.ts"]);
  assert.equal(probe.suspected, true);
  assert.deepEqual(probe.offenders, [ROUTE]);
});

test("beta112: with no commit information the detector behaves exactly as before", () => {
  for (const committed of [undefined, []]) {
    const probe = detectWorkerConfab("I did not touch route.ts in this pass.", [ROUTE], committed);
    assert.equal(probe.suspected, true, "absent git evidence must not be read as proof the file landed");
  }
});

test("beta112: one skipped file among several committed ones is still reported", () => {
  const other = "src/app/(portal)/grc/exceptions/page.tsx";
  const probe = detectWorkerConfab(`Committed ${other}. I did not touch route.ts.`, [ROUTE, other], [other]);
  assert.equal(probe.suspected, true);
  assert.deepEqual(probe.offenders, [ROUTE]);
});

test("beta112: pluginVersion and package.json agree at >= beta.112", () => {
  const betaNum = (s) => Number(/beta\.(\d+)/.exec(s)?.[1] ?? -1);
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
  assert.ok(betaNum(pkg) >= 112, `expected >= beta.112, got ${pkg}`);
  assert.ok(readFileSync("src/version.ts", "utf8").includes(pkg));
});
