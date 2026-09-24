import type { ControlState, TerminalControlState } from "./types.js";
export declare class InvalidControlTransitionError extends Error {
    readonly from: ControlState;
    readonly to: ControlState;
    constructor(from: ControlState, to: ControlState);
}
export declare class ControlCasConflictError extends Error {
    readonly runId: string;
    readonly expectedVersion: number;
    constructor(runId: string, expectedVersion: number);
}
export declare function isTerminalControlState(state: ControlState): state is TerminalControlState;
export declare function canTransitionControlState(from: ControlState, to: ControlState): boolean;
export declare function assertControlTransition(from: ControlState, to: ControlState): void;
export declare function allowedControlTransitions(from: ControlState): readonly ControlState[];
//# sourceMappingURL=state-machine.d.ts.map