// rc.4 — keeping the event loop alive across a watchdog wait.
//
// `consumeWorkerStream` deliberately `unref()`s its stream-open and first-token
// timers: in production a pending watchdog must never be the reason the process
// refuses to exit. The real SDK stream holds a ref'd socket for that same span,
// so the loop stays alive on the socket's account and the unref is free.
//
// A fake async-iterable has no socket. So a test whose fake stalls until the
// watchdog aborts it leaves an unref'd timer as the ONLY pending work, the loop
// drains immediately, and `node:test` cancels the awaiting subtest -- and every
// later subtest in the file, including the synchronous source assertions that
// never needed the loop at all. They are reported `cancelledByParent`, which is
// not a failure, so the run stays green while asserting nothing.
//
// That is exactly what hid on Node 22.x: 22 subtests across the two first-token
// files, the suite that exists because of the beta.63 hung-stream incident,
// silently asserting nothing on the advertised `engines` floor.
//
// The fix belongs in the fake rather than the product: hold a ref'd handle for
// the duration of the wait, which is what the socket was doing.
export function keepEventLoopAlive() {
  const handle = setInterval(() => {}, 1_000);
  return () => clearInterval(handle);
}

/**
 * Resolve when `abort` fires, holding the event loop open until it does.
 * Use in place of a bare `new Promise(r => signal.addEventListener("abort", r))`
 * inside a fake stream.
 */
export function waitForAbort(abort) {
  const release = keepEventLoopAlive();
  return new Promise((resolve) => {
    if (abort.signal.aborted) return resolve();
    abort.signal.addEventListener("abort", () => resolve(), { once: true });
  }).finally(release);
}
