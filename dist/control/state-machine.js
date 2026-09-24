const states = (...values) => Object.freeze(values);
const TRANSITIONS = Object.freeze({
    draft: states("awaiting_confirmation", "cancelled"),
    awaiting_confirmation: states("autonomous_run", "failed", "cancelled"),
    autonomous_run: states("pr_ready", "failed", "cancelled"),
    pr_ready: states("autonomous_run", "awaiting_merge", "failed", "cancelled"),
    awaiting_merge: states("done", "failed", "cancelled"),
    done: states(),
    failed: states(),
    cancelled: states(),
});
export class InvalidControlTransitionError extends Error {
    from;
    to;
    constructor(from, to) {
        super(`Invalid control transition: ${from} -> ${to}`);
        this.from = from;
        this.to = to;
        this.name = "InvalidControlTransitionError";
    }
}
export class ControlCasConflictError extends Error {
    runId;
    expectedVersion;
    constructor(runId, expectedVersion) {
        super(`Control run ${runId} was not at expected version ${expectedVersion}`);
        this.runId = runId;
        this.expectedVersion = expectedVersion;
        this.name = "ControlCasConflictError";
    }
}
export function isTerminalControlState(state) {
    return state === "done" || state === "failed" || state === "cancelled";
}
export function canTransitionControlState(from, to) {
    return TRANSITIONS[from].includes(to);
}
export function assertControlTransition(from, to) {
    if (!canTransitionControlState(from, to))
        throw new InvalidControlTransitionError(from, to);
}
export function allowedControlTransitions(from) {
    return TRANSITIONS[from];
}
//# sourceMappingURL=state-machine.js.map