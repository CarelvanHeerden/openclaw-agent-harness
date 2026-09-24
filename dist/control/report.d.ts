import type { ControlRun, TerminalControlState } from "./types.js";
export interface ReadinessReportInput {
    readonly run: ControlRun;
    readonly checksPassed: number;
    readonly checksTotal: number;
}
export interface ReadinessReport {
    readonly kind: "readiness";
    readonly runId: string;
    readonly state: "pr_ready" | "awaiting_merge";
    readonly pullRequestUrl?: string;
    readonly checks: Readonly<{
        passed: number;
        total: number;
    }>;
    readonly message: string;
}
export declare const TERMINAL_REPORT_CODES: readonly ["completed", "cancelled_by_requester", "authority_expired", "authority_violation", "verification_failed", "execution_failed"];
export type TerminalReportCode = (typeof TERMINAL_REPORT_CODES)[number];
export interface TerminalReportInput {
    readonly runId: string;
    readonly state: TerminalControlState;
    readonly code: TerminalReportCode;
    readonly pullRequestUrl?: string;
}
export interface TerminalReport {
    readonly kind: "terminal";
    readonly runId: string;
    readonly state: TerminalControlState;
    readonly code: TerminalReportCode;
    readonly pullRequestUrl?: string;
    readonly message: string;
}
export declare function buildReadinessReport(input: ReadinessReportInput): ReadinessReport;
export declare function buildTerminalReport(input: TerminalReportInput): TerminalReport;
//# sourceMappingURL=report.d.ts.map