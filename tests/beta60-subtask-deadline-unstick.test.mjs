// beta.60 — bound the ENTIRE runOne + force-unstick a dead executor.
//
// b59 PR#858 seq-7 stall (session 671b0396): the loop wedged at the seq-6->seq-7
// hand-off for 5h30m with the sub-task row stuck `running`, sdk_session_id=null,
// cost_usd=0, and NO worker process ever spawned. Root cause: beta.42 bounded
// only the worker SDK call (runWorker), but runOne ALSO awaits unbounded git/IO
// before/after the worker -- worktreeHeadSha (git rev-parse), readReactions,
// verifySubTaskOutput probes, budget.recordSpend. A hang in any of those froze
// the dispatcher at `await Promise.race(inFlight)` forever, and nothing
// re-called run() to arm the beta.42 stall-watchdog. Auto-recovery never fired
// (it covers planning-phase interrupts, not an `executing` session with a dead
// executor), and harness_resume REFUSED ("Cannot resume ... in status
// executing") with no escape hatch.
//
// Fix #1 (prevention): wrap the whole runOne in withTimeout(subtask_deadline_
//   seconds) at the dispatcher, so any IO hang -> SubTaskDeadline -> failed.err
//   -> clean terminal.
// Fix #3 (escape hatch): harness_resume force:true unsticks an `executing`/
//   `planning` session with NO live loop-runner; refuses terminal + refuses if
//   a runner still owns it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

// ---- config + manifest ----
test("beta60: subtask_deadline_seconds config default present and sane", async () => {
  const { parseHarnessConfig } = await import("../dist/config.js");
  // minimal valid config -> defaults filled
  const c = parseHarnessConfig({ slack: { authorised_users: ["U0TEST"] }, repos: { allowed: ["acme/*"] } });
  assert.equal(typeof c.loop.subtask_deadline_seconds, "number");
  assert.equal(c.loop.subtask_deadline_seconds, 2100);
  // must be >= worker_timeout_seconds (so the sub-task deadline never fires
  // BEFORE the worker's own bound -- it's the outer safety net).
  assert.ok(
    c.loop.subtask_deadline_seconds >= c.loop.worker_timeout_seconds,
    "subtask_deadline_seconds must be >= worker_timeout_seconds",
  );
});

test("beta60: manifest declares subtask_deadline_seconds (additionalProperties:false would reject config otherwise)", () => {
  const manifest = JSON.parse(S("openclaw.plugin.json"));
  // walk to the loop config schema
  const src = S("openclaw.plugin.json");
  assert.match(src, /"subtask_deadline_seconds"/);
  assert.match(src, /"default":\s*2100/);
});

// ---- Fix #1: dispatcher bounds the whole runOne ----
test("beta60: dispatcher wraps runOne in withTimeout(subtask_deadline_seconds), not just runWorker", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(
    src,
    /withTimeout\(runOne\(st\), this\.deps\.config\.loop\.subtask_deadline_seconds\)/,
    "runOne must be bounded by subtask_deadline_seconds at the dispatcher",
  );
  // on deadline: audit + mark the stuck row failed + set failed.err
  assert.match(src, /loop\.subtask_deadline_exceeded/);
  assert.match(src, /UPDATE sub_tasks SET status = 'failed'.*WHERE session_id = \? AND cycle = \? AND seq = \?/s);
  assert.match(src, /subtask_deadline_exceeded \(seq \$\{st\.seq\}\)/);
  // the pre-existing worker bound must still be there (defense in depth)
  assert.match(src, /withTimeout\(\s*this\.deps\.runWorker/s);
});

test("beta60: withTimeout bounds a hanging runOne (behavioral) -> the exact seq-7 hang is now catchable", async () => {
  const mod = await import("../dist/orchestrator/loop.js");
  const { withTimeout, WorkerTimeoutError } = mod;
  assert.ok(withTimeout && WorkerTimeoutError);
  // Simulate a runOne whose internal git/IO await never settles (worktreeHeadSha
  // hang). Before beta.60 the dispatcher awaited this forever; now it's bounded.
  const hangingRunOne = new Promise(() => {}); // never resolves
  await assert.rejects(
    () => withTimeout(hangingRunOne, 0.05),
    (err) => err instanceof WorkerTimeoutError,
  );
  // a fast runOne passes through untouched
  const fast = await withTimeout(Promise.resolve(), 5);
  assert.equal(fast, undefined);
});

test("beta60: loop exposes runningSessionIds() instance method delegating to the module guard", async () => {
  const src = S("src/orchestrator/loop.ts");
  // instance method added next to ownedRunningSessionIds
  assert.match(src, /runningSessionIds\(\): string\[\] \{\s*return runningSessionIds\(\);/s);
});

// ---- Fix #3: harness_resume force-unstick ----
test("beta60: harness_resume gains a force param + dead-executor unstick logic", () => {
  const src = S("src/tools/registration.ts");
  // force param declared
  assert.match(src, /force: \{ type: "boolean"/);
  // without force, non-resumable status still refuses (with a hint to use force)
  assert.match(src, /retry with force:true/);
  // force refuses terminal sessions
  assert.match(src, /Cannot force-resume .* it is terminal/);
  // force refuses if a live runner still owns the session
  assert.match(src, /liveRuntime\(\)\.loop\.runningSessionIds\(\)/);
  assert.match(src, /Refusing to force-resume .* a live loop-runner still owns it/);
  // audit for the forced path
  assert.match(src, /tool\.resume_forced/);
});

test("beta60: force path only fires for non-terminal, non-live sessions (executing/planning), never done/failed/aborted", () => {
  const src = S("src/tools/registration.ts");
  // terminal guard inside the force branch
  assert.match(src, /\["done", "failed", "aborted"\]\.includes\(row\.status\)/);
});
