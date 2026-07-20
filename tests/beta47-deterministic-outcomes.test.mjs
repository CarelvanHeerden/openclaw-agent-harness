// beta.47: fixes surfaced by the beta.46 harness_revise on PR #858 (session
// 94a516a0). Four fixes:
//   P1 (lead prompt): forbid self-defeating escape clauses on mutations,
//      forbid downstream deps hardcoding a skippable upstream outcome,
//      rename hygiene (destination-only filesLikelyTouched), one-concern
//      sub-tasks, checkable observe criteria. Source-asserted (prompt text).
//   P2 (store.audit): guard against a post-close/finalized-statement write
//      so the terminal worktree-release audit race can't crash the process.
//   P3 (worker): capture commit sha from HEAD when the worker self-commits
//      (working tree clean -> gitListChangedFiles empty -> harness skipped its
//      own commit -> commitSha was silently null though HEAD moved).
//   P4 (recovery): skip auto-resume when a loop for the session is already
//      running in-process (double-wake noise). Source-asserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ----------------------------------------------------------------------------
// P1: lead-prompt determinism rules (source assertions on the system prompt).
// ----------------------------------------------------------------------------
const sdkSrc = read("src/adapters/claude-sdk.ts");

test("beta47 P1: lead prompt forbids unchecked escape hatches on mutations", () => {
  assert.match(sdkSrc, /DETERMINISTIC OUTCOMES/);
  assert.match(sdkSrc, /do X unless Y/);
  // Names the exact anti-pattern phrases seen in session 94a516a0's plan.
  assert.match(sdkSrc, /skip the rename if the dirs already exist/);
  assert.match(sdkSrc, /retain if still used, note why/);
  assert.match(sdkSrc, /FORBIDDEN/);
});

test("beta47 P1: lead prompt requires outcome propagation across dependsOn", () => {
  assert.match(sdkSrc, /OUTCOME PROPAGATION/);
  assert.match(sdkSrc, /MUST NOT hardcode an outcome that an upstream sub-task is permitted to skip/);
});

test("beta47 P1: lead prompt requires rename filesLikelyTouched to be destination-only", () => {
  assert.match(sdkSrc, /RENAME\/MOVE HYGIENE/);
  assert.match(sdkSrc, /ONLY the DESTINATION paths/);
});

test("beta47 P1: lead prompt discourages bundling many concerns behind few checks", () => {
  assert.match(sdkSrc, /ONE CONCERN PER SUB-TASK/);
});

test("beta47 P1: lead prompt requires checkable observe criteria (no confirm-or-justify)", () => {
  assert.match(sdkSrc, /OBSERVE sub-tasks/);
  assert.match(sdkSrc, /confirm X or justify as N\/A/);
});

// ----------------------------------------------------------------------------
// P2: store.audit must not throw on a closed / finalized store.
// ----------------------------------------------------------------------------
let store;
try {
  store = await import("../dist/state/store.js");
} catch {
  store = null;
}

