// beta.65 (P0) — SPLIT-PHASE WATCHDOG. beta.64 shipped a first-token watchdog
// armed ONLY on stream-open (system/init), so it covered phase 2 (stream-open
// -> first-token) but MISSED phase 1 (call-init -> stream-open): a PRE-STREAM
// POST hang where the SDK streaming POST never returns its first byte, the
// `for await` never yields even system/init, the watchdog is never armed, and
// the harness sits for the full worker_timeout (1800s). Smoke #3 durable log:
// seq-3 sdk_request then NO sdk_stream_opened, NO sdk_first_token, 28+min
// silence, no abort, no retry.
//
// Live smoke #3 evidence ALSO showed phase 1 is highly variable even on SUCCESS
// (seq-1 47s, seq-2 422s-AND-SUCCEEDED, seq-3 hung >1800s), while phase 2 is
// always near-instant (4-5ms). So a SINGLE call-initiation timer would
// false-positive-abort a legit slow open. The fix is a SPLIT-PHASE watchdog:
//   - PHASE 1 (call-init -> stream-open): armed at call START, before the
//     for-await; bound by NEW loop.sdk_stream_open_timeout_seconds (default 120).
//   - PHASE 2 (stream-open -> first-token): armed on system/init; bound by the
//     EXISTING loop.sdk_first_token_timeout_seconds (default LOWERED 90 -> 30).
// Either firing => stopReason first_token_timeout + abort => the SAME existing
// fresh-session retry path. A phase-1 breach of a slow open is a benign
// abort-and-retry-fresh, never a terminal fail on first breach.
//
// Asserts (behavioral, via consumeWorkerStream + FAKE async-iterables):
//   (1) KEY: stream that NEVER opens within the phase-1 window => phase-1
//       watchdog fires first_token_timeout + abort (the exact smoke #3 case).
//   (2) REGRESSION GUARD: stream opens (system/init) but no first content block
//       within the phase-2 window => phase-2 watchdog fires (beta.64's case).
//   (3) NO PHASE-1 FALSE ABORT: a stream that opens LATE (after most of the
//       phase-1 window) then first-tokens instantly => clean end_turn, no abort.
//   (4) SOURCE: BOTH timers exist and the phase-1 timer is armed BEFORE the
//       for-await loop.
//   (5) SOURCE: sdk_stream_opened/sdk_first_token still emit; config + manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let consumeWorkerStream = null;
try {
  ({ consumeWorkerStream } = await import("../dist/adapters/claude-sdk.js"));
} catch {
  consumeWorkerStream = null;
}

// PRE-STREAM POST HANG: never yields ANYTHING (no system/init, no assistant) —
// hangs until aborted. Models the SDK streaming POST that never returns its
// first byte (smoke #3). Only the PHASE-1 watchdog can end it.
async function* hangBeforeOpen(abort) {
  await new Promise((resolve) => {
    if (abort.signal.aborted) return resolve();
    abort.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// STREAM OPENS then STALLS (no assistant token) — the beta.64-covered case.
// Only the PHASE-2 watchdog can end it.
async function* openThenStall(abort, sessionId = "sdk-sess-b65") {
  yield { type: "system", subtype: "init", session_id: sessionId };
  await new Promise((resolve) => {
    if (abort.signal.aborted) return resolve();
    abort.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// STREAM OPENS LATE (after `openAfterMs`) then first-tokens instantly. Models
// smoke #3 seq-2's legit-but-slow 422s open. Must NOT be phase-1-aborted when
// it opens WITHIN the phase-1 window.
async function* openLateThenToken(abort, openAfterMs, sessionId = "sdk-sess-late") {
  await new Promise((r) => setTimeout(r, openAfterMs));
  if (abort.signal.aborted) return;
  yield { type: "system", subtype: "init", session_id: sessionId };
  yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
  yield { type: "result", subtype: "success", total_cost_usd: 0.02, usage: { input_tokens: 6, output_tokens: 3 } };
}

async function* healthyStream(sessionId = "sdk-sess-ok") {
  yield { type: "system", subtype: "init", session_id: sessionId };
  yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
  yield { type: "result", subtype: "success", total_cost_usd: 0.03, usage: { input_tokens: 8, output_tokens: 4 } };
}

// ---- (1) THE KEY TEST: PHASE-1 (pre-stream POST hang, smoke #3) now caught ----
test("beta65/P0: PHASE 1 — stream NEVER opens within window => first_token_timeout + abort (smoke #3 case beta.64 MISSED)",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    const res = await consumeWorkerStream(hangBeforeOpen(abort), abort, {
      streamOpenTimeoutSeconds: 0.05, // 50ms phase-1 window
      firstTokenTimeoutSeconds: 60,   // phase-2 window irrelevant (never opens)
    });
    assert.equal(res.stopReason, "first_token_timeout",
      "the pre-stream POST hang must now be classified first_token_timeout");
    assert.equal(res.streamOpened, false,
      "stream NEVER opened (no system/init) — exactly what beta.64 could not detect");
    assert.equal(res.msToFirstToken, undefined, "no first token ever arrived");
    assert.equal(abort.signal.aborted, true, "phase-1 watchdog aborted the hung POST");
  });

test("beta65/P0: PHASE 1 — a disabled phase-1 window (<=0) never fires on a never-open stream (regression: beta.64 behaviour)",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    // With phase-1 disabled, the ONLY thing that ends hangBeforeOpen is an
    // external abort — this reproduces beta.64's blindness to the pre-stream
    // hang (proving the phase-1 timer is what fixes it).
    setTimeout(() => abort.abort(), 40);
    const res = await consumeWorkerStream(hangBeforeOpen(abort), abort, {
      streamOpenTimeoutSeconds: 0,   // phase-1 DISABLED (beta.64 shape)
      firstTokenTimeoutSeconds: 30,  // phase-2 armed only on open, never reached
    });
    assert.notEqual(res.stopReason, "first_token_timeout",
      "beta.64 shape: no phase-1 timer => the never-open hang is NOT a first_token_timeout");
    assert.equal(res.streamOpened, false);
  });

// ---- (2) REGRESSION GUARD: PHASE-2 stream-opened-no-token still caught ----
test("beta65/P0: PHASE 2 — stream opens but no first token within window => first_token_timeout (beta.64 case preserved)",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    const res = await consumeWorkerStream(openThenStall(abort), abort, {
      streamOpenTimeoutSeconds: 60,   // phase-1 satisfied (opens immediately)
      firstTokenTimeoutSeconds: 0.05, // 50ms phase-2 window
    });
    assert.equal(res.stopReason, "first_token_timeout");
    assert.equal(res.streamOpened, true, "stream DID open (system/init) — the beta.64-covered shape");
    assert.equal(res.sdkSessionId, "sdk-sess-b65", "sdkSessionId captured from system/init");
    assert.equal(res.msToFirstToken, undefined, "no first token arrived after open");
    assert.equal(abort.signal.aborted, true);
  });

// ---- (3) NO PHASE-1 FALSE ABORT for a legit-but-slow open (smoke #3 seq-2) ----
test("beta65/P0: legit slow open WITHIN the phase-1 window then instant first-token => NO false abort, clean end_turn",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    // Opens at 40ms, phase-1 window is 200ms => opens comfortably inside it.
    const res = await consumeWorkerStream(openLateThenToken(abort, 40), abort, {
      streamOpenTimeoutSeconds: 0.2,  // 200ms phase-1 window
      firstTokenTimeoutSeconds: 60,   // generous phase-2
    });
    assert.equal(res.stopReason, "end_turn", "opened within the phase-1 window => no false abort");
    assert.equal(res.streamOpened, true);
    assert.equal(typeof res.msToFirstToken, "number", "msToFirstToken recorded (spans both phases)");
    assert.ok(res.msToFirstToken >= 40, "msToFirstToken measured from call initiation, includes the slow open");
    assert.equal(res.costUsd, 0.02);
    assert.equal(abort.signal.aborted, false, "legit slow open is never aborted");
  });

test("beta65/P0: healthy fast stream disarms both phases cleanly, no abort",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    const res = await consumeWorkerStream(healthyStream(), abort, {
      streamOpenTimeoutSeconds: 120,
      firstTokenTimeoutSeconds: 30,
    });
    assert.equal(res.stopReason, "end_turn");
    assert.equal(res.streamOpened, true);
    assert.equal(typeof res.msToFirstToken, "number");
    assert.equal(res.costUsd, 0.03);
    assert.equal(abort.signal.aborted, false);
  });

// ---- (4) SOURCE: BOTH timers exist; phase-1 armed BEFORE the for-await ----
test("beta65/P0: BOTH watchdogs exist AND the phase-1 (stream-open) timer is armed BEFORE the for-await loop (source)", () => {
  const src = S("src/adapters/claude-sdk.ts");
  const consumeStart = src.indexOf("export async function consumeWorkerStream");
  assert.ok(consumeStart >= 0, "consumeWorkerStream present");
  const body = src.slice(consumeStart);
  // Both timers declared.
  assert.match(body, /armStreamOpenWatchdog/, "phase-1 (stream-open) watchdog present");
  assert.match(body, /armFirstTokenWatchdog/, "phase-2 (first-token) watchdog present");
  // Phase-1 armed BEFORE the for-await loop.
  const armPhase1Idx = body.indexOf("armStreamOpenWatchdog();");
  const forAwaitIdx = body.indexOf("for await (const message of stream)");
  assert.ok(armPhase1Idx >= 0, "armStreamOpenWatchdog() call present");
  assert.ok(forAwaitIdx >= 0, "for-await loop present");
  assert.ok(armPhase1Idx < forAwaitIdx,
    "phase-1 watchdog MUST be armed BEFORE the for-await loop (call initiation)");
  // Phase-2 armed on system/init (inside the loop, AFTER the for-await start).
  const armPhase2Idx = body.indexOf("armFirstTokenWatchdog();");
  assert.ok(armPhase2Idx > forAwaitIdx,
    "phase-2 watchdog is armed inside the loop (on system/init), after the for-await start");
  // Phase-1 timer fires on !streamOpened; phase-2 on !firstTokenSeen.
  assert.match(body, /if \(!streamOpened\) \{\s*firstTokenTimedOut = true;/,
    "phase-1 timer fires only when the stream never opened");
  assert.match(body, /if \(!firstTokenSeen\) \{\s*firstTokenTimedOut = true;/,
    "phase-2 timer fires only when no first token was seen");
});

// ---- (5) SOURCE: diagnostics + config + manifest wiring ----
test("beta65/P0: sdk_stream_opened + sdk_first_token diagnostics still emitted (source)", () => {
  const log = S("src/state/interaction-log.ts");
  assert.match(log, /event: "sdk_stream_opened"/);
  assert.match(log, /event: "sdk_first_token"/);
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /logSdkStreamOpened\(/);
  assert.match(loop, /logSdkFirstToken\(/);
});

test("beta65/P0: NEW config key sdk_stream_open_timeout_seconds in config.ts (default 120, clamp [10,600]) (source)", () => {
  const src = S("src/config.ts");
  assert.match(src, /sdk_stream_open_timeout_seconds\?: number/);
  assert.match(src, /sdk_stream_open_timeout_seconds: 120/);
  assert.match(src, /merged\.loop\.sdk_stream_open_timeout_seconds < 10/);
  assert.match(src, /merged\.loop\.sdk_stream_open_timeout_seconds > 600/);
});

test("beta65/P0: phase-2 default LOWERED 90 -> 30 in config.ts (source)", () => {
  const src = S("src/config.ts");
  assert.match(src, /sdk_first_token_timeout_seconds: 30/,
    "phase-2 default must be lowered to 30");
  assert.doesNotMatch(src, /sdk_first_token_timeout_seconds: 90/,
    "the old default 90 must be gone");
});

test("beta65/P0: sdk_stream_open_timeout_seconds declared in manifest configSchema (default 120, [10,600])", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  const loop = m.configSchema.properties.loop.properties;
  assert.ok(loop.sdk_stream_open_timeout_seconds,
    "must be declared or additionalProperties:false rejects the config");
  assert.equal(loop.sdk_stream_open_timeout_seconds.type, "integer");
  assert.equal(loop.sdk_stream_open_timeout_seconds.default, 120);
  assert.equal(loop.sdk_stream_open_timeout_seconds.minimum, 10);
  assert.equal(loop.sdk_stream_open_timeout_seconds.maximum, 600);
  // phase-2 default lowered in the manifest too.
  assert.equal(loop.sdk_first_token_timeout_seconds.default, 30,
    "phase-2 manifest default must be lowered to 30");
});

test("beta65/P0: sonnet-worker threads BOTH windows into runWorkerModel (source)", () => {
  const src = S("src/orchestrator/sonnet-worker.ts");
  assert.match(src, /firstTokenTimeoutSeconds: deps\.config\.loop\.sdk_first_token_timeout_seconds \?\? 30/);
  assert.match(src, /streamOpenTimeoutSeconds: deps\.config\.loop\.sdk_stream_open_timeout_seconds \?\? 120/);
});

test("beta65/P0: runWorkerSdk threads streamOpenTimeoutSeconds into consumeWorkerStream (source)", () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /streamOpenTimeoutSeconds\?: number/);
  assert.match(src, /streamOpenTimeoutSeconds: params\.streamOpenTimeoutSeconds/);
});

test("beta65/P0: loop audits split-phase attribution on first_token_timeout (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /phase1_stream_open/);
  assert.match(src, /phase2_first_token/);
  assert.match(src, /sdk_stream_open_timeout_seconds: this\.deps\.config\.loop\.sdk_stream_open_timeout_seconds/);
});
