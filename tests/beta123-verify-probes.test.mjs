// beta.123 — the verification probes, run against a real repository.
//
// Until b123 these lived inside `createRuntime` in index.ts, closed over
// git/pat/config, and could not be imported. Every suite that drove the loop
// therefore stubbed them, which means the code that decides whether a sub-task
// actually did its work was covered by nothing but eleven greps of index.ts --
// and those greps all stayed green while `file_committed` could not read a
// `git mv`.
//
// A pure rename is zero changed lines by construction. The b84 non-zero-diff
// gate read that as "the commit did not modify this file" and failed the one
// sub-task on the b122 smoke that had done exactly what the adversary asked.
// In a full run several upstream reconcilers usually rewrite the contract onto
// the new path first, so the gate is the LAST line rather than the only one --
// which is precisely why it needs testing here, where nothing can mask it.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { makeWorld, makeConfig, scenarioAvailable, git, IDENT, QUIET } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";

/** Real probes, real adapter, real repo, one worktree checked out at main. */
async function probeWorld(files) {
  const { createVerifyProbes } = await import("../dist/orchestrator/verify-probes.js");
  const { PatRouter } = await import("../dist/auth/pat-router.js");
  const world = await makeWorld({ files });
  const cfg = makeConfig();
  git(["remote", "set-url", "origin", world.origin], world.bare);
  const worktreePath = await world.adapter.allocate({
    repoFullName: "o/r",
    baseBranch: "main",
    sessionBranch: "harness/feat-probe",
    sessionId: "probe",
    ghToken: "",
    commitIdentity: IDENT,
  });
  const build = createVerifyProbes({
    git: world.adapter,
    pat: new PatRouter(cfg.pat_routing),
    config: cfg,
    resolveGitToken: async () => "",
  });
  const probes = build({
    plan: { repo: "o/r", branch: "harness/feat-probe", worktreePath },
    requester: "U1",
    worktreePath,
    baseSha: git(["rev-parse", "HEAD"], worktreePath),
  });
  return { world, worktreePath, probes, base: git(["rev-parse", "HEAD"], worktreePath) };
}

const write = (wt, rel, content) => {
  mkdirSync(dirname(join(wt, rel)), { recursive: true });
  writeFileSync(join(wt, rel), content);
};

test("beta123: file_committed accepts a pure rename of the contract path", { skip }, async () => {
  const p = await probeWorld({ "README.md": "# s\n", "src/a.ts": "export const a = 1;\n" });
  git(["mv", "src/a.ts", "src/b.ts"], p.worktreePath);
  await p.world.adapter.commit(p.worktreePath, "refactor: rename a to b", IDENT);

  const r = await p.probes.fileCommittedSince("src/a.ts", p.base);
  assert.equal(
    r.committed,
    true,
    `a rename IS the work; got: ${r.detail}`,
  );
  assert.match(r.detail, /RENAMED to src\/b\.ts/, "the detail must say where the work went");
});

test("beta123: an untouched file is still not committed, rename fix or not", { skip }, async () => {
  const p = await probeWorld({ "README.md": "# s\n", "src/a.ts": "export const a = 1;\n" });
  write(p.worktreePath, "src/other.ts", "export const o = 1;\n");
  await p.world.adapter.commit(p.worktreePath, "feat: something else", IDENT);

  const r = await p.probes.fileCommittedSince("src/a.ts", p.base);
  assert.equal(r.committed, false, "the b84 gate must still hold for a file nobody touched");
});

test("beta123: a renamed file whose destination is not in the range does not pass", { skip }, async () => {
  // Renamed and then deleted: git reports no surviving destination in the
  // window, so there is no work to point at and the gate must stay shut.
  const p = await probeWorld({ "README.md": "# s\n", "src/a.ts": "export const a = 1;\n" });
  git(["mv", "src/a.ts", "src/b.ts"], p.worktreePath);
  await p.world.adapter.commit(p.worktreePath, "refactor: rename", IDENT);
  git(["rm", "src/b.ts"], p.worktreePath);
  await p.world.adapter.commit(p.worktreePath, "chore: drop it", IDENT);

  const r = await p.probes.fileCommittedSince("src/a.ts", p.base);
  assert.equal(r.committed, false, `nothing survives at the destination; got: ${r.detail}`);
});

test("beta123: a rename onto a file later emptied does not pass", { skip }, async () => {
  // The destination exists, so the missing-file catch does not fire; what
  // stops this is the non-empty check. Without it a worker could satisfy a
  // contract by renaming the file and then truncating it.
  const p = await probeWorld({ "README.md": "# s\n", "src/a.ts": "export const a = 1;\n" });
  git(["mv", "src/a.ts", "src/b.ts"], p.worktreePath);
  await p.world.adapter.commit(p.worktreePath, "refactor: rename", IDENT);
  write(p.worktreePath, "src/b.ts", "");
  await p.world.adapter.commit(p.worktreePath, "chore: empty it", IDENT);

  const r = await p.probes.fileCommittedSince("src/a.ts", p.base);
  assert.equal(r.committed, false, `an empty destination is not the work; got: ${r.detail}`);
});

test("beta123: an ordinary edit still passes on its line count", { skip }, async () => {
  const p = await probeWorld({ "README.md": "# s\n", "src/a.ts": "export const a = 1;\n" });
  write(p.worktreePath, "src/a.ts", "export const a = 2;\n");
  await p.world.adapter.commit(p.worktreePath, "fix: bump", IDENT);

  const r = await p.probes.fileCommittedSince("src/a.ts", p.base);
  assert.equal(r.committed, true);
  assert.match(r.detail, /lines/, "an ordinary edit reports its diff, not a rename");
  assert.doesNotMatch(r.detail, /RENAMED/);
});

