import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";

export const CONTROL_PLANE_CONTRACT_VERSION = "control-plane-contract/v1";
export const CONTROL_PLANE_SCHEMA_VERSION = 1;
export const CONFIRM_DOMAIN = "control-plane-confirm/v1";
export const MERGE_DOMAIN = "control-plane-merge/v1";

export type ChangeState = "prepared" | "accepted" | "running" | "pr_ready" | "failed" | "merged" | "merge_failed";
export type ControlOperation = "confirm_change" | "merge_change";

export interface TrustedControlContext {
  requesterSenderId?: string;
  conversationId?: string;
  workspaceId?: string;
  hostEventId?: string;
  receivedAt?: number;
  trustedControlAttestation?: Readonly<{
    version: 1;
    operation: ControlOperation;
    actorIdentity: string;
    conversationIdentity: string;
    hostEventId: string;
    nonce: string;
    issuedAt: number;
    expiresAt: number;
    bindingDigest: string;
  }>;
}

export interface PrepareChangeInput {
  request: string;
  repository: string;
  baseRef?: string;
  scope?: string[];
  excludedScope?: string[];
  budgetUsd?: number;
  timeLimitSeconds?: number;
}

export interface RepositoryResolution {
  repositoryIdentity: string;
  baseRef: string;
  baseRevision: string;
  credentialRoute: string;
  policyDigest: string;
  securityClass: "low" | "medium" | "high";
}

export interface EngineStartInput {
  changeId: string;
  /** Stable across controller restart; the engine insert must be idempotent on this value. */
  engineSessionId: string;
  brief: CrystallisedBrief;
  actorIdentity: string;
  conversationIdentity: string;
  repositoryIdentity: string;
  baseRef: string;
  baseRevision: string;
  budgetUsd: string;
  timeLimitSeconds: number;
  scope: readonly string[];
  excludedScope: readonly string[];
}

export interface ReadinessInput {
  changeId: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  verdict: "pass" | "revise" | "block";
  blocking: number;
  publishedSha: string;
  prHeadSha: string;
  requiredCiDigest: string;
  runtimeEvidenceDigest: string;
  spendUsd: number;
}

export interface MergeStartInput {
  changeId: string;
  actorIdentity: string;
  conversationIdentity: string;
  pullRequestNumber: number;
  prHeadSha: string;
  readinessDigest: string;
  mergeMethod: "squash" | "merge" | "rebase";
}

export interface ControlServiceDeps {
  db: DatabaseSync;
  crystallise: (request: string) => Promise<
    | { kind: "brief"; brief: CrystallisedBrief; costUsd?: number }
    | { kind: "clarify"; question: string; costUsd?: number }
    | { kind: "reject"; reason: string; costUsd?: number }
  >;
  resolveRepository?: (input: { repository: string; baseRef?: string; actorIdentity: string }) => Promise<RepositoryResolution>;
  startEngine: (input: EngineStartInput) => Promise<{ engineSessionId?: string } | void>;
  mergeChange: (input: MergeStartInput) => Promise<{ merged: boolean; mergeSha?: string; message?: string }>;
  now?: () => number;
  confirmationTtlMs?: number;
  maximumBudgetUsd?: number;
  maximumTimeSeconds?: number;
}

