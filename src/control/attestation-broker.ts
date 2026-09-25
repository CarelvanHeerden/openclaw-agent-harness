import { randomBytes } from "node:crypto";
import {
  ControlError,
  type ControlOperation,
  type ControlPlaneService,
  type TrustedControlContext,
} from "./service.js";

export interface InboundConfirmationEvent {
  content?: unknown;
  timestamp?: unknown;
  threadId?: unknown;
  messageId?: unknown;
  senderId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  metadata?: {
    provider?: unknown;
    surface?: unknown;
    originatingChannel?: unknown;
    originatingTo?: unknown;
    threadId?: unknown;
    messageId?: unknown;
    senderId?: unknown;
  } | unknown;
}

export interface InboundConfirmationContext {
  channelId?: unknown;
  accountId?: unknown;
  conversationId?: unknown;
  senderId?: unknown;
  messageId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  callDepth?: unknown;
}

export interface ConfirmationToolContext {
  requesterSenderId?: string;
  hostEventId?: string;
  sessionKey?: string;
  nativeChannelId?: string;
  conversationId?: string;
  messageChannel?: string;
  agentAccountId?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  };
}

type Attestation = NonNullable<TrustedControlContext["trustedControlAttestation"]>;

type ConversationBinding = Readonly<{
  channel: string;
  accountId: string;
  conversationId: string;
  threadId: string;
}>;

type MaterialModifiers = Readonly<{
  budgetUsd?: number;
  timeLimitSeconds?: number;
  scope?: readonly string[];
  excludedScope?: readonly string[];
}>;

type ParsedIntent = Readonly<{
  operation: ControlOperation;
  changeId?: string;
  modifiers: MaterialModifiers;
}>;

type BrokerRecord = Readonly<{
  changeId: string;
  actorIdentity: string;
  binding: ConversationBinding;
  sessionKey: string;
  attestation: Attestation;
  targetDigest: string;
  expiresAt: number;
}>;

const CHANGE_ID = /chg_[A-Za-z0-9_-]{12,}/g;
const INTERNAL_MARKERS = [
  "<<<begin_openclaw_internal_context>>>",
  "[subagent context]",
  "[runtime context]",
  "[system message]",
  "[tool result]",
];

const NEGATION_OR_HESITATION = /\b(?:not|nope|nah|don['’]?t|do not|won['’]?t|will not|can['’]?t|cannot|shouldn['’]?t|cancel|stop|hold off|wait|instead|unless|maybe|perhaps|if|once|after|before|when|until|without approval)\b/i;
const MATERIAL_CHANGE = /\b(?:change|changing|increase|increased|decrease|decreased|raise|raised|lower|lowered|set|add|remove|expand|narrow|different|another|except|but|however)\b/i;
const MATERIAL_FIELD = /\b(?:budget|scope|time\s+limit|seconds?|secs?|usd)\b|\$/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function channel(value: unknown): string {
  return text(value).toLowerCase();
}

function account(value: unknown): string {
  return text(value).toLowerCase() || "default";
}

function conversation(value: unknown, channelId: string): string {
  let normalized = text(value);
  const prefix = `${channelId}:`;
  while (channelId && normalized.toLowerCase().startsWith(prefix)) normalized = normalized.slice(prefix.length);
  return normalized;
}

function thread(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

function timestampMs(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric < 100_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
}

function list(value: string): string[] | undefined {
  const unwrapped = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!unwrapped) return undefined;
  const items = unwrapped.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function sameList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return !!left && left.length === right.length && left.every((item, index) => item === right[index]);
}

function plainText(input: string): string {
  const trimmed = input.trim();
  const unfenced = trimmed.match(/^```(?:text|markdown)?\s*\n?([\s\S]*?)\n?```$/i)?.[1] ?? trimmed;
  return unfenced
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/[–—]/g, "-")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^(?:\*\*|__|~~)([\s\S]*)(?:\*\*|__|~~)$/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deliberately bounded natural-language parser. It accepts ordinary positive
 * authorization wording and an optional human label, but never treats a
 * question, negation, hesitation, mixed operation, or requested contract
 * change as approval. The label is only descriptive: the broker still resolves
 * exactly one current target from authenticated host identity and conversation.
 */
export function parseControlIntent(input: string): ParsedIntent | undefined {
  const raw = plainText(input);
  if (!raw || raw.length > 2000) return undefined;
  const lower = raw.toLowerCase();
  if (INTERNAL_MARKERS.some((marker) => lower.includes(marker))) return undefined;
  if (/[?]/.test(raw) || NEGATION_OR_HESITATION.test(raw)) return undefined;

  const ids = [...raw.matchAll(CHANGE_ID)].map((match) => match[0]!);
  if (new Set(ids).size > 1) return undefined;
  let rest = raw.replace(CHANGE_ID, " ").trim();

  let operation: ControlOperation | undefined;
  const affirmative = "(?:(?:yes|yep|yeah|ok(?:ay)?|sure|looks good|sounds good)\\s*[,;:!-]?\\s*)?";
  const confirm = new RegExp(`^${affirmative}(?:please\\s+)?(?:i\\s+)?(?:confirm|approve|approved|start|proceed(?:\\s+with)?|run|go(?:\\s+ahead(?:\\s+with)?|\\s+for\\s+it)|got\\s+for\\s+it|do\\s+it|let['’]?s\\s+do\\s+it)(?:\\s+(?:this|that|the))?(?:\\s+(?:exact\\s+)?(?:prepared\\s+)?change)?\\b`, "i");
  const merge = new RegExp(`^${affirmative}(?:please\\s+)?(?:i\\s+)?(?:authorize\\s+(?:the\\s+)?merge|merge)(?:\\s+of)?(?:\\s+(?:this|that|the))?(?:\\s+(?:ready\\s+)?(?:change|pull\\s+request|pr))?\\b`, "i");
  const bareConfirm = /^(?:yes|yep|yeah|ok(?:ay)?|sure|looks good|sounds good)\s*[.!]*$/i;
  if (bareConfirm.test(rest)) {
    operation = "confirm_change";
    rest = "";
  } else {
    const confirmMatch = rest.match(confirm);
    const mergeMatch = rest.match(merge);
    if (!!confirmMatch === !!mergeMatch) return undefined;
    if (confirmMatch) {
      operation = "confirm_change";
      rest = rest.slice(confirmMatch[0].length);
    } else if (mergeMatch) {
      operation = "merge_change";
      rest = rest.slice(mergeMatch[0].length);
    }
  }

  const modifiers: { budgetUsd?: number; timeLimitSeconds?: number; scope?: string[]; excludedScope?: string[] } = {};
  rest = rest.replace(/(?:^|[,;])\s*budget(?:\s+is|\s*=|\s*:)?\s*\$?([0-9]+(?:\.[0-9]{1,2})?)\s*(?:usd)?\b/gi, (_all, amount: string) => {
    if (modifiers.budgetUsd !== undefined) return " __duplicate__ ";
    modifiers.budgetUsd = Number(amount);
    return " ";
  });
  rest = rest.replace(/(?:^|[,;])\s*time(?:\s+limit)?(?:\s+is|\s*=|\s*:)?\s*([0-9]+)\s*(seconds?|secs?|s)\b/gi, (_all, amount: string) => {
    if (modifiers.timeLimitSeconds !== undefined) return " __duplicate__ ";
    modifiers.timeLimitSeconds = Number(amount);
    return " ";
  });
  rest = rest.replace(/(?:^|[,;])\s*excluded\s+scope(?:\s+is|\s*=|\s*:)?\s*(\[[^\]]*\]|[^;]+)/gi, (_all, value: string) => {
    if (modifiers.excludedScope !== undefined) return " __duplicate__ ";
    modifiers.excludedScope = list(value);
    return " ";
  });
  rest = rest.replace(/(?:^|[,;])\s*scope(?:\s+is|\s*=|\s*:)?\s*(\[[^\]]*\]|[^;]+)/gi, (_all, value: string) => {
    if (modifiers.scope !== undefined) return " __duplicate__ ";
    modifiers.scope = list(value);
    return " ";
  });
  const label = rest.replace(/^[\s.,;:!-]+|[\s.,;:!-]+$/g, "").trim();
  if (rest.includes("__duplicate__") || MATERIAL_CHANGE.test(label) || MATERIAL_FIELD.test(label)) return undefined;
  if (operation === "confirm_change" && /\b(?:merge|pull\s+request|pr)\b/i.test(label)) return undefined;
  if (operation === "merge_change" && /\b(?:run|start|implement|change)\b/i.test(label)) return undefined;

  return { operation: operation!, ...(ids[0] ? { changeId: ids[0] } : {}), modifiers };
}

