/**
 * Run an expensive async setup step once, and remember only that it WORKED.
 *
 * The obvious spelling of "do this once" is a memoised promise:
 *
 *     probe ??= doTheThing();
 *     await probe;
 *
 * and it is wrong in a way that does not show up until something goes
 * transiently wrong in production. A promise memo caches the SETTLED VALUE,
 * and a rejection is a settled value. So the first failure is cached forever:
 * every later caller awaits the same dead promise and receives the same stale
 * error, long after the condition that caused it has cleared. The subsystem
 * stays down until the process restarts, which on most hosts means a human.
 *
 * That is the wrong shape for a startup check whose failures are usually
 * transient -- a container under load, a spawn that timed out, a binary
 * momentarily unavailable mid-deploy. Failing closed is correct. Failing
 * closed with no route back is not, and the difference is invisible in tests
 * that only ever exercise the happy path once.
 *
 * So: success is memoised permanently, failure is not memoised at all, and
 * concurrent callers share whatever attempt is currently in flight rather than
 * each starting their own.
 */
export interface RunOnce<T> {
  (): Promise<T>;
  /** Discard a memoised success, so the next call runs the work again. */
  reset: () => void;
  /** True once an attempt has succeeded. Diagnostics and tests. */
  readonly settled: boolean;
}

export function memoiseSuccess<T>(work: () => Promise<T>): RunOnce<T> {
  let inFlight: Promise<T> | undefined;
  let done = false;

  const run = (): Promise<T> => {
    if (!inFlight) {
      const attempt: Promise<T> = work().then(
        (value) => {
          done = true;
          return value;
        },
        (err: unknown) => {
          // The identity check is load-bearing under concurrency. If a later
          // caller has already started a fresh attempt, this stale rejection
          // must not clear THAT attempt's memo -- doing so would let a third
          // caller spawn a redundant run alongside one already in flight.
          if (inFlight === attempt) inFlight = undefined;
          throw err;
        },
      );
      inFlight = attempt;
    }
    return inFlight;
  };

  run.reset = () => {
    inFlight = undefined;
    done = false;
  };
  Object.defineProperty(run, "settled", { get: () => done });

  return run as RunOnce<T>;
}
