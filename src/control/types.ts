export const CONTROL_STATES = [
  "draft",
  "awaiting_confirmation",
  "autonomous_run",
  "pr_ready",
  "awaiting_merge",
  "done",
  "failed",
  "cancelled",
] as const;

export type ControlState = (typeof CONTROL_STATES)[number];
export type TerminalControlState = Extract<ControlState, "done" | "failed" | "cancelled">;

export const SAFE_AUTHORITY_ACTIONS = [
  "implement",
  "retry",
  "repair",
  "test",
  "commit",
  "push_feature_branch",
  "open_pull_request",
  "update_pull_request",
  "deploy",
] as const;

export type AuthorityAction = (typeof SAFE_AUTHORITY_ACTIONS)[number];

export interface AuthorityEnvelope {
  readonly version: 1;
  readonly requesterId: string;
  readonly conversationId: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly briefDigest: string;
  readonly policyDigest: string;
  readonly scope: Readonly<{
    paths: readonly string[];
  }>;
  readonly allowedActions: readonly AuthorityAction[];
  readonly limits: Readonly<{
    budgetUsd: number;
    activeTimeMs: number;
    cycles: number;
    retries: number;
  }>;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

export interface ControlRun {
  readonly id: string;
  readonly state: ControlState;
  readonly version: number;
  readonly requesterId: string;
  readonly conversationId: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly briefDigest: string;
  readonly policyDigest: string;
  readonly authorityEnvelope: AuthorityEnvelope;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalCode?: string;
  readonly pullRequestUrl?: string;
}

export interface ControlStateEvent {
  readonly id: number;
  readonly runId: string;
  readonly fromState: ControlState | null;
  readonly toState: ControlState;
  readonly fromVersion: number | null;
  readonly toVersion: number;
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: number;
}

export type AuthorityTerminationReason =
  | "replay"
  | "expired"
  | "identity_mismatch"
  | "conversation_mismatch"
  | "repository_mismatch"
  | "base_ref_mismatch"
  | "brief_digest_mismatch"
  | "policy_digest_mismatch"
  | "action_not_allowed"
  | "path_out_of_scope"
  | "budget_expansion"
  | "time_expansion"
  | "cycle_expansion"
  | "retry_expansion"
  | "security_expansion"
  | "credential_change"
  | "irreversible_side_effect"
  | "undeclared_deployment"
  | "default_branch_push";

export type AuthorityDecision = Readonly<
  | { outcome: "approve"; reason: "in_envelope" }
  | { outcome: "terminate"; reason: AuthorityTerminationReason }
>;

export interface AuthorityRequest {
  readonly requesterId: string;
  readonly conversationId: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly briefDigest: string;
  readonly policyDigest: string;
  readonly nonce: string;
  readonly action: AuthorityAction | string;
  readonly paths?: readonly string[];
  readonly targetRef?: string;
  readonly projectedBudgetUsd: number;
  readonly projectedActiveTimeMs: number;
  readonly projectedCycles: number;
  readonly projectedRetries: number;
  readonly securityBypass?: boolean;
  readonly credentialChange?: boolean;
  readonly irreversibleSideEffect?: boolean;
  readonly deploymentDeclared?: boolean;
  readonly now: number;
}
