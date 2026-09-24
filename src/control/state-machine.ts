import type { ControlState, TerminalControlState } from "./types.js";

const states = (...values: ControlState[]): readonly ControlState[] => Object.freeze(values);

const TRANSITIONS: Readonly<Record<ControlState, readonly ControlState[]>> = Object.freeze({
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
  constructor(readonly from: ControlState, readonly to: ControlState) {
    super(`Invalid control transition: ${from} -> ${to}`);
    this.name = "InvalidControlTransitionError";
  }
}

export class ControlCasConflictError extends Error {
  constructor(readonly runId: string, readonly expectedVersion: number) {
    super(`Control run ${runId} was not at expected version ${expectedVersion}`);
    this.name = "ControlCasConflictError";
  }
}

export function isTerminalControlState(state: ControlState): state is TerminalControlState {
  return state === "done" || state === "failed" || state === "cancelled";
}

export function canTransitionControlState(from: ControlState, to: ControlState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertControlTransition(from: ControlState, to: ControlState): void {
  if (!canTransitionControlState(from, to)) throw new InvalidControlTransitionError(from, to);
}

export function allowedControlTransitions(from: ControlState): readonly ControlState[] {
  return TRANSITIONS[from];
}
