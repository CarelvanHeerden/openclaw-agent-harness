export function memoiseSuccess(work) {
    let inFlight;
    let done = false;
    const run = () => {
        if (!inFlight) {
            const attempt = work().then((value) => {
                done = true;
                return value;
            }, (err) => {
                // The identity check is load-bearing under concurrency. If a later
                // caller has already started a fresh attempt, this stale rejection
                // must not clear THAT attempt's memo -- doing so would let a third
                // caller spawn a redundant run alongside one already in flight.
                if (inFlight === attempt)
                    inFlight = undefined;
                throw err;
            });
            inFlight = attempt;
        }
        return inFlight;
    };
    run.reset = () => {
        inFlight = undefined;
        done = false;
    };
    Object.defineProperty(run, "settled", { get: () => done });
    return run;
}
//# sourceMappingURL=once.js.map