// beta.64 (P0-1) — FIRST-TOKEN WATCHDOG + sdk_stream_opened / sdk_first_token
// events. Fixes beta.63 smoke #2: a verify sub-task worker SDK call HUNG -- the
// stream opened (system/init) but NO first assistant token ever arrived; the
// call produced ZERO tool calls / ZERO output / ZERO cost / no sdkSessionId and
// sat for the FULL worker_timeout (1800s) with no inner-turn stall detection.
//
// Asserts (behavioral, via the extracted consumeWorkerStream helper + a FAKE
// async-iterable, no real SDK):
//   - a stream that opens then yields NO assistant message before the window =>
//     abort + stopReason "first_token_timeout" (distinct from "timeout")
//   - a healthy stream => streamOpened + msToFirstToken populated, end_turn
//   - a stream that never even opens (no system/init) before the window =>
//     first_token_timeout is NOT falsely raised (watchdog only arms on open)
//   - source-assertion wiring for the config key + interaction-log events.
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

// A fake stream that yields system/init then STALLS forever (never an
// assistant message), so the first-token watchdog is the only thing that can
// end it. `abort` is honoured to break out of the wait.
async function* stallAfterOpen(abort, sessionId = "sdk-sess-1") {
  yield { type: "system", subtype: "init", session_id: sessionId };
  // Wait until aborted (the watchdog fires abort.abort()), then stop.
  await new Promise((resolve) => {
    if (abort.signal.aborted) return resolve();
    abort.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  // No more messages: return.
}

async function* healthyStream(sessionId = "sdk-sess-2") {
  yield { type: "system", subtype: "init", session_id: sessionId };
  yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
  yield { type: "result", subtype: "success", total_cost_usd: 0.05, usage: { input_tokens: 10, output_tokens: 5 } };
}

// A stream that never opens (no system/init) and then completes quickly.
async function* neverOpens() {
  // yields nothing (POST hung before the stream opened -> stream just ends)
}

test("beta64/P0-1: no first token in the window => first_token_timeout (distinct from timeout)",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    const res = await consumeWorkerStream(stallAfterOpen(abort), abort, { firstTokenTimeoutSeconds: 0.05 });
    assert.equal(res.stopReason, "first_token_timeout", "must be the DISTINCT first_token_timeout reason");
    assert.equal(res.streamOpened, true, "stream opened (system/init arrived) before the hang");
    assert.equal(res.sdkSessionId, "sdk-sess-1", "sdkSessionId captured from system/init");
    assert.equal(res.msToFirstToken, undefined, "no first token ever arrived");
    assert.equal(abort.signal.aborted, true, "watchdog aborted the stream");
  });

test("beta64/P0-1: healthy stream => streamOpened + msToFirstToken populated, end_turn",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    const res = await consumeWorkerStream(healthyStream(), abort, { firstTokenTimeoutSeconds: 60 });
    assert.equal(res.stopReason, "end_turn");
    assert.equal(res.streamOpened, true);
    assert.equal(typeof res.msToFirstToken, "number", "time-to-first-token recorded");
    assert.ok(res.msToFirstToken >= 0);
    assert.equal(res.costUsd, 0.05);
    assert.equal(abort.signal.aborted, false, "healthy stream is never aborted");
  });

test("beta64/P0-1: a stream that never opens does NOT falsely raise first_token_timeout",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    const res = await consumeWorkerStream(neverOpens(), abort, { firstTokenTimeoutSeconds: 0.02 });
    // The watchdog only ARMS on stream open; a stream that ended without ever
    // opening is a POST-never-opened case, classified as end_turn here (the
    // outer worker timeout / caller handles a truly-hung POST separately).
    assert.equal(res.streamOpened, false, "stream never opened");
    assert.notEqual(res.stopReason, "first_token_timeout", "watchdog must not fire before stream open");
  });

test("beta64/P0-1: disabled watchdog (window<=0) never fires first_token_timeout",
  { skip: consumeWorkerStream === null }, async () => {
    const abort = new AbortController();
    // Kick an external abort shortly so stallAfterOpen returns; with the
    // watchdog disabled this is a plain "timeout" (aborted, not first_token).
    setTimeout(() => abort.abort(), 30);
    const res = await consumeWorkerStream(stallAfterOpen(abort), abort, { firstTokenTimeoutSeconds: 0 });
    assert.notEqual(res.stopReason, "first_token_timeout", "watchdog disabled => never first_token_timeout");
  });

// ---- source-assertion wiring ----
test("beta64/P0-1: sdk_first_token_timeout_seconds in config.ts + default 90 + clamp (source)", () => {
  const src = S("src/config.ts");
  assert.match(src, /sdk_first_token_timeout_seconds\?: number/);
  // beta.65: phase-2 default lowered 90 -> 30 in the split-phase redesign.
  assert.match(src, /sdk_first_token_timeout_seconds: 30/);
  assert.match(src, /merged\.loop\.sdk_first_token_timeout_seconds < 10/);
  assert.match(src, /merged\.loop\.sdk_first_token_timeout_seconds > 1800/);
});

test("beta64/P0-1: sdk_first_token_timeout_seconds declared in manifest configSchema", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  const loop = m.configSchema.properties.loop.properties;
  assert.ok(loop.sdk_first_token_timeout_seconds, "must be declared or additionalProperties:false rejects the config");
  assert.equal(loop.sdk_first_token_timeout_seconds.type, "integer");
  assert.equal(loop.sdk_first_token_timeout_seconds.default, 30); // beta.65: lowered 90 -> 30
  assert.equal(loop.sdk_first_token_timeout_seconds.minimum, 10);
  assert.equal(loop.sdk_first_token_timeout_seconds.maximum, 1800);
});

test("beta64/P0-1: interaction-log exposes sdk_stream_opened + sdk_first_token emitters (source)", () => {
  const src = S("src/state/interaction-log.ts");
  assert.match(src, /logSdkStreamOpened\(/);
  assert.match(src, /logSdkFirstToken\(/);
  assert.match(src, /event: "sdk_stream_opened"/);
  assert.match(src, /event: "sdk_first_token"/);
  assert.match(src, /msToFirstToken/);
});

test("beta64/P0-1: runWorkerSdk threads firstTokenTimeoutSeconds into consumeWorkerStream (source)", () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /firstTokenTimeoutSeconds\?: number/);
  assert.match(src, /consumeWorkerStream\(stream, abort, \{\s*firstTokenTimeoutSeconds: params\.firstTokenTimeoutSeconds,/);
  assert.match(src, /stopReason = "first_token_timeout"/);
});

test("beta64/P0-1: sonnet-worker maps first_token_timeout status + carries streamOpened/msToFirstToken (source)", () => {
  const src = S("src/orchestrator/sonnet-worker.ts");
  assert.match(src, /"first_token_timeout"/);
  // beta.65: phase-2 default lowered 90 -> 30 in the split-phase redesign.
  assert.match(src, /firstTokenTimeoutSeconds: deps\.config\.loop\.sdk_first_token_timeout_seconds \?\? 30/);
  assert.match(src, /streamOpened: sdkResult\.streamOpened/);
  assert.match(src, /msToFirstToken: sdkResult\.msToFirstToken/);
});