// ---------------------------------------------------------------------------
// Properties that used to be asserted by grepping index.ts for the probe's
// source text. Ten such tests broke the moment b123 moved the code, having
// never caught a defect -- including the whole time `file_committed` could not
// read a rename. Restated here as behaviour, which survives a refactor and
// would have caught it.
// ---------------------------------------------------------------------------

test("beta123: a same-basename sibling never satisfies file_committed", { skip }, async () => {
  // The b84 hardening, as behaviour: `route.ts` must not be satisfied by
  // committing `download/route.ts`. This is the false-positive that made the
  // strict-contract rule necessary in the first place.
  const p = await probeWorld({ "README.md": "# s\n", "src/app/api/thing/route.ts": "export const GET = 1;\n" });
  write(p.worktreePath, "src/app/api/thing/download/route.ts", "export const GET = 2;\n");
  await p.world.adapter.commit(p.worktreePath, "feat: download route", IDENT);

  const r = await p.probes.fileCommittedSince("src/app/api/thing/route.ts", p.base);
  assert.equal(r.committed, false, `a sibling is not the contract file; got: ${r.detail}`);
});

test("beta123: file_written accepts a git mv, which preserves mtime", { skip }, async () => {
  // b105's contradiction: `file_committed` PASSED and `file_written` FAILED on
  // the same file in the same commit, because a rename does not touch mtime.
  const p = await probeWorld({ "README.md": "# s\n", "src/old-name.ts": "export const a = 1;\n" });
  const before = Date.now();
  git(["mv", "src/old-name.ts", "src/new-name.ts"], p.worktreePath);
  await p.world.adapter.commit(p.worktreePath, "refactor: rename", IDENT);

  const w = await p.probes.fileWrittenSince("src/new-name.ts", before);
  assert.equal(w.written, true, `a renamed-to path counts as written; got: ${w.detail}`);
});

test("beta123: fileCommittedInBranch needs the file to be BOTH committed and on disk", { skip }, async () => {
  // The b85 relaxed probe: a file committed earlier in the branch passes even
  // when this sub-task did not touch it -- but only while it still exists.
  const p = await probeWorld({ "README.md": "# s\n" });
  write(p.worktreePath, "src/kept.ts", "export const k = 1;\n");
  write(p.worktreePath, "src/removed.ts", "export const r = 1;\n");
  await p.world.adapter.commit(p.worktreePath, "feat: two files", IDENT);
  git(["rm", "src/removed.ts"], p.worktreePath);
  await p.world.adapter.commit(p.worktreePath, "chore: drop one", IDENT);

  const kept = await p.probes.fileCommittedInBranch("src/kept.ts", p.base);
  assert.equal(kept.present, true, `still there; got: ${kept.detail}`);
  const gone = await p.probes.fileCommittedInBranch("src/removed.ts", p.base);
  assert.equal(gone.present, false, "committed once but deleted since is not present");
});

test("beta123: the relaxed probe is strict about WHICH file, too", { skip }, async () => {
  // b87 [3]: the revise-relaxed path must not accept a same-basename sibling
  // either. Relaxing "did this sub-task touch it" is not relaxing "is it the
  // right file".
  const p = await probeWorld({ "README.md": "# s\n" });
  write(p.worktreePath, "src/app/api/thing/download/route.ts", "export const GET = 1;\n");
  await p.world.adapter.commit(p.worktreePath, "feat: download route", IDENT);

  const r = await p.probes.fileCommittedInBranch("src/app/api/thing/route.ts", p.base);
  assert.equal(r.present, false, `a sibling is not the contract file; got: ${r.detail}`);
});

test("beta123: file_written follows a contract path whose directory drifted", { skip }, async () => {
  // The basename/test-file fallback, as behaviour: the lead guessed a
  // directory the repo does not use, the worker wrote the same file where the
  // repo really keeps it, and file_written still has to find it.
  const p = await probeWorld({ "README.md": "# s\n", "src/components/ui/button.tsx": "export const B = 1;\n" });
  const before = Date.now();
  write(p.worktreePath, "src/components/ui/sidebar.tsx", "export const S = 1;\n");
  await p.world.adapter.commit(p.worktreePath, "feat: sidebar", IDENT);

  const r = await p.probes.fileWrittenSince("src/components/layout/sidebar.tsx", before);
  assert.equal(r.written, true, `the drifted path must still resolve; got: ${r.detail}`);
});

test("beta123: pathRenamedAwaySince answers only about the source side", { skip }, async () => {
  const p = await probeWorld({ "README.md": "# s\n", "src/a.ts": "export const a = 1;\n" });
  git(["mv", "src/a.ts", "src/b.ts"], p.worktreePath);
  await p.world.adapter.commit(p.worktreePath, "refactor: rename", IDENT);

  const from = await p.world.adapter.pathRenamedAwaySince(p.worktreePath, p.base, "src/a.ts");
  assert.equal(from.renamed, true);
  assert.equal(from.to, "src/b.ts");
  assert.match(from.score, /^R/);

  // The destination was not renamed away -- pathIntroducedSince is the probe
  // that answers for that side, and conflating the two is how a rename ends up
  // passing in both directions.
  const to = await p.world.adapter.pathRenamedAwaySince(p.worktreePath, p.base, "src/b.ts");
  assert.equal(to.renamed, false);
});
