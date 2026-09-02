import type { AcpToolCallForGuard } from "./bash-guard.js";
export type AcpGuardDecision = {
    allow: boolean;
    reason?: string;
    unenforced?: boolean;
};
export type AcpGuard = (call: AcpToolCallForGuard) => Promise<AcpGuardDecision>;
/**
 * Adds worker-specific policy to the generic ACP guard.
 *
 * The generic guard must fail closed on unknown tool kinds. OpenCode's
 * in-session checklist is one known, side-effect-free `other` tool, while its
 * nested `task` agent is known to turn a bounded worker into an unbounded one.
 */
export declare function focusedWorkerAcpGuard(base: AcpGuard): AcpGuard;
//# sourceMappingURL=focused-worker-acp-guard.d.ts.map