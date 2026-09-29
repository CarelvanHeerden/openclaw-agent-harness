import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HarnessPluginApi, HarnessToolContext } from "../index.js";
import { ControlError, type ControlOperation, type ControlPlaneService, type TrustedControlContext } from "./service.js";

export const CONTROL_INTERACTIVE_NAMESPACE = "openclaw-agent-harness.control";

type PresentationBinding = Readonly<{
  actorIdentity: string;
  authorityConversation: string;
  channel: string;
  accountId: string;
  transportConversation: string;
  threadId: string;
}>;

type SlackInteractiveContext = {
  channel: "slack";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  threadId?: string;
  auth: { isAuthorizedSender: boolean };
  interaction: {
    kind: "button" | "select" | "view_submission" | "view_closed";
    payload: string;
  };
  respond: {
    acknowledge: () => Promise<unknown>;
    reply: (input: { text: string; responseType?: "ephemeral" | "in_channel" }) => Promise<unknown>;
    editMessage: (input: { text?: string; blocks?: unknown[] }) => Promise<unknown>;
  };
};

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeConversation(value: string | undefined): string {
  let normalized = (value ?? "").trim();
  while (/^team:[^:]+:/i.test(normalized)) normalized = normalized.replace(/^team:[^:]+:/i, "");
  return normalized;
}

function bindingFromContext(context: HarnessToolContext, actorIdentity: string, authorityConversation: string): PresentationBinding | undefined {
  const channel = (context.messageChannel || context.deliveryContext?.channel || "").trim().toLowerCase();
  const transportConversation = (context.nativeChannelId || context.deliveryContext?.to || context.conversationId || "").trim();
  if (channel !== "slack" || !actorIdentity || !authorityConversation || !transportConversation) return undefined;
  return Object.freeze({
    actorIdentity,
    authorityConversation,
    channel,
    accountId: (context.agentAccountId || context.deliveryContext?.accountId || "default").trim().toLowerCase(),
    transportConversation,
    threadId: String(context.deliveryContext?.threadId ?? "").trim(),
  });
}

function reviewMessage(operation: ControlOperation, review: Record<string, unknown>): { text: string; blocks: unknown[] } | undefined {
  const title = operation === "merge_change"
    ? `Pull request for change ${String(review.changeId)} passed strict readiness.`
    : `Prepared change ${String(review.changeId)} — complete proposal`;
  const instruction = operation === "merge_change"
    ? "Review the PR identity and exact head below, then approve this merge."
    : "Review every interpreted field below. Ask OpenClaw for changes instead of approving if anything is wrong.";
  const serialized = JSON.stringify(review, null, 2);
  const chunks: string[] = [];
  for (let offset = 0; offset < serialized.length; offset += 2_800) chunks.push(serialized.slice(offset, offset + 2_800));
  if (chunks.length > 40) return undefined;
  return {
    text: `${title}\n${instruction}`,
    blocks: [
      { type: "text", text: `${title}\n${instruction}` },
      ...chunks.map((chunk, index) => ({
        type: "text",
        text: `Proposal ${index + 1}/${chunks.length}\n${chunk}`,
      })),
    ],
  };
}

export class InteractiveControlApprovals {
  private readonly enabled: boolean;
  private mergeTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly service: ControlPlaneService,
    private readonly api: HarnessPluginApi,
    private readonly authorisedUsers: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    this.enabled = typeof api.sendMessage === "function" && typeof api.registerInteractiveHandler === "function";
  }

  register(): () => void {
    if (!this.enabled) {
      this.api.logger.warn("[harness] Slack interactive approval API unavailable; execution and merge approvals remain fail-closed.");
      return () => {};
    }
    const registration = this.api.registerInteractiveHandler!({
      channel: "slack",
      namespace: CONTROL_INTERACTIVE_NAMESPACE,
      handler: (context: unknown) => this.handle(context as SlackInteractiveContext),
    });
    queueMicrotask(() => { void this.presentPendingApprovals(); });
    this.mergeTimer = setInterval(() => { void this.presentPendingApprovals(); }, 5_000);
    this.mergeTimer.unref?.();
    const disposeRegistration = typeof registration === "function"
      ? registration
      : registration?.dispose
        ? () => registration.dispose?.()
        : () => {};
    return () => {
      if (this.mergeTimer) clearInterval(this.mergeTimer);
      disposeRegistration();
    };
  }

  async presentConfirmation(changeId: string, context: HarnessToolContext): Promise<boolean> {
    const run = this.service.runForInteraction(changeId);
    if (!run) return false;
    const binding = bindingFromContext(context, run.requesterId, run.conversationId);
    if (!binding) return false;
    this.storeBinding(changeId, binding);
    return await this.present("confirm_change", changeId, binding);
  }

  async presentMerge(changeId: string): Promise<boolean> {
    const binding = this.loadBinding(changeId);
    if (!binding) return false;
    return await this.present("merge_change", changeId, binding);
  }

  private async presentPendingApprovals(): Promise<void> {
    if (!this.enabled) return;
    const at = this.now();
    const rows = this.db.prepare(`SELECT r.id,r.state
      FROM control_runs r
      JOIN control_interactive_bindings b ON b.run_id=r.id
      WHERE r.state IN ('awaiting_confirmation','pr_ready')
        AND NOT EXISTS (
          SELECT 1 FROM control_interactive_challenges c
          WHERE c.run_id=r.id
            AND c.operation_kind=CASE r.state WHEN 'pr_ready' THEN 'merge_change' ELSE 'confirm_change' END
            AND c.claimed_at IS NULL AND c.expires_at>=?
        )
        AND NOT EXISTS (
          SELECT 1 FROM control_interactive_challenges c
          WHERE c.run_id=r.id
            AND c.operation_kind=CASE r.state WHEN 'pr_ready' THEN 'merge_change' ELSE 'confirm_change' END
            AND c.created_at>=?
        )`).all(at, at - 60_000) as Array<{ id: string; state: string }>;
    for (const row of rows) {
      const binding = this.loadBinding(row.id);
      if (!binding) continue;
      try {
        await this.present(row.state === "pr_ready" ? "merge_change" : "confirm_change", row.id, binding);
      } catch (error) {
        this.api.logger.warn("[harness] interactive approval recovery failed", { changeId: row.id, error: String(error) });
      }
    }
  }

  private async present(operation: ControlOperation, changeId: string, binding: PresentationBinding): Promise<boolean> {
    if (!this.enabled || !this.api.sendMessage) return false;
    let target: ReturnType<ControlPlaneService["attestationTarget"]>;
    try {
      target = this.service.attestationTarget(operation, binding.actorIdentity, binding.authorityConversation, changeId);
    } catch {
      return false;
    }
    let review: Record<string, unknown> | null;
    try {
      review = this.service.approvalReview(operation, changeId);
    } catch {
      return false;
    }
    const message = review ? reviewMessage(operation, review) : undefined;
    if (!message) return false;
    const token = randomBytes(24).toString("base64url");
    const hash = tokenHash(token);
    const at = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE control_interactive_challenges SET claimed_at=?
        WHERE run_id=? AND operation_kind=? AND claimed_at IS NULL`).run(at, changeId, operation);
      this.db.prepare(`INSERT INTO control_interactive_challenges
        (token_hash,run_id,operation_kind,target_digest,expires_at,claimed_at,created_at)
        VALUES (?,?,?,?,?,NULL,?)`).run(hash, changeId, operation, target.targetDigest, target.expiresAt, at);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }

    try {
      await this.api.sendMessage({
        channel: binding.transportConversation,
        ...(binding.threadId ? { threadTs: binding.threadId } : {}),
        text: message.text,
        presentation: {
          title: operation === "merge_change" ? "Merge approval" : "Execution approval",
          tone: "warning",
          blocks: [
            ...message.blocks,
            {
              type: "buttons",
              buttons: [{
                label: operation === "merge_change" ? "Approve merge" : "Approve and run",
                value: `${CONTROL_INTERACTIVE_NAMESPACE}:approve.${token}`,
                style: "success",
              }],
            },
          ],
        },
      });
      return true;
    } catch (error) {
      this.db.prepare("UPDATE control_interactive_challenges SET claimed_at=? WHERE token_hash=? AND claimed_at IS NULL")
        .run(this.now(), hash);
      this.api.logger.warn("[harness] could not present interactive approval", { changeId, operation, error: String(error) });
      return false;
    }
  }

  private async handle(context: SlackInteractiveContext): Promise<{ handled: boolean }> {
    await context.respond.acknowledge();
    const fail = async (text: string): Promise<{ handled: true }> => {
      await context.respond.reply({ text, responseType: "ephemeral" });
      return { handled: true };
    };
    const sender = (context.senderId ?? "").trim();
    if (!context.auth?.isAuthorizedSender || !sender || !this.authorisedUsers.includes(sender) || context.interaction.kind !== "button") {
      return await fail("This approval is not authorized.");
    }
    const token = /^approve\.([A-Za-z0-9_-]{32,})$/.exec(context.interaction.payload)?.[1];
    if (!token) return await fail("This approval control is malformed or stale.");
    const hash = tokenHash(token);
    const at = this.now();

    this.db.exec("BEGIN IMMEDIATE");
    let row: Record<string, unknown> | undefined;
    try {
      row = this.db.prepare(`SELECT c.*,b.actor_identity,b.authority_conversation,b.channel,b.account_id,
        b.transport_conversation,b.thread_id
        FROM control_interactive_challenges c
        JOIN control_interactive_bindings b ON b.run_id=c.run_id
        WHERE c.token_hash=? AND c.claimed_at IS NULL AND c.expires_at>=?`).get(hash, at) as Record<string, unknown> | undefined;
      if (row) {
        const claimed = this.db.prepare(`UPDATE control_interactive_challenges SET claimed_at=?
          WHERE token_hash=? AND claimed_at IS NULL AND expires_at>=?`).run(at, hash, at);
        if (Number(claimed.changes) !== 1) row = undefined;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
    if (!row) return await fail("This approval was already used, expired, or replaced.");

    const expectedConversation = normalizeConversation(String(row.authority_conversation));
    const interactionConversations = [context.conversationId, context.parentConversationId].map(normalizeConversation);
    const expectedThread = normalizeConversation(String(row.thread_id));
    const actualThread = normalizeConversation(context.threadId);
    if (
      sender !== String(row.actor_identity) ||
      context.accountId.toLowerCase() !== String(row.account_id).toLowerCase() ||
      !interactionConversations.includes(expectedConversation) ||
      actualThread !== expectedThread
    ) {
      return await fail("This approval belongs to another user or conversation.");
    }

    const operation = String(row.operation_kind) as ControlOperation;
    const changeId = String(row.run_id);
    let target: ReturnType<ControlPlaneService["attestationTarget"]>;
    try {
      target = this.service.attestationTarget(operation, sender, String(row.authority_conversation), changeId);
    } catch {
      return await fail("The reviewed change is no longer awaiting this approval.");
    }
    if (target.targetDigest !== String(row.target_digest)) return await fail("The reviewed change changed before approval.");
    let review: Record<string, unknown> | null;
    try {
      review = this.service.approvalReview(operation, changeId);
    } catch {
      return await fail("The complete reviewed proposal is unavailable.");
    }
    const message = review ? reviewMessage(operation, review) : undefined;
    if (!message) return await fail("The complete reviewed proposal is unavailable.");

    const shell = {
      version: 2 as const,
      provenance: "host_verified" as const,
      operation,
      actorIdentity: sender,
      conversationIdentity: String(row.authority_conversation),
      hostEventId: `interactive:${context.interactionId}`,
      nonce: randomBytes(18).toString("base64url"),
      issuedAt: at,
      expiresAt: Math.min(at + 60_000, target.expiresAt),
      bindingDigest: "",
    };
    shell.bindingDigest = this.service.attestationBindingDigest(changeId, shell);
    const attestation = Object.freeze(shell) as NonNullable<TrustedControlContext["trustedControlAttestation"]>;
    try {
      const result = operation === "confirm_change"
        ? await this.service.confirm(changeId, { requesterSenderId: sender, conversationId: shell.conversationIdentity, trustedControlAttestation: attestation })
        : await this.service.merge(changeId, { requesterSenderId: sender, conversationId: shell.conversationIdentity, trustedControlAttestation: attestation });
      await context.respond.editMessage({ text: `${message.text}\n\nApproved by <@${sender}>.`, blocks: [] });
      await context.respond.reply({ text: String((result as Record<string, unknown>).summary ?? "Approval accepted."), responseType: "ephemeral" });
      return { handled: true };
    } catch (error) {
      const message = error instanceof ControlError ? error.message : "Approval failed safely.";
      return await fail(message);
    }
  }

  private storeBinding(runId: string, binding: PresentationBinding): void {
    const at = this.now();
    this.db.prepare(`INSERT INTO control_interactive_bindings
      (run_id,actor_identity,authority_conversation,channel,account_id,transport_conversation,thread_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET actor_identity=excluded.actor_identity,
        authority_conversation=excluded.authority_conversation,channel=excluded.channel,
        account_id=excluded.account_id,transport_conversation=excluded.transport_conversation,
        thread_id=excluded.thread_id,updated_at=excluded.updated_at`)
      .run(runId, binding.actorIdentity, binding.authorityConversation, binding.channel, binding.accountId,
        binding.transportConversation, binding.threadId, at, at);
  }

  private loadBinding(runId: string): PresentationBinding | undefined {
    const row = this.db.prepare("SELECT * FROM control_interactive_bindings WHERE run_id=?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return Object.freeze({
      actorIdentity: String(row.actor_identity),
      authorityConversation: String(row.authority_conversation),
      channel: String(row.channel),
      accountId: String(row.account_id),
      transportConversation: String(row.transport_conversation),
      threadId: String(row.thread_id),
    });
  }
}