interface ChangeRow {
  change_id: string;
  state: ChangeState;
  generation: number;
  actor_identity: string;
  conversation_identity: string;
  repository_identity: string;
  base_ref: string;
  base_revision: string;
  brief_json: string;
  brief_digest: string;
  policy_digest: string;
  budget_usd: string;
  time_limit_seconds: number;
  scope_json: string;
  scope_digest: string;
  excluded_scope_json: string;
  credential_route: string;
  security_class: string;
  confirmable: number;
  assumptions_json: string;
  proposal_expires_at: number;
  published_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  readiness_digest: string | null;
  required_ci_digest: string | null;
  runtime_evidence_digest: string | null;
  terminal_code: string | null;
  terminal_summary: string | null;
  created_at: number;
  updated_at: number;
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item === undefined ? null : item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function controlDigest(domain: string, binding: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonical(binding)}`, "utf8").digest("hex");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function money(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new ControlError("invalid_budget", "The budget must be a positive amount.");
  return value.toFixed(2);
}

function cleanIdentity(value: string | undefined): string {
  return (value ?? "").trim();
}

function contextIdentity(context: TrustedControlContext): { actor: string; conversation: string } {
  const actor = cleanIdentity(context.requesterSenderId);
  const conversation = cleanIdentity(context.conversationId);
  if (!actor) throw new ControlError("trusted_actor_required", "An authenticated requester is required.");
  if (!conversation) throw new ControlError("trusted_conversation_required", "An authenticated conversation is required.");
  return { actor, conversation };
}

function parseList(text: string): string[] {
  try { return JSON.parse(text) as string[]; } catch { return []; }
}

export class ControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControlError";
  }
}

export class ControlPlaneService {
  private readonly now: () => number;
  private readonly confirmationTtlMs: number;

  constructor(private readonly deps: ControlServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.confirmationTtlMs = deps.confirmationTtlMs ?? 15 * 60_000;
    queueMicrotask(() => { void this.recoverExecutionIntents(); });
  }

  async prepare(input: PrepareChangeInput, context: TrustedControlContext): Promise<Record<string, unknown>> {
    const { actor, conversation } = contextIdentity(context);
    const request = input.request?.trim();
    const repository = input.repository?.trim().toLowerCase();
    if (!request || request.length > 100_000) throw new ControlError("invalid_request", "A bounded change request is required.");
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new ControlError("invalid_repository", "Repository must be owner/name.");

    const resolution = this.deps.resolveRepository
      ? await this.deps.resolveRepository({ repository, baseRef: input.baseRef, actorIdentity: actor })
      : {
          repositoryIdentity: repository,
          baseRef: input.baseRef?.trim() || "main",
          baseRevision: `unresolved:${digest({ repository, baseRef: input.baseRef?.trim() || "main" })}`,
          credentialRoute: "default",
          policyDigest: digest({ contract: CONTROL_PLANE_CONTRACT_VERSION }),
          securityClass: "medium" as const,
        };

    const crystallised = await this.deps.crystallise(request);
    if (crystallised.kind === "reject") throw new ControlError("request_rejected", crystallised.reason || "The request cannot be prepared.");

    const assumptions: string[] = [];
    let confirmable = true;
    let brief: CrystallisedBrief;
    if (crystallised.kind === "clarify") {
      confirmable = false;
      assumptions.push("The request has an unresolved product decision and must be prepared again with that decision stated explicitly.");
      brief = {
        title: "Unresolved change request",
        motivation: request.slice(0, 500),
        acceptanceCriteria: ["No implementation may start until the unresolved decision is supplied in a new request."],
        filesLikelyTouched: [],
        outOfScope: ["All implementation while this proposal is non-confirmable."],
        repoHint: resolution.repositoryIdentity,
        riskLevel: "medium",
      };
    } else {
      brief = structuredClone(crystallised.brief);
    }

    if (resolution.baseRevision.startsWith("unresolved:")) {
      confirmable = false;
      assumptions.push("The immutable repository base could not be verified by the host.");
    }

    const requestedScope = input.scope?.filter(Boolean) ?? brief.filesLikelyTouched.filter(Boolean);
    const scope = [...new Set(requestedScope.length ? requestedScope : ["**/*"])] ;
    const excludedScope = [...new Set(input.excludedScope?.filter(Boolean) ?? brief.outOfScope.filter(Boolean))];
    if ([...scope, ...excludedScope].some((path) => path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))) {
      throw new ControlError("path_violation", "Scope paths must be repository-relative.");
    }
    const maximumBudget = this.deps.maximumBudgetUsd ?? 50;
    const budgetUsd = money(Math.min(input.budgetUsd ?? Math.min(12, maximumBudget), maximumBudget));
    const maximumTime = this.deps.maximumTimeSeconds ?? 4 * 3600;
    const timeLimitSeconds = Math.min(input.timeLimitSeconds ?? 3600, maximumTime);
    if (!Number.isSafeInteger(timeLimitSeconds) || timeLimitSeconds <= 0) throw new ControlError("invalid_time_limit", "The time limit must be a positive number of seconds.");

    const changeId = `chg_${randomBytes(18).toString("base64url")}`;
    const now = this.now();
    const expiresAt = now + this.confirmationTtlMs;
    const briefDigest = digest(brief);
    const scopeDigest = digest({ scope, excludedScope });
    const generation = 1;
    this.deps.db.prepare(`INSERT INTO control_changes (
      change_id, state, generation, actor_identity, conversation_identity,
      repository_identity, base_ref, base_revision, brief_json, brief_digest,
      policy_digest, budget_usd, time_limit_seconds, scope_json, scope_digest,
      excluded_scope_json, credential_route, security_class, confirmable,
      assumptions_json, proposal_expires_at, created_at, updated_at
    ) VALUES (?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(changeId, generation, actor, conversation, resolution.repositoryIdentity, resolution.baseRef,
        resolution.baseRevision, JSON.stringify(brief), briefDigest, resolution.policyDigest, budgetUsd,
        timeLimitSeconds, JSON.stringify(scope), scopeDigest, JSON.stringify(excludedScope), resolution.credentialRoute,
        resolution.securityClass, confirmable ? 1 : 0, JSON.stringify(assumptions), expiresAt, now, now);

    const reviewDigest = `sha256:${this.confirmBindingDigest({
      change_id: changeId, state: "prepared", generation, actor_identity: actor,
      conversation_identity: conversation, repository_identity: resolution.repositoryIdentity,
      base_ref: resolution.baseRef, base_revision: resolution.baseRevision, brief_digest: briefDigest,
      policy_digest: resolution.policyDigest, budget_usd: budgetUsd, time_limit_seconds: timeLimitSeconds,
      scope_digest: scopeDigest, credential_route: resolution.credentialRoute, security_class: resolution.securityClass,
      proposal_expires_at: expiresAt,
    } as ChangeRow, { operation: "confirm_change", actorIdentity: actor, conversationIdentity: conversation,
      hostEventId: "review", nonce: "review", issuedAt: now, expiresAt, version: 1, bindingDigest: "" })}`;

    return {
      ok: true, changeId, state: "prepared", confirmable,
      summary: brief.title, repository: resolution.repositoryIdentity, baseRef: resolution.baseRef,
      scope, excludedScope, budget: { currency: "USD", maximum: budgetUsd }, timeLimitSeconds,
      risk: resolution.securityClass, assumptions,
      confirmation: { expiresAt: new Date(expiresAt).toISOString(), reviewDigest },
    };
  }

  async confirm(changeId: string, context: TrustedControlContext): Promise<Record<string, unknown>> {
    const { actor, conversation } = contextIdentity(context);
    const row = this.get(changeId);
    if (!row) throw new ControlError("change_not_found", "The prepared change was not found.");
    const attestation = this.resolveHostAttestation("confirm_change", row, context);
    if (row.state !== "prepared") {
      if (["accepted", "running", "pr_ready", "merged"].includes(row.state)) throw new ControlError("already_confirmed", "This change was already confirmed.");
      throw new ControlError("stale_confirmation", "This proposal can no longer be confirmed.");
    }
    if (!row.confirmable) throw new ControlError("proposal_not_confirmable", "Prepare a new change with all required decisions stated.");
    if (actor !== row.actor_identity || attestation.actorIdentity !== row.actor_identity) throw new ControlError("wrong_actor", "The confirmation must come from the preparing requester.");
    if (conversation !== row.conversation_identity || attestation.conversationIdentity !== row.conversation_identity) throw new ControlError("wrong_conversation", "The confirmation must come from the preparing conversation.");
    const now = this.now();
    if (attestation.issuedAt <= row.created_at || now > row.proposal_expires_at || now > attestation.expiresAt || attestation.issuedAt > now) throw new ControlError("stale_confirmation", "The confirmation expired.");
    const expected = this.confirmBindingDigest(row, attestation);
    if (attestation.bindingDigest !== expected) throw new ControlError("stale_confirmation", "The proposal changed after review.");

    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      this.consumeAttestation(changeId, attestation, expected, now);
      const updated = this.deps.db.prepare(`UPDATE control_changes SET state='accepted', generation=generation+1, updated_at=?
        WHERE change_id=? AND state='prepared' AND generation=?`).run(now, changeId, row.generation);
      if (Number(updated.changes) !== 1) throw new ControlError("stale_confirmation", "The proposal changed after review.");
      this.deps.db.prepare(`INSERT INTO control_execution_intents (change_id, generation, created_at) VALUES (?, ?, ?)`)
        .run(changeId, row.generation + 1, now);
      this.deps.db.exec("COMMIT");
    } catch (error) {
      try { this.deps.db.exec("ROLLBACK"); } catch { /* preserve original */ }
      if (/UNIQUE constraint failed: control_attestations/i.test(String(error))) throw new ControlError("confirmation_replayed", "This confirmation was already used.");
      if (/UNIQUE constraint failed: control_execution_intents/i.test(String(error))) throw new ControlError("already_confirmed", "This change was already confirmed.");
      throw error;
    }

