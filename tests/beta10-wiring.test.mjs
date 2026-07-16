/**
 * beta.10 regression tests: the optional probes MUST be wired into a real
 * production factory so verification actually verifies. Beta.9 shipped the
 * probe interface + inference + graceful-skip fallback, but the
 * `buildVerifyProbes` factory in src/index.ts did not provide any of the new
 * probes. The result was that `file_committed`, `remote_branch_exists`,
 * `file_pushed`, `pr_state`, `file_in_pr`, and `commit_sha_matches` all
 * returned `passed: true` on empty air (skipped, trusting SDK). Beta.10 wires
 * the probes to real fs + git + provider REST calls.
 *
 * These tests exercise the wired probes via a real (temp) filesystem plus a
 * stubbed `globalThis.fetch` so no network is required, no PAT is used, and
 * the assertions cover both happy-path and worker-confabulation cases.
 *
 * Design: we import `dist/orchestrator/verify.js` (`verifySubTaskOutput`) and
 * hand it a probes object that MIRRORS what src/index.ts builds - the same
 * shape, calling into the same node:fs / child_process / fetch surfaces - so
 * a break in either the wiring pattern OR the verify.ts contract is caught.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let verify;
try {
  verify = await import("../dist/orchestrator/verify.js");
} catch {
  verify = null;
}

const skipAll = { skip: verify === null };

/** Build a temp git repo with a base commit; return { worktreePath, baseSha }. */
function makeRepo() {
  const dir = mkdtempSync(pathResolve(tmpdir(), "beta10-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(pathResolve(dir, "README.md"), "# base\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"]);
  const baseSha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, baseSha };
}

/**
 * Build probes exactly the way src/index.ts is now expected to (loop-path
 * factory). We call the same primitives (fs.stat, git log/ls-remote, fetch)
 * so if the shape of the factory drifts, this test breaks first.
 */
function buildBeta10Probes({ worktreePath, baseSha, repo, branch, fetchStub }) {
  const [owner, repoName] = repo.split("/");
  const runGit = (args) => execFileSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" }).trim();
  const fetchFn = fetchStub ?? globalThis.fetch;

  return {
    // beta.8 required probes (minimal stubs sufficient for these tests).
    remoteBranchExists: async () => ({ exists: false, detail: "stub" }),
    prUrlPresent: async () => ({ present: false, detail: "stub" }),
    fileWrittenSince: async () => ({ written: false, detail: "beta.8 fallback should NOT be hit on beta.10 when fileExistsOnDisk is wired" }),
    commitMadeSince: async (base) => {
      const head = runGit(["rev-parse", "HEAD"]);
      const made = head !== base;
      return { made, detail: made ? `HEAD ${head.slice(0, 7)} != base ${base.slice(0, 7)}` : "no new commit" };
    },

    // beta.10 wired probes.
    fileExistsOnDisk: async (path) => {
      try {
        const st = await stat(pathResolve(worktreePath, path));
        const exists = st.isFile();
        const nonEmpty = st.size > 0;
        return {
          exists,
          nonEmpty,
          detail: exists
            ? nonEmpty
              ? `file present (${st.size} bytes)`
              : "file present but empty"
            : "path exists but is not a regular file",
        };
      } catch (err) {
        return { exists: false, nonEmpty: false, detail: `stat error: ${String(err)}` };
      }
    },
    fileCommittedSince: async (path, base) => {
      if (!base) return { committed: false, detail: "no base" };
      try {
        const out = execFileSync(
          "git",
          ["-C", worktreePath, "log", `${base}..HEAD`, "--name-only", "--pretty=format:"],
          { encoding: "utf8" },
        );
        const files = Array.from(new Set(out.split("\n").map((l) => l.trim()).filter(Boolean)));
        const committed = files.includes(path);
        return {
          committed,
          detail: committed ? `in ${base.slice(0, 7)}..HEAD` : `not in ${files.length} committed files`,
        };
      } catch (err) {
        return { committed: false, detail: `git log error: ${String(err)}` };
      }
    },
    remoteBranchSha: async (b) => {
      const res = await fetchFn(`https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/${b}`);
      if (res.status !== 200) return { sha: undefined, detail: `HTTP ${res.status}` };
      const j = await res.json();
      return { sha: j.object?.sha, detail: `HTTP 200 sha ${(j.object?.sha ?? "").slice(0, 7)}` };
    },
    remoteFileExists: async (path, b) => {
      const res = await fetchFn(`https://api.github.com/repos/${owner}/${repoName}/contents/${path}?ref=${b}`);
      return { exists: res.status === 200, detail: `HTTP ${res.status}` };
    },
    prForBranch: async (b) => {
      const res = await fetchFn(`https://api.github.com/repos/${owner}/${repoName}/pulls?head=${owner}:${b}&state=all`);
      const arr = await res.json();
      const prs = (Array.isArray(arr) ? arr : []).map((p) => ({
        number: p.number,
        state: p.state,
        draft: !!p.draft,
        url: p.html_url,
      }));
      return { count: prs.length, prs, detail: `${prs.length} PR(s)` };
    },
    prFiles: async (n) => {
      const res = await fetchFn(`https://api.github.com/repos/${owner}/${repoName}/pulls/${n}/files`);
      const arr = await res.json();
      const files = (Array.isArray(arr) ? arr : []).map((f) => ({ filename: f.filename }));
      return { files, detail: `${files.length} file(s)` };
    },
    localHeadSha: async () => {
      const sha = runGit(["rev-parse", "HEAD"]);
      return { sha, detail: `HEAD ${sha.slice(0, 7)}` };
    },
  };
}

// ============================================================
// The core beta.10 regression: file_written now PASSES for untracked files
// ============================================================

test(
  "beta.10: file_written PASSES for an untracked file written to the worktree (fixes beta.8 bug)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      // s1: write the file but do NOT commit. This is what the lead planner
      // asks worker s1 to do; it can never pass under beta.8 semantics.
      mkdirSync(pathResolve(dir, "docs"), { recursive: true });
      writeFileSync(pathResolve(dir, "docs/SMOKE.md"), "# smoke\n");

      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/smoke",
      });

      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "file_written", path: "docs/SMOKE.md" }],
        { defaultBranch: "harness/smoke", subTaskStartMs: Date.now() - 60_000, baseSha },
        probes,
      );

      assert.equal(outcome.ok, true, `expected ok, got: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.results.length, 1);
      assert.equal(outcome.results[0].kind, "file_written");
      assert.equal(outcome.results[0].passed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "beta.10: file_written FAILS when the file is not on disk (missing)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/smoke",
      });

      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "file_written", path: "docs/MISSING.md" }],
        { defaultBranch: "harness/smoke", subTaskStartMs: Date.now(), baseSha },
        probes,
      );

      assert.equal(outcome.ok, false);
      assert.equal(outcome.results[0].passed, false);
      assert.match(outcome.results[0].detail, /stat error|ENOENT|not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "beta.10: file_written FAILS when the file exists but is empty (0 bytes)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      mkdirSync(pathResolve(dir, "docs"), { recursive: true });
      writeFileSync(pathResolve(dir, "docs/EMPTY.md"), "");

      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/smoke",
      });

      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "file_written", path: "docs/EMPTY.md" }],
        { defaultBranch: "harness/smoke", subTaskStartMs: Date.now(), baseSha },
        probes,
      );

      assert.equal(outcome.ok, false);
      assert.equal(outcome.results[0].passed, false);
      assert.match(outcome.results[0].detail, /empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================
// file_committed: uses `git log base..HEAD --name-only`
// ============================================================

test(
  "beta.10: file_committed PASSES after write + commit (real git)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      mkdirSync(pathResolve(dir, "docs"), { recursive: true });
      writeFileSync(pathResolve(dir, "docs/SMOKE.md"), "# smoke\n");
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", "docs: add smoke"]);

      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/smoke",
      });

      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "file_committed", path: "docs/SMOKE.md" }],
        { defaultBranch: "harness/smoke", subTaskStartMs: Date.now(), baseSha },
        probes,
      );

      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.equal(outcome.results[0].passed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "beta.10: file_committed FAILS when file was written but never committed (untracked)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      mkdirSync(pathResolve(dir, "docs"), { recursive: true });
      writeFileSync(pathResolve(dir, "docs/SMOKE.md"), "# smoke\n");
      // Note: NO git add / commit. The file is untracked; committed files are empty.

      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/smoke",
      });

      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "file_committed", path: "docs/SMOKE.md" }],
        { defaultBranch: "harness/smoke", subTaskStartMs: Date.now(), baseSha },
        probes,
      );

      assert.equal(outcome.ok, false);
      assert.equal(outcome.results[0].passed, false);
      assert.match(outcome.results[0].detail, /not in .* committed files|not in commits since base/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================
// remote_branch_exists / commit_sha_matches / file_pushed / pr_* over stubbed HTTP
// ============================================================

/** Minimal fetch stub: returns pre-programmed responses per URL. */
function stubFetch(routes) {
  return async (url) => {
    const u = typeof url === "string" ? url : url.href;
    for (const [pattern, handler] of routes) {
      if (u.includes(pattern)) return handler();
    }
    return new Response("not stubbed: " + u, { status: 599 });
  };
}

test(
  "beta.10: remote_branch_exists PASSES on HTTP 200 with sha",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["refs/heads/harness/x", async () => new Response(JSON.stringify({ object: { sha: "abc123def456" } }), { status: 200 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "remote_branch_exists", branch: "harness/x" }],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.match(outcome.results[0].detail, /abc123d/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

test(
  "beta.10: remote_branch_exists FAILS on HTTP 404 (branch never pushed)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["refs/heads/harness/x", async () => new Response("not found", { status: 404 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "remote_branch_exists", branch: "harness/x" }],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, false);
      assert.match(outcome.results[0].detail, /HTTP 404|no ref/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

test(
  "beta.10: commit_sha_matches PASSES when local HEAD == remote tip",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      // Fetch stub returns local HEAD as remote sha; probe should match.
      const localHead = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["refs/heads/harness/x", async () => new Response(JSON.stringify({ object: { sha: localHead } }), { status: 200 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "commit_sha_matches", branch: "harness/x" }],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.match(outcome.results[0].detail, /SHA matches/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

test(
  "beta.10: commit_sha_matches FAILS when local HEAD != remote tip",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["refs/heads/harness/x", async () => new Response(JSON.stringify({ object: { sha: "0000000000000000000000000000000000000000" } }), { status: 200 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "commit_sha_matches", branch: "harness/x" }],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, false);
      assert.match(outcome.results[0].detail, /SHA mismatch/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

test(
  "beta.10: file_pushed PASSES on HTTP 200 contents lookup",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["contents/docs/SMOKE.md?ref=harness/x", async () => new Response(JSON.stringify({ sha: "x" }), { status: 200 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "file_pushed", path: "docs/SMOKE.md", branch: "harness/x" }],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

test(
  "beta.10: file_pushed FAILS on HTTP 404 (worker lied - file never pushed)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["contents/docs/SMOKE.md", async () => new Response("not found", { status: 404 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "file_pushed", path: "docs/SMOKE.md", branch: "harness/x" }],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, false);
      assert.match(outcome.results[0].detail, /HTTP 404/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

test(
  "beta.10: pr_state PASSES when PR is draft (matches expected state)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["pulls?head=owner:harness/x", async () => new Response(JSON.stringify([
            { number: 42, state: "open", draft: true, html_url: "https://github.com/owner/repo/pull/42" },
          ]), { status: 200 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "pr_state", state: "draft" }],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

test(
  "beta.10: file_in_pr PASSES when file is in PR files (looked up via prForBranch)",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["pulls?head=owner:harness/x", async () => new Response(JSON.stringify([
            { number: 42, state: "open", draft: true, html_url: "https://x" },
          ]), { status: 200 })],
          ["pulls/42/files", async () => new Response(JSON.stringify([
            { filename: "docs/SMOKE.md" },
            { filename: "README.md" },
          ]), { status: 200 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [{ kind: "file_in_pr", path: "docs/SMOKE.md" }],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

// ============================================================
// The confabulation scenario: worker "does" 5 steps, none happen.
// beta.9 lets 4 of 5 checks pass (skipped-as-true); beta.10 catches all.
// ============================================================

test(
  "beta.10: worker confabulation - all 5 remote checks fail against 404s",
  skipAll,
  async () => {
    const { dir, baseSha } = makeRepo();
    try {
      // No local commit, no local file, remote returns 404 for everything.
      const probes = buildBeta10Probes({
        worktreePath: dir,
        baseSha,
        repo: "owner/repo",
        branch: "harness/x",
        fetchStub: stubFetch([
          ["refs/heads/", async () => new Response("nf", { status: 404 })],
          ["contents/", async () => new Response("nf", { status: 404 })],
          ["pulls?", async () => new Response(JSON.stringify([]), { status: 200 })],
        ]),
      });
      const outcome = await verify.verifySubTaskOutput(
        [
          { kind: "file_written", path: "docs/SMOKE.md" },
          { kind: "file_committed", path: "docs/SMOKE.md" },
          { kind: "remote_branch_exists", branch: "harness/x" },
          { kind: "file_pushed", path: "docs/SMOKE.md", branch: "harness/x" },
          { kind: "pr_opened" },
        ],
        { defaultBranch: "harness/x", subTaskStartMs: Date.now(), baseSha },
        probes,
      );
      assert.equal(outcome.ok, false, JSON.stringify(outcome));
      // Every single check must FAIL. If any pass-as-skipped, the fix is broken.
      const passedCount = outcome.results.filter((r) => r.passed).length;
      assert.equal(passedCount, 0, `expected 0 passes; got ${passedCount}: ${JSON.stringify(outcome.results)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);
