/**
 * Backend-agnostic stream-liveness arithmetic.
 *
 * v2.0.0: moved out of the Claude SDK adapter unchanged. "Has this stream gone
 * quiet for too long" is the same question over the SDK and over ACP, and the
 * answer is pure arithmetic over a marker and two timestamps -- so it belongs
 * to neither backend.
 */

/**
 * beta.90 (Feature 2): PURE tick-decision helper for the worker stream-slow
 * detector. Extracted so the idle logic is unit-testable without a real SDK or
 * timers. Given the current activity `marker` (max of tokensOut + message
 * count), the `lastMarker`/`lastActivityAtMs` from the previous advance, `nowMs`,
 * and the `idleWarnMs` threshold, returns whether activity advanced (reset the
 * idle clock), the current idle duration, and whether onStreamSlow should fire.
 *
 * `idleWarnMs <= 0` disables (never fires). `fire` is true only when the stream
 * did NOT advance AND has been idle for >= idleWarnMs.
 */
export function evaluateStreamSlowTick(input: {
  marker: number;
  lastMarker: number;
  nowMs: number;
  lastActivityAtMs: number;
  idleWarnMs: number;
}): { advanced: boolean; idleMs: number; fire: boolean; nowMs: number } {
  const advanced = input.marker > input.lastMarker;
  const idleMs = advanced ? 0 : input.nowMs - input.lastActivityAtMs;
  const fire = !advanced && input.idleWarnMs > 0 && idleMs >= input.idleWarnMs;
  return { advanced, idleMs, fire, nowMs: input.nowMs };
}