    const brief = JSON.parse(row.brief_json) as CrystallisedBrief;
    const engineInput: EngineStartInput = {
      changeId, engineSessionId: this.engineSessionId(changeId), brief,
      actorIdentity: row.actor_identity, conversationIdentity: row.conversation_identity,
      repositoryIdentity: row.repository_identity, baseRef: row.base_ref, baseRevision: row.base_revision,
      budgetUsd: row.budget_usd, timeLimitSeconds: row.time_limit_seconds,
      scope: parseList(row.scope_json), excludedScope: parseList(row.excluded_scope_json),
    };
    void this.dispatchExactlyOnce(engineInput);
    return { ok: true, changeId, state: "accepted", summary: "Change accepted and started." };
  }

  recordReadiness(input: ReadinessInput): void {
    const row = this.get(input.changeId);
    if (!row || row.state !== "running") throw new ControlError("stale_execution", "The change is not running.");
    const sha = /^[a-f0-9]{40,64}$/i;
    const evidence = /^[a-f0-9]{64}$/i;
    const spendWithinEnvelope = Number.isFinite(input.spendUsd) && input.spendUsd <= Number(row.budget_usd);
    if (input.verdict !== "pass" || input.blocking !== 0 || input.publishedSha !== input.prHeadSha ||
        !sha.test(input.publishedSha) || !evidence.test(input.requiredCiDigest) ||
        !evidence.test(input.runtimeEvidenceDigest) || !spendWithinEnvelope) {
      throw new ControlError("readiness_not_proven", "The pull request did not satisfy every readiness requirement.");
    }
    const readinessDigest = digest({
      changeId: input.changeId, verdict: input.verdict, blocking: input.blocking,
      publishedSha: input.publishedSha, prHeadSha: input.prHeadSha,
      requiredCiDigest: input.requiredCiDigest, runtimeEvidenceDigest: input.runtimeEvidenceDigest,
      spendUsd: input.spendUsd.toFixed(2), budgetUsd: row.budget_usd, policyDigest: row.policy_digest,
    });
    const updated = this.deps.db.prepare(`UPDATE control_changes SET state='pr_ready', pr_number=?, pr_url=?,
      published_sha=?, pr_head_sha=?, readiness_digest=?, required_ci_digest=?, runtime_evidence_digest=?,
      spend_usd=?, updated_at=? WHERE change_id=? AND state='running' AND generation=?`)
      .run(input.pullRequestNumber, input.pullRequestUrl, input.publishedSha, input.prHeadSha, readinessDigest,
        input.requiredCiDigest, input.runtimeEvidenceDigest, input.spendUsd.toFixed(2), this.now(), input.changeId, row.generation);
    if (Number(updated.changes) !== 1) throw new ControlError("stale_execution", "The execution state changed.");
  }

  recordTerminalFailure(changeId: string, code: "budget_exceeded" | "time_exceeded" | "scope_escalation" | "path_violation" | "security_escalation" | "credential_escalation" | "verification_failed" | "execution_failed", summary: string): void {
    this.deps.db.prepare(`UPDATE control_changes SET state='failed', terminal_code=?, terminal_summary=?, updated_at=?
      WHERE change_id=? AND state IN ('accepted','running')`).run(code, summary.slice(0, 500), this.now(), changeId);
  }

  result(changeId: string, context: TrustedControlContext): Record<string, unknown> {
    const { actor, conversation } = contextIdentity(context);
    const row = this.get(changeId);
    if (!row || row.actor_identity !== actor || row.conversation_identity !== conversation) throw new ControlError("change_not_found", "The change was not found.");
    const result: Record<string, unknown> = {
      ok: true, changeId, state: row.state,
      summary: row.terminal_summary ?? this.summaryFor(row.state),
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    };
    if (row.state === "pr_ready" && row.pr_url) result.pullRequest = { url: row.pr_url };
    if (["failed", "merge_failed"].includes(row.state)) result.code = row.terminal_code ?? "execution_failed";
    return result;
  }

  async merge(changeId: string, context: TrustedControlContext): Promise<Record<string, unknown>> {
    const { actor, conversation } = contextIdentity(context);
    const row = this.get(changeId);
    if (!row) throw new ControlError("change_not_found", "The change was not found.");
    const attestation = this.resolveHostAttestation("merge_change", row, context);
    if (row.state === "merged") throw new ControlError("already_merged", "This change was already merged.");
    if (row.state !== "pr_ready" || !row.pr_number || !row.pr_head_sha || !row.readiness_digest) throw new ControlError("not_pr_ready", "This change is not ready to merge.");
    if (actor !== row.actor_identity || attestation.actorIdentity !== actor) throw new ControlError("wrong_actor", "The merge must be confirmed by the preparing requester.");
    if (conversation !== row.conversation_identity || attestation.conversationIdentity !== conversation) throw new ControlError("wrong_conversation", "The merge must be confirmed in the preparing conversation.");
    const now = this.now();
    if (attestation.issuedAt <= row.updated_at || now > attestation.expiresAt || attestation.issuedAt > now) throw new ControlError("stale_pr_head", "The merge confirmation expired.");
    const expected = this.mergeBindingDigest(row, attestation);
    if (attestation.bindingDigest !== expected) throw new ControlError("stale_pr_head", "The pull request changed after review.");

    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      this.consumeAttestation(changeId, attestation, expected, now);
      this.deps.db.prepare(`INSERT INTO control_merge_intents (change_id, pr_head_sha, readiness_digest, provider_idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(changeId, row.pr_head_sha, row.readiness_digest, `merge:${changeId}:${row.pr_head_sha}`, now);
      this.deps.db.exec("COMMIT");
    } catch (error) {
      try { this.deps.db.exec("ROLLBACK"); } catch { /* preserve original */ }
      if (/UNIQUE constraint failed: control_merge_intents/i.test(String(error))) throw new ControlError("already_merged", "A merge is already in progress or complete.");
      throw error;
    }

    const outcome = await this.deps.mergeChange({ changeId, actorIdentity: actor, conversationIdentity: conversation,
      pullRequestNumber: row.pr_number, prHeadSha: row.pr_head_sha, readinessDigest: row.readiness_digest, mergeMethod: "squash" });
    const state: ChangeState = outcome.merged ? "merged" : "merge_failed";
    this.deps.db.prepare(`UPDATE control_changes SET state=?, terminal_code=?, terminal_summary=?, updated_at=?
      WHERE change_id=? AND state='pr_ready'`).run(state, outcome.merged ? null : "merge_failed", outcome.message ?? null, this.now(), changeId);
    return { ok: outcome.merged, changeId, state, summary: outcome.message ?? (outcome.merged ? "Pull request merged." : "The merge did not complete."), ...(outcome.mergeSha ? { mergeSha: outcome.mergeSha } : {}) };
  }

  private async recoverExecutionIntents(): Promise<void> {
    let rows: ChangeRow[] = [];
    try {
      rows = this.deps.db.prepare(`SELECT c.* FROM control_changes c
        JOIN control_execution_intents i ON i.change_id=c.change_id
        WHERE c.state='accepted' AND i.dispatched_at IS NULL AND (i.lease_owner IS NULL OR i.lease_expires_at < ?)`)
        .all(this.now()) as unknown as ChangeRow[];
    } catch {
      return;
    }
    for (const row of rows) {
      await this.dispatchExactlyOnce({
        changeId: row.change_id, engineSessionId: this.engineSessionId(row.change_id),
        brief: JSON.parse(row.brief_json) as CrystallisedBrief,
        actorIdentity: row.actor_identity, conversationIdentity: row.conversation_identity,
        repositoryIdentity: row.repository_identity, baseRef: row.base_ref, baseRevision: row.base_revision,
        budgetUsd: row.budget_usd, timeLimitSeconds: row.time_limit_seconds,
        scope: parseList(row.scope_json), excludedScope: parseList(row.excluded_scope_json),
      });
    }
  }

  private engineSessionId(changeId: string): string {
    return `control-${digest({ changeId }).slice(0, 32)}`;
  }

  private async dispatchExactlyOnce(input: EngineStartInput): Promise<void> {
    const now = this.now();
    const claimed = this.deps.db.prepare(`UPDATE control_execution_intents SET lease_owner=?, lease_expires_at=?, lease_generation=lease_generation+1
      WHERE change_id=? AND dispatched_at IS NULL AND (lease_owner IS NULL OR lease_expires_at < ?)`)
      .run(`controller:${randomUUID()}`, now + 60_000, input.changeId, now);
    if (Number(claimed.changes) !== 1) return;
    try {
      const started = await this.deps.startEngine(input);
      this.deps.db.exec("BEGIN IMMEDIATE");
      this.deps.db.prepare(`UPDATE control_execution_intents SET dispatched_at=?, engine_session_id=?, lease_owner=NULL WHERE change_id=? AND dispatched_at IS NULL`)
        .run(this.now(), started?.engineSessionId ?? null, input.changeId);
      this.deps.db.prepare(`UPDATE control_changes SET state='running', updated_at=? WHERE change_id=? AND state='accepted'`)
        .run(this.now(), input.changeId);
      this.deps.db.exec("COMMIT");
    } catch (error) {
      try { this.deps.db.exec("ROLLBACK"); } catch { /* preserve original */ }
      this.deps.db.prepare(`UPDATE control_changes SET state='failed', terminal_code='execution_failed', terminal_summary='The change could not be started.', updated_at=? WHERE change_id=? AND state IN ('accepted','running')`)
        .run(this.now(), input.changeId);
    }
  }

  private resolveHostAttestation(operation: ControlOperation, row: ChangeRow, context: TrustedControlContext): NonNullable<TrustedControlContext["trustedControlAttestation"]> {
    const supplied = context.trustedControlAttestation;
    if (supplied) {
      if (supplied.operation !== operation) {
        throw new ControlError(operation === "merge_change" ? "merge_attestation_required" : "confirmation_attestation_required", "A fresh trusted decision is required.");
      }
      return supplied;
    }
    const hostEventId = cleanIdentity(context.hostEventId);
    const receivedAt = context.receivedAt;
    if (!hostEventId || !Number.isSafeInteger(receivedAt) || receivedAt! <= row.created_at) {
      throw new ControlError(operation === "merge_change" ? "merge_attestation_required" : "confirmation_attestation_required", "A fresh trusted decision is required.");
    }
    const nonce = digest({ operation, hostEventId, actor: row.actor_identity, conversation: row.conversation_identity });
    const shell = {
      version: 1 as const, operation, actorIdentity: row.actor_identity, conversationIdentity: row.conversation_identity,
      hostEventId, nonce, issuedAt: receivedAt!, expiresAt: receivedAt! + 5 * 60_000, bindingDigest: "",
    };
    return Object.freeze({
      ...shell,
      bindingDigest: operation === "confirm_change" ? this.confirmBindingDigest(row, shell) : this.mergeBindingDigest(row, shell),
    });
  }

  private consumeAttestation(changeId: string, attestation: NonNullable<TrustedControlContext["trustedControlAttestation"]>, bindingDigest: string, now: number): void {
    this.deps.db.prepare(`INSERT INTO control_attestations
      (change_id, operation_kind, host_event_id, nonce, binding_digest, actor_identity, conversation_identity, issued_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(changeId, attestation.operation, attestation.hostEventId, attestation.nonce, bindingDigest,
        attestation.actorIdentity, attestation.conversationIdentity, attestation.issuedAt, attestation.expiresAt, now);
  }

  private confirmBindingDigest(row: ChangeRow, attestation: NonNullable<TrustedControlContext["trustedControlAttestation"]>): string {
    return controlDigest(CONFIRM_DOMAIN, {
      operation_kind: "confirm_change", actor_identity: row.actor_identity, conversation_identity: row.conversation_identity,
      change_id: row.change_id, repository_identity: row.repository_identity, base_ref: row.base_ref,
      base_revision: row.base_revision, brief_digest: row.brief_digest, policy_digest: row.policy_digest,
      budget_usd: row.budget_usd, time_limit_seconds: row.time_limit_seconds, scope_digest: row.scope_digest,
      credential_route: row.credential_route, security_class: row.security_class, generation: row.generation,
      proposal_expires_at: row.proposal_expires_at, host_event_id: attestation.hostEventId, nonce: attestation.nonce,
      issued_at: attestation.issuedAt, expires_at: attestation.expiresAt,
    });
  }

  private mergeBindingDigest(row: ChangeRow, attestation: NonNullable<TrustedControlContext["trustedControlAttestation"]>): string {
    return controlDigest(MERGE_DOMAIN, {
      operation_kind: "merge_change", actor_identity: row.actor_identity, conversation_identity: row.conversation_identity,
      change_id: row.change_id, repository_identity: row.repository_identity, pr_number: row.pr_number,
      merge_method: "squash", pr_head_sha: row.pr_head_sha, published_sha: row.published_sha,
      readiness_digest: row.readiness_digest, policy_digest: row.policy_digest,
      required_ci_digest: row.required_ci_digest, runtime_evidence_digest: row.runtime_evidence_digest,
      host_event_id: attestation.hostEventId, nonce: attestation.nonce, issued_at: attestation.issuedAt, expires_at: attestation.expiresAt,
    });
  }

  private get(changeId: string): ChangeRow | null {
    if (!/^chg_[A-Za-z0-9_-]{12,}$/.test(changeId ?? "")) return null;
    return (this.deps.db.prepare("SELECT * FROM control_changes WHERE change_id = ?").get(changeId) as unknown as ChangeRow | undefined) ?? null;
  }

  private summaryFor(state: ChangeState): string {
    if (state === "prepared") return "Ready for confirmation.";
    if (state === "accepted") return "Change accepted and queued.";
    if (state === "running") return "The change is in progress.";
    if (state === "pr_ready") return "The pull request is ready.";
    if (state === "merged") return "The pull request was merged.";
    if (state === "merge_failed") return "The merge did not complete.";
    return "The change did not complete.";
  }
}
