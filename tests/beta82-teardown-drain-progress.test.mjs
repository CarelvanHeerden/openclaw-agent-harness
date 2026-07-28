// beta.82: progress-aware teardown drain. FIFTH consecutive beta (b54/b60/b80/
// b81) died when a plugin re-register mid-run scheduled a teardown of the
// PREVIOUS runtime, and that teardown's HARD `teardown_drain_seconds` ceiling
// force-closed the DB out from under a still-LIVE loop -> "database is not
// open" -> orphaned loop -> session hangs in `executing` with no terminal.
//
// The fix: decideDrainAction() is a pure helper -- past the deadline it only
// force-tears-down when the owned loop is WEDGED (no progress past
// stuck_loop_seconds); a loop still advancing its progress marker keeps its DB
// held indefinitely. These are behavioral tests on the pure helper plus
// source-assertion wiring for the teardown() internals (not exported).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decideDrainAction } from "../dist/state/teardown-drain.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
const STUCK = 2700 * 1000; // stuck_loop_seconds default in ms

test("beta82: no owned running loops -> drain-complete (safe to close)", () => {
  const a = decideDrainAction({
    nowMs: 10_000_000,
    deadlineMs: 5_000_000, // already past deadline
    sample: { running: [], lastProgressMs: 0 },
    prevProgressMs: 0,
    stuckThresholdMs: STUCK,
  });
  assert.equal(a.kind, "drain-complete");
});

test("beta82: before the deadline, always keep waiting (loops still running)", () => {
  const a = decideDrainAction({
    nowMs: 4_000_000,
    deadlineMs: 5_000_000,
    sample: { running: ["s1"], lastProgressMs: 3_999_000 },
    prevProgressMs: 0,
    stuckThresholdMs: STUCK,
  });
  assert.equal(a.kind, "keep-waiting");
  assert.equal(a.reason, "loops-still-running");
});

test("beta82: THE FIX -- past the deadline but loop ADVANCED since last poll -> keep waiting, never guillotine", () => {
  const now = 6_000_000;
  const a = decideDrainAction({
    nowMs: now,
    deadlineMs: 5_000_000, // deadline already passed
    sample: { running: ["s1"], lastProgressMs: 5_500_000 }, // advanced...
    prevProgressMs: 5_000_000, // ...beyond what we saw last poll
    stuckThresholdMs: STUCK,
  });
  assert.equal(a.kind, "keep-waiting");
  assert.equal(a.reason, "loop-still-progressing");
});

test("beta82: past the deadline, no advance since last poll BUT progress is fresh (< stuck threshold) -> keep waiting", () => {
  const now = 6_000_000;
  const a = decideDrainAction({
    nowMs: now,
    deadlineMs: 5_000_000,
    // no advance vs prevProgressMs, but only 60s old -> well within stuck threshold
    sample: { running: ["s1"], lastProgressMs: now - 60_000 },
    prevProgressMs: now - 60_000,
    stuckThresholdMs: STUCK,
  });
  assert.equal(a.kind, "keep-waiting");
  assert.equal(a.reason, "loop-still-progressing");
});

test("beta82: past the deadline AND loop WEDGED (no advance, stale past stuck threshold) -> force-teardown", () => {
  const now = 10_000_000;
  const a = decideDrainAction({
    nowMs: now,
    deadlineMs: 5_000_000,
    // last progress was 3000s ago (> 2700s stuck threshold) and did not advance
    sample: { running: ["s1"], lastProgressMs: now - 3_000_000 },
    prevProgressMs: now - 3_000_000,
    stuckThresholdMs: STUCK,
  });
  assert.equal(a.kind, "force-teardown");
  assert.equal(a.reason, "loops-wedged-stale");
});

test("beta82: past the deadline with UNKNOWN progress (lastProgressMs=0, no advance) -> wedged/force-teardown", () => {
  // DB closed/racy -> progress unknown (0). Errs toward wedged (safe: a live
  // loop keeps advancing updated_at, so it would read fresh instead).
  const a = decideDrainAction({
    nowMs: 10_000_000,
    deadlineMs: 5_000_000,
    sample: { running: ["s1"], lastProgressMs: 0 },
    prevProgressMs: 0,
    stuckThresholdMs: STUCK,
  });
  assert.equal(a.kind, "force-teardown");
  assert.equal(a.reason, "loops-wedged-stale");
});

test("beta82: the b81 DR/BCP scenario -- 1h deadline hit while a 4-subtask feature run is mid-cycle and progressing -> HELD, not orphaned", () => {
  // Reproduces the exact failure: teardown scheduled at re-register, deadline
  // = start + 3600s, but the loop checkpointed a worker pass ~90s ago and is
  // clearly alive. Pre-beta.82 this force-closed the DB; now it holds.
  const now = 1_000_000_000; // arbitrary epoch
  const a = decideDrainAction({
    nowMs: now,
    deadlineMs: now - 5_000, // 5s past the 1h deadline
    sample: { running: ["37b01e86"], lastProgressMs: now - 90_000 }, // last checkpoint 90s ago
    prevProgressMs: now - 400_000, // last poll saw older progress -> it advanced
    stuckThresholdMs: STUCK,
  });
  assert.equal(a.kind, "keep-waiting");
  assert.equal(a.reason, "loop-still-progressing", "a live, progressing feature run must NOT be guillotined at the deadline");
});

// ---- source-assertion wiring (teardown() is an internal of the plugin entry) ----

test("beta82: teardown imports and uses decideDrainAction + DrainProgressSample", () => {
  assert.ok(
    /import \{[^}]*decideDrainAction[^}]*\} from "\.\/state\/teardown-drain\.js"/.test(indexSrc),
    "index.ts must import decideDrainAction from the teardown-drain module",
  );
  assert.ok(indexSrc.includes("decideDrainAction({"), "teardown must call decideDrainAction to decide each poll");
});

test("beta82: teardown samples session progress via last_checkpoint_at/updated_at, guarded by isOpen()", () => {
  assert.ok(indexSrc.includes("const sampleProgress"), "teardown must define a progress sampler");
  assert.ok(
    indexSrc.includes("last_checkpoint_at, updated_at FROM sessions WHERE id IN"),
    "sampler must read the progress markers of the owned running sessions",
  );
  assert.ok(
    indexSrc.includes("runtime.state.isOpen()"),
    "sampler must guard against a closed DB (best-effort, unknown progress on race)",
  );
});

test("beta82: force-teardown emits a clean loop.torn_down_while_running terminal audit (observability half)", () => {
  assert.ok(
    indexSrc.includes('"loop.torn_down_while_running"'),
    "a wedged loop being torn down must emit a terminal audit so it does not hang in executing with no terminal",
  );
  // The audit must be emitted on the force-teardown path, not the happy path.
  const forceIdx = indexSrc.indexOf('forcedWedged = true');
  const auditIdx = indexSrc.indexOf('"loop.torn_down_while_running"');
  assert.ok(forceIdx > 0 && auditIdx > forceIdx, "the terminal audit must be on the force-teardown branch");
});

test("beta82: the progress-aware drain still precedes state.close()", () => {
  const decideIdx = indexSrc.indexOf("decideDrainAction({");
  const closeIdx = indexSrc.indexOf("runtime.state.close()");
  assert.ok(decideIdx > 0 && closeIdx > 0 && decideIdx < closeIdx, "the drain decision loop must run before state.close()");
});

test("beta82: stuck_loop_seconds is read for the wedged threshold (reuses existing config, no new key)", () => {
  assert.ok(
    indexSrc.includes("runtime.config?.loop?.stuck_loop_seconds ?? 2700"),
    "teardown must derive the wedged-staleness threshold from stuck_loop_seconds",
  );
});