test("beta47 P2: audit() on a closed store is a no-op, never throws", { skip: !store }, async () => {
  // The store resolve()s pathHint to a real file, so use a temp path and
  // clean it up (a literal ':memory:' would litter the cwd).
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const dir = mkdtempSync(join(os.tmpdir(), "beta47-store-"));
  const dbPath = join(dir, "state.db");
  const s = store.openStateStoreSync(dbPath);
  try {
    assert.equal(s.isOpen(), true);
    // A pre-close audit works.
    s.audit("test.before_close", { ok: true }, null);
    s.close();
    assert.equal(s.isOpen(), false);
    // The whole point: this must NOT throw "statement has been finalized".
    assert.doesNotThrow(() => s.audit("test.after_close", { ok: false }, null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("beta47 P2: source guards audit against a post-close write", () => {
  const storeSrc = read("src/state/store.ts");
  // The audit fn checks `open` before writing and swallows a race error.
  assert.match(storeSrc, /audit:\s*\(event, payload, sessionId\)\s*=>\s*\{[\s\S]*?if \(!open\) return;/);
});

// ----------------------------------------------------------------------------
// P3: worker captures commit sha from HEAD when the worker self-commits.
// ----------------------------------------------------------------------------
let worker;
try {
  worker = await import("../dist/orchestrator/sonnet-worker.js");
} catch {
  worker = null;
}

// Minimal config faithful to the fields runWorker reads.
function fakeConfig() {
  return {
    models: { worker: "claude-test" },
    safety: { worker_permission_mode: "default" },
    loop: { worker_timeout_seconds: 30 },
  };
}
const noopLogger = { info() {}, warn() {}, error() {} };

test(
  "beta47 P3: worker self-commit (clean tree) still yields commitSha from HEAD",
  { skip: !worker },
  async () => {
    let headCalls = 0;
    let committedFilesCalls = 0;
    let harnessCommitCalled = false;
    const deps = {
      config: fakeConfig(),
      logger: noopLogger,
      runWorkerModel: async () => ({
        sdkSessionId: "sdk-1",
        stopReason: "end_turn",
        costUsd: 0.1,
        tokensIn: 1,
        tokensOut: 1,
        logsExcerpt: "",
      }),
      // baseSha is called for the sub-task-start ref AND (beta.47) for HEAD.
      // First call = base, subsequent = HEAD (advanced). We differentiate by
      // call order: gitBaseSha is invoked once at start; gitHeadSha later.
      gitBaseSha: async () => "aaaaaaaaaaaa",
      // Worker committed itself -> no uncommitted changes.
      gitListChangedFiles: async () => [],
      gitCommit: async () => {
        harnessCommitCalled = true;
        return "should-not-happen";
      },
      gitHeadSha: async () => {
        headCalls++;
        return "bbbbbbbbbbbb"; // HEAD advanced past base
      },
      gitListCommittedFiles: async () => {
        committedFilesCalls++;
        return ["src/lib/governance-risk/taxonomy-tree.ts"];
      },
      buildCanUseTool: () => async () => ({ allow: true }),
    };
    const res = await worker.runWorker(
      "/tmp/wt",
      { title: "t", motivation: "m", acceptanceCriteria: [] },
      { seq: 1, title: "rename", intent: "i", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 1 },
      { name: "n", email: "e" },
      deps,
    );
    assert.equal(harnessCommitCalled, false, "harness must NOT double-commit when tree is clean");
    assert.equal(res.commitSha, "bbbbbbbbbbbb", "commitSha must be HEAD when the worker self-committed");
    assert.ok(headCalls >= 1, "gitHeadSha must be consulted");
    assert.equal(committedFilesCalls, 1, "filesChanged backfilled from base..HEAD");
    assert.deepEqual(res.filesChanged, ["src/lib/governance-risk/taxonomy-tree.ts"]);
  },
);

test(
  "beta47 P3: no commit (HEAD == base) leaves commitSha undefined",
  { skip: !worker },
  async () => {
    const deps = {
      config: fakeConfig(),
      logger: noopLogger,
      runWorkerModel: async () => ({
        sdkSessionId: "sdk-2",
        stopReason: "end_turn",
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        logsExcerpt: "",
      }),
      gitBaseSha: async () => "aaaaaaaaaaaa",
      gitListChangedFiles: async () => [],
      gitCommit: async () => null,
      gitHeadSha: async () => "aaaaaaaaaaaa", // HEAD unchanged
      gitListCommittedFiles: async () => [],
      buildCanUseTool: () => async () => ({ allow: true }),
    };
    const res = await worker.runWorker(
      "/tmp/wt",
      { title: "t", motivation: "m", acceptanceCriteria: [] },
      { seq: 1, title: "noop", intent: "i", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 1 },
      { name: "n", email: "e" },
      deps,
    );
    assert.equal(res.commitSha, undefined, "no advance -> no sha");
    assert.deepEqual(res.filesChanged, []);
  },
);

test(
  "beta47 P3: uncommitted changes path still uses the harness commit (back-compat)",
  { skip: !worker },
  async () => {
    let harnessCommitCalled = false;
    const deps = {
      config: fakeConfig(),
      logger: noopLogger,
      runWorkerModel: async () => ({
        sdkSessionId: "sdk-3",
        stopReason: "end_turn",
        costUsd: 0.2,
        tokensIn: 1,
        tokensOut: 1,
        logsExcerpt: "",
      }),
      gitBaseSha: async () => "aaaaaaaaaaaa",
      gitListChangedFiles: async () => ["src/x.ts"], // uncommitted work present
      gitCommit: async () => {
        harnessCommitCalled = true;
        return "cccccccccccc";
      },
      gitHeadSha: async () => "cccccccccccc",
      gitListCommittedFiles: async () => {
        throw new Error("must not be called on the harness-commit path");
      },
      buildCanUseTool: () => async () => ({ allow: true }),
    };
    const res = await worker.runWorker(
      "/tmp/wt",
      { title: "t", motivation: "m", acceptanceCriteria: [] },
      { seq: 1, title: "edit", intent: "i", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 1 },
      { name: "n", email: "e" },
      deps,
    );
    assert.equal(harnessCommitCalled, true, "harness commits uncommitted work");
    assert.equal(res.commitSha, "cccccccccccc");
    assert.deepEqual(res.filesChanged, ["src/x.ts"]);
  },
);

test("beta47 P3: worker deps are wired with gitHeadSha + gitListCommittedFiles", () => {
  const indexSrc = read("src/index.ts");
  assert.match(indexSrc, /gitHeadSha:\s*\(wt\)\s*=>\s*git\.baseSha\(wt\)/);
  assert.match(indexSrc, /gitListCommittedFiles:\s*\(wt,\s*base\)\s*=>\s*git\.listCommittedFiles\(wt,\s*base\)/);
});

// ----------------------------------------------------------------------------
// P4: recovery skips auto-resume for an already-running session loop.
// ----------------------------------------------------------------------------
test("beta47 P4: recovery auto-resume is guarded by runningSessionIds()", () => {
  const indexSrc = read("src/index.ts");
  assert.match(
    indexSrc,
    /autoResume:\s*async\s*\(s\)\s*=>\s*\{[\s\S]*?if \(runningSessionIds\(\)\.includes\(s\.id\)\)/,
    "auto-resume must bail when the session loop is already running in-process",
  );
});