function exactModifiers(
  modifiers: MaterialModifiers,
  target: ReturnType<ControlPlaneService["attestationTarget"]>,
): boolean {
  if (modifiers.budgetUsd !== undefined && modifiers.budgetUsd !== target.budgetUsd) return false;
  if (modifiers.timeLimitSeconds !== undefined && modifiers.timeLimitSeconds !== target.timeLimitSeconds) return false;
  if (modifiers.scope !== undefined && !sameList(modifiers.scope, target.scope)) return false;
  if (modifiers.excludedScope !== undefined && !sameList(modifiers.excludedScope, target.excludedScope)) return false;
  return true;
}

function inboundBinding(event: InboundConfirmationEvent, ctx: InboundConfirmationContext): ConversationBinding | undefined {
  const metadata = record(event.metadata);
  const channelId = channel(ctx.channelId);
  const conversationId = conversation(ctx.conversationId || metadata.originatingTo, channelId);
  if (!channelId || !conversationId) return undefined;
  return {
    channel: channelId,
    accountId: account(ctx.accountId),
    conversationId,
    threadId: thread(event.threadId ?? metadata.threadId),
  };
}

function toolBinding(ctx: ConfirmationToolContext): ConversationBinding | undefined {
  const channelId = channel(ctx.messageChannel || ctx.deliveryContext?.channel);
  // Match the canonical route conversation used by message_received. Slack DMs
  // project `user:<id>` here while nativeChannelId is the transport `D...` id.
  const conversationId = conversation(ctx.deliveryContext?.to || ctx.conversationId || ctx.nativeChannelId, channelId);
  if (!channelId || !conversationId) return undefined;
  const deliveryChannel = channel(ctx.deliveryContext?.channel);
  const deliveryConversation = conversation(ctx.deliveryContext?.to, channelId);
  if (deliveryChannel && deliveryChannel !== channelId) return undefined;
  if (deliveryConversation && deliveryConversation !== conversationId) return undefined;
  return {
    channel: channelId,
    accountId: account(ctx.agentAccountId || ctx.deliveryContext?.accountId),
    conversationId,
    threadId: thread(ctx.deliveryContext?.threadId),
  };
}

function isExternalInbound(event: InboundConfirmationEvent, ctx: InboundConfirmationContext): boolean {
  if (Number(ctx.callDepth ?? 0) > 0) return false;
  const metadata = record(event.metadata);
  const channelId = channel(ctx.channelId);
  const surfaces = [metadata.originatingChannel, metadata.provider, metadata.surface].map(channel).filter(Boolean);
  if (!channelId || surfaces.length === 0 || surfaces.some((surface) => surface !== channelId)) return false;
  const sessionKey = text(ctx.sessionKey) || text(event.sessionKey);
  if (/(?:^|:)subagent(?::|$)|(?:^|:)internal-session-effects(?::|$)/i.test(sessionKey)) return false;
  return true;
}

function sameBinding(left: ConversationBinding, right: ConversationBinding): boolean {
  return left.channel === right.channel &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId &&
    left.threadId === right.threadId;
}

/** In-memory, short-lived, one-shot bridge from a raw host event to a tool call. */
export function registerControlAttestationHook(
  api: {
    on?: (event: string, handler: (event: unknown, context?: unknown) => unknown) => (() => void) | { dispose?: () => void } | undefined;
    logger?: { warn?: (message: string) => void };
  },
  broker: ControlAttestationBroker,
): () => void {
  if (!api.on) {
    api.logger?.warn?.("[harness] message_received hook unavailable; confirmations remain fail-closed");
    return () => {};
  }
  const disposer = api.on("message_received", (event, context) => {
    broker.observe(event as InboundConfirmationEvent, (context ?? {}) as InboundConfirmationContext);
  });
  if (typeof disposer === "function") return disposer;
  if (disposer?.dispose) return () => disposer.dispose?.();
  return () => {};
}

export class ControlAttestationBroker {
  private readonly records = new Map<string, BrokerRecord>();
  private readonly observedEvents = new Map<string, number>();

  constructor(
    private readonly service: ControlPlaneService,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
  ) {}

