import { createHash, randomBytes } from "node:crypto";
import { ControlError, } from "./service.js";
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function channel(value) {
    return text(value).toLowerCase();
}
function account(value) {
    return text(value).toLowerCase() || "default";
}
function conversation(value, channelId) {
    let normalized = text(value);
    const prefix = `${channelId}:`;
    while (channelId && normalized.toLowerCase().startsWith(prefix))
        normalized = normalized.slice(prefix.length);
    return normalized;
}
function thread(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return text(value);
}
function timestampMs(value) {
    const numeric = typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
            ? Number(value.trim())
            : NaN;
    if (!Number.isFinite(numeric) || numeric <= 0)
        return undefined;
    return numeric < 100_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
}
function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}
function inboundBinding(event, ctx) {
    const metadata = record(event.metadata);
    const channelId = channel(ctx.channelId);
    const conversationId = conversation(ctx.conversationId || metadata.originatingTo, channelId);
    if (!channelId || !conversationId)
        return undefined;
    return {
        channel: channelId,
        accountId: account(ctx.accountId),
        conversationId,
        threadId: thread(event.threadId ?? metadata.threadId),
    };
}
function toolBinding(ctx) {
    const channelId = channel(ctx.messageChannel || ctx.deliveryContext?.channel);
    const conversationId = conversation(ctx.deliveryContext?.to || ctx.conversationId || ctx.nativeChannelId, channelId);
    if (!channelId || !conversationId)
        return undefined;
    const deliveryChannel = channel(ctx.deliveryContext?.channel);
    const deliveryConversation = conversation(ctx.deliveryContext?.to, channelId);
    if (deliveryChannel && deliveryChannel !== channelId)
        return undefined;
    if (deliveryConversation && deliveryConversation !== conversationId)
        return undefined;
    return {
        channel: channelId,
        accountId: account(ctx.agentAccountId || ctx.deliveryContext?.accountId),
        conversationId,
        threadId: thread(ctx.deliveryContext?.threadId),
    };
}
function isExternalInbound(event, ctx) {
    if (Number(ctx.callDepth ?? 0) > 0)
        return false;
    const metadata = record(event.metadata);
    const channelId = channel(ctx.channelId);
    const surfaces = [metadata.originatingChannel, metadata.provider, metadata.surface].map(channel).filter(Boolean);
    if (!channelId || surfaces.length === 0 || surfaces.some((surface) => surface !== channelId))
        return false;
    const sessionKey = text(ctx.sessionKey) || text(event.sessionKey);
    return !/(?:^|:)subagent(?::|$)|(?:^|:)internal-session-effects(?::|$)/i.test(sessionKey);
}
function sameBinding(left, right, hostEventId) {
    const sameThread = left.threadId === right.threadId || (left.channel === "slack" && !!hostEventId && ((left.threadId === "" && right.threadId === hostEventId) ||
        (right.threadId === "" && left.threadId === hostEventId)));
    return left.channel === right.channel &&
        left.accountId === right.accountId &&
        left.conversationId === right.conversationId &&
        sameThread;
}
export function registerHostTurnHook(api, broker) {
    if (!api.on) {
        api.logger?.warn?.("[harness] message_received hook unavailable; conversational authority remains fail-closed");
        return () => { };
    }
    const disposer = api.on("message_received", (event, context) => {
        broker.observe(event, (context ?? {}));
    });
    if (typeof disposer === "function")
        return disposer;
    if (disposer?.dispose)
        return () => disposer.dispose?.();
    return () => { };
}
export class HostTurnAuthorityBroker {
    service;
    db;
    now;
    ttlMs;
    constructor(service, db, now = Date.now, ttlMs = 60_000) {
        this.service = service;
        this.db = db;
        this.now = now;
        this.ttlMs = ttlMs;
    }
    observe(event, ctx) {
        if (!isExternalInbound(event, ctx))
            return;
        const metadata = record(event.metadata);
        const actorIdentity = text(ctx.senderId) || text(event.senderId) || text(metadata.senderId);
        const hostEventId = text(ctx.messageId) || text(event.messageId) || text(metadata.messageId);
        const sessionKey = text(ctx.sessionKey) || text(event.sessionKey);
        const issuedAt = timestampMs(event.timestamp) ?? timestampMs(hostEventId);
        const binding = inboundBinding(event, ctx);
        const content = text(event.content);
        if (!actorIdentity || !hostEventId || !sessionKey || !issuedAt || !binding || !content || content.length > 100_000)
            return;
        const senderIds = [ctx.senderId, event.senderId, metadata.senderId].map(text).filter(Boolean);
        const messageIds = [ctx.messageId, event.messageId, metadata.messageId].map(text).filter(Boolean);
        if (new Set(senderIds).size > 1 || new Set(messageIds).size > 1 || issuedAt > this.now() + 5_000)
            return;
        const recordKey = digest(`${actorIdentity}\0${binding.channel}\0${binding.accountId}\0${binding.conversationId}\0${binding.threadId}\0${hostEventId}`);
        this.db.prepare(`INSERT OR IGNORE INTO control_host_turn_capabilities
      (record_key,actor_identity,channel,account_id,conversation_identity,thread_id,session_key,host_event_id,content_digest,issued_at,expires_at,claimed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(recordKey, actorIdentity, binding.channel, binding.accountId, binding.conversationId, binding.threadId, sessionKey, hostEventId, digest(content), issuedAt, this.now() + this.ttlMs);
    }
    consume(operation, changeId, context) {
        const actorIdentity = text(context.requesterSenderId);
        const sessionKey = text(context.sessionKey);
        const hostEventId = text(context.hostEventId);
        const binding = toolBinding(context);
        if (!actorIdentity || !sessionKey || !binding)
            throw this.required(operation);
        const candidates = this.loadCandidates(actorIdentity, sessionKey, hostEventId)
            .filter((candidate) => sameBinding(candidate.binding, binding, candidate.hostEventId));
        if (candidates.length === 0)
            throw this.required(operation);
        const latestIssuedAt = Math.max(...candidates.map((candidate) => candidate.issuedAt));
        const latest = candidates.filter((candidate) => candidate.issuedAt === latestIssuedAt);
        if (latest.length !== 1)
            throw this.required(operation);
        const turn = latest[0];
        if (!this.claim(turn.recordKey))
            throw this.required(operation);
        let target;
        try {
            target = this.service.attestationTarget(operation, actorIdentity, binding.conversationId, changeId);
        }
        catch {
            throw this.required(operation);
        }
        if (turn.issuedAt <= target.updatedAt || turn.expiresAt < this.now()) {
            throw new ControlError(operation === "merge_change" ? "stale_pr_head" : "stale_confirmation", "The user turn predates or no longer matches the reviewed state.");
        }
        const shell = {
            version: 2,
            provenance: "host_verified",
            operation,
            actorIdentity,
            conversationIdentity: binding.conversationId,
            hostEventId: turn.hostEventId,
            nonce: randomBytes(18).toString("base64url"),
            issuedAt: turn.issuedAt,
            expiresAt: Math.min(turn.expiresAt, target.expiresAt),
            bindingDigest: "",
        };
        shell.bindingDigest = this.service.attestationBindingDigest(changeId, shell);
        return Object.freeze(shell);
    }
    loadCandidates(actorIdentity, sessionKey, hostEventId) {
        const rows = hostEventId
            ? this.db.prepare(`SELECT * FROM control_host_turn_capabilities
          WHERE actor_identity=? AND session_key=? AND host_event_id=?
            AND claimed_at IS NULL AND expires_at>=?`).all(actorIdentity, sessionKey, hostEventId, this.now())
            : this.db.prepare(`SELECT * FROM control_host_turn_capabilities
          WHERE actor_identity=? AND session_key=?
            AND claimed_at IS NULL AND expires_at>=?
          ORDER BY issued_at DESC LIMIT 10`).all(actorIdentity, sessionKey, this.now());
        return rows.map((row) => ({
            recordKey: String(row.record_key),
            actorIdentity: String(row.actor_identity),
            binding: {
                channel: String(row.channel),
                accountId: String(row.account_id),
                conversationId: String(row.conversation_identity),
                threadId: String(row.thread_id),
            },
            sessionKey: String(row.session_key),
            hostEventId: String(row.host_event_id),
            contentDigest: String(row.content_digest),
            issuedAt: Number(row.issued_at),
            expiresAt: Number(row.expires_at),
        }));
    }
    claim(recordKey) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = this.db.prepare(`UPDATE control_host_turn_capabilities SET claimed_at=?
        WHERE record_key=? AND claimed_at IS NULL AND expires_at>=?`).run(this.now(), recordKey, this.now());
            this.db.exec("COMMIT");
            return Number(result.changes) === 1;
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* preserve original error */ }
            throw error;
        }
    }
    required(operation) {
        return new ControlError(operation === "merge_change" ? "merge_attestation_required" : "confirmation_attestation_required", "A fresh authenticated user turn in this OpenClaw conversation is required.");
    }
}
//# sourceMappingURL=host-turn-broker.js.map