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
  readonly checks: Readonly<{ passed: number; total: number }>;
  readonly message: string;
}

export const TERMINAL_REPORT_CODES = [
  "completed",
  "cancelled_by_requester",
  "authority_expired",
  "authority_violation",
  "verification_failed",
  "execution_failed",
] as const;

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

export function buildReadinessReport(input: ReadinessReportInput): ReadinessReport {
  if (input.run.state !== "pr_ready" && input.run.state !== "awaiting_merge") throw new Error("Readiness reports require a ready control state");
  const checks = Object.freeze({ passed: input.checksPassed, total: input.checksTotal });
  if (!Number.isSafeInteger(checks.passed) || !Number.isSafeInteger(checks.total) || checks.passed < 0 || checks.total < checks.passed) throw new Error("Invalid readiness check counts");
  return Object.freeze({
    kind: "readiness",
    runId: input.run.id,
    state: input.run.state,
    ...(input.run.pullRequestUrl ? { pullRequestUrl: input.run.pullRequestUrl } : {}),
    checks,
    message: checks.passed === checks.total ? "The pull request is ready for review." : "The pull request is waiting for required checks.",
  });
}

export function buildTerminalReport(input: TerminalReportInput): TerminalReport {
  if (!TERMINAL_REPORT_CODES.includes(input.code)) throw new Error("Unsupported terminal report code");
  const message = input.state === "done" ? "The run completed successfully." : input.state === "cancelled" ? "The run was cancelled." : "The run ended without completing.";
  return Object.freeze({
    kind: "terminal",
    runId: input.runId,
    state: input.state,
    code: input.code,
    ...(input.pullRequestUrl ? { pullRequestUrl: input.pullRequestUrl } : {}),
    message,
  });
}