  observe(event: InboundConfirmationEvent, ctx: InboundConfirmationContext): void {
    this.prune();
    if (!isExternalInbound(event, ctx)) return;
    const metadata = record(event.metadata);
    const actorIdentity = text(ctx.senderId) || text(event.senderId) || text(metadata.senderId);
    const hostEventId = text(ctx.messageId) || text(event.messageId) || text(metadata.messageId);
    const sessionKey = text(ctx.sessionKey) || text(event.sessionKey);
    // OpenClaw's public message hook only projects numeric timestamps. Slack's
    // native event timestamp/message id is a numeric string, so use that
    // host-issued id when the projected timestamp is absent.
    const issuedAt = timestampMs(event.timestamp) ?? timestampMs(hostEventId);
    const binding = inboundBinding(event, ctx);
    const content = text(event.content);
    if (!actorIdentity || !hostEventId || !sessionKey || !issuedAt || !binding || !content) return;
    const senderIds = [ctx.senderId, event.senderId, metadata.senderId].map(text).filter(Boolean);
    const messageIds = [ctx.messageId, event.messageId, metadata.messageId].map(text).filter(Boolean);
    if (new Set(senderIds).size > 1 || new Set(messageIds).size > 1) return;

    const eventKey = this.eventKey(actorIdentity, binding, hostEventId);
    if (this.observedEvents.has(eventKey)) return;
    this.observedEvents.set(eventKey, this.now() + this.ttlMs);

    const intent = parseControlIntent(content);
    if (!intent) return;
    let target: ReturnType<ControlPlaneService["attestationTarget"]>;
    try {
      target = this.service.attestationTarget(intent.operation, actorIdentity, binding.conversationId, intent.changeId);
    } catch {
      return;
    }
    if (issuedAt <= target.updatedAt || issuedAt > this.now() + 5_000 || !exactModifiers(intent.modifiers, target)) return;

    const expiresAt = Math.min(this.now() + this.ttlMs, target.expiresAt);
    if (expiresAt <= this.now()) return;
    const shell = {
      version: 2 as const,
      provenance: "host_verified" as const,
      operation: intent.operation,
      actorIdentity,
      conversationIdentity: binding.conversationId,
      hostEventId,
      nonce: randomBytes(18).toString("base64url"),
      issuedAt,
      expiresAt,
      bindingDigest: "",
    };
    shell.bindingDigest = this.service.attestationBindingDigest(target.changeId, shell);
    const attestation: Attestation = Object.freeze(shell);
    const key = this.key(actorIdentity, intent.operation, target.changeId);
    this.records.set(key, {
      changeId: target.changeId,
      actorIdentity,
      binding,
      sessionKey,
      attestation,
      targetDigest: target.targetDigest,
      expiresAt,
    });
  }

  consume(operation: ControlOperation, changeId: string, context: ConfirmationToolContext): Attestation {
    this.prune();
    const actorIdentity = text(context.requesterSenderId);
    const hostEventId = text(context.hostEventId);
    const sessionKey = text(context.sessionKey);
    const binding = toolBinding(context);
    if (!actorIdentity || !sessionKey || !binding) {
      throw new ControlError(operation === "merge_change" ? "merge_attestation_required" : "confirmation_attestation_required", "A fresh raw-user confirmation event is required.");
    }
    const key = this.key(actorIdentity, operation, changeId);
    const record = this.records.get(key);
    // Delete before any state lookup: a matching broker authorization is one
    // shot even when the state changed or downstream validation rejects it.
    if (record) this.records.delete(key);
    // OpenClaw's public plugin-tool context does not project the inbound
    // message id. Bind the one-shot raw-event capability to the authenticated
    // actor, exact conversation and originating session instead. Newer hosts
    // may additionally project hostEventId; when present it must match.
    if (!record || record.expiresAt < this.now() || record.sessionKey !== sessionKey ||
      (hostEventId && record.attestation.hostEventId !== hostEventId) || !sameBinding(record.binding, binding)) {
      throw new ControlError(operation === "merge_change" ? "merge_attestation_required" : "confirmation_attestation_required", "A fresh raw-user confirmation event is required.");
    }
    const current = this.service.attestationTarget(operation, actorIdentity, binding.conversationId, changeId);
    if (current.targetDigest !== record.targetDigest) {
      throw new ControlError(operation === "merge_change" ? "stale_pr_head" : "stale_confirmation", "The reviewed state changed before authorization was consumed.");
    }
    return record.attestation;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, record] of this.records) if (record.expiresAt < now) this.records.delete(key);
    for (const [key, expiresAt] of this.observedEvents) if (expiresAt < now) this.observedEvents.delete(key);
  }

  private key(actor: string, operation: ControlOperation, changeId: string): string {
    return `${actor}\0${operation}\0${changeId}`;
  }

  private eventKey(actor: string, binding: ConversationBinding, hostEventId: string): string {
    return `${actor}\0${binding.channel}\0${binding.accountId}\0${binding.conversationId}\0${binding.threadId}\0${hostEventId}`;
  }
}
