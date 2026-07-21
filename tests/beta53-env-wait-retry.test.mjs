// beta.53: convert the "await a non-existent Monitor event" env-wait
// hallucination from a terminal failure into a recoverable one, and eradicate
// its trigger.
//
// From the beta.52 #858 revise (session 1d0dede8): 4/7 sub-tasks landed
// (best ever), then seq 5 (trivial a11y) WROTE the aria-label edit to disk
// (1145 bytes) but never committed, then said: "npm ci is still running. The
// Monitor will notify me when eslint is installed. Waiting for that event."
// Two failures exposed:
//   (1) my beta.52 WORKER_PROTOCOL_ASSUMPTION_RE FALSE-NEGATIVED that phrasing
//       (worker split the concept across two sentences).
//   (2) filesTouched was [] even though the worker wrote to disk, so the
//       partial-work turn read as "no side-effects".
//
// beta.53 fixes:
//   P1a  widen detection -> matchesEnvWaitHallucination (sentence-spanning,
//        + env/tool word). Rename audit event to loop.worker_env_wait_hallucination.
//   P2   GitAdapter.statusPorcelain + WorkerResult.uncommittedFiles so a
//        wrote-but-didn't-commit turn is visible (ordered BEFORE P1b).
//   P1b  retry-with-context: on match, re-invoke the sub-task ONCE with a
//        corrective hint (branched on partial-vs-zero work). config-gated.
//   P3/P4 worktree-bootstrap npm ci at allocation (removes the trigger).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(here, "..", p), "utf8");

const loop = await import("../dist/orchestrator/loop.js");
const { matchesEnvWaitHallucination } = loop;

// ---------------------------------------------------------------------------
// P1a: widened detection (the seq-5 split-sentence variant)
// ---------------------------------------------------------------------------
test("beta53 P1a: matches the beta.52 seq-5 split-sentence hallucination (the beta.52 miss)", () => {
  assert.equal(
    matchesEnvWaitHallucination("npm ci is still running. The Monitor will notify me when eslint is installed. Waiting for that event."),
    true,
  );
});

test("beta53 P1a: still matches the beta.51 seq-3 one-clause hallucination", () => {
  assert.equal(
    matchesEnvWaitHallucination("The install is still completing. I'll await the Monitor event signaling tsc is ready rather than polling further."),
    true,
  );
});

test("beta53 P1a: matches synonym watchers (Observer/Watcher/Sentinel) with an env word", () => {
  assert.equal(matchesEnvWaitHallucination("The Watcher will notify me when the build completes. Waiting for that event."), true);
});

test("beta53 P1a: does NOT match genuine reasoned refusals or unrelated 'event' uses", () => {
  assert.equal(matchesEnvWaitHallucination("These directories contain ~90 lib files. Deleting them would destroy unrelated code, so I left them in place."), false);
  assert.equal(matchesEnvWaitHallucination("I verified the finding-10 premise: the route uses governance-risk. The premise holds, so the move is correct."), false);
  assert.equal(matchesEnvWaitHallucination("Refactored the page to consume the shared module and committed locally."), false);
  // "event" present but not an env-wait: must NOT match
  assert.equal(matchesEnvWaitHallucination("I added an onClick event handler to the button and committed."), false);
});

// ---------------------------------------------------------------------------
// P2: GitAdapter.statusPorcelain parsing (real git)
// ---------------------------------------------------------------------------
import { GitAdapter } from "../dist/adapters/git-worktree.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

test("beta53 P2: statusPorcelain surfaces uncommitted + untracked files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b53-status-"));
  try {
    const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "committed.txt"), "x");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);
    // now make one modified + one untracked
    writeFileSync(join(dir, "committed.txt"), "y");
    writeFileSync(join(dir, "newfile.tsx"), "z");
    const adapter = new GitAdapter({ worktreesRoot: dir, logger: { info() {}, warn() {}, error() {} } });
    const dirty = await adapter.statusPorcelain(dir);
    assert.ok(dirty.includes("committed.txt"), "modified file present");
    assert.ok(dirty.includes("newfile.tsx"), "untracked file present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("beta53 P2: statusPorcelain is empty on a clean tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b53-clean-"));
  try {
    const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.txt"), "x");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);
    const adapter = new GitAdapter({ worktreesRoot: dir, logger: { info() {}, warn() {}, error() {} } });
    assert.deepEqual(await adapter.statusPorcelain(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source-assertion wiring checks (P1b, P2, P3/P4, event rename)
// ---------------------------------------------------------------------------
test("beta53 wiring: loop.ts emits renamed loop.worker_env_wait_hallucination event", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /"loop\.worker_env_wait_hallucination"/);
  // old beta.52 event name should be gone as an emitted event
  assert.doesNotMatch(src, /audit\(\s*"loop\.worker_incorrect_protocol_assumption"/);
  // detection now goes through the exported predicate, not the bare regex
  assert.match(src, /matchesEnvWaitHallucination\(refusalText\)/);
});

test("beta53 wiring: P1b retry-with-context, ordered AFTER P2 (uncommittedFiles), gated by config", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /loop\.worker_env_wait_retry/);
  assert.match(src, /env_wait_retry_enabled !== false/);
  // branches on partial-work using uncommittedFiles from P2
  assert.match(src, /result\.uncommittedFiles/);
  assert.match(src, /at most ONE env-wait retry per sub-task|let envWaitRetried = false/);
  // only no-change kinds are retryable (never a confabulated push/PR)
  assert.match(src, /ENV_WAIT_RETRYABLE_KINDS/);
});

test("beta53 wiring: WorkerResult carries uncommittedFiles, worker threads dispatchHint", () => {
  const worker = S("src/orchestrator/sonnet-worker.ts");
  assert.match(worker, /uncommittedFiles\?: string\[\]/);
  assert.match(worker, /gitStatusPorcelain\?:/);
  assert.match(worker, /dispatchHint\?: string/);
  // dispatchHint is appended to the user message
  assert.match(worker, /dispatchHint \? `\\n\\n\$\{dispatchHint\}`/);
});

test("beta53 wiring: env-prep bootstrap runs at worktree allocation", () => {
  const gw = S("src/adapters/git-worktree.ts");
  assert.match(gw, /bootstrapWorktreeDeps/);
  assert.match(gw, /npm ci|"ci"/);
  assert.match(gw, /this\.opts\.bootstrapDeps !== false/);
  // best-effort: must not throw out of allocate
  assert.match(gw, /deps bootstrap failed \(non-fatal\)/);
});

test("beta53 wiring: config + manifest expose env_wait_retry_enabled (default true)", () => {
  assert.match(S("src/config.ts"), /env_wait_retry_enabled\?: boolean/);
  assert.match(S("src/config.ts"), /env_wait_retry_enabled: true/);
  const mani = JSON.parse(S("openclaw.plugin.json"));
  const loopProps = mani.contracts?.config?.properties?.loop?.properties
    ?? findLoopProps(mani);
  assert.ok(loopProps && loopProps.env_wait_retry_enabled, "manifest loop block must declare env_wait_retry_enabled");
  assert.equal(loopProps.env_wait_retry_enabled.default, true);
});

// manifest schema nesting differs across versions; find the loop props block
function findLoopProps(obj) {
  let found = null;
  JSON.stringify(obj, (k, v) => {
    if (k === "loop" && v && v.properties && v.properties.worker_timeout_seconds) found = v.properties;
    return v;
  });
  return found;
}
