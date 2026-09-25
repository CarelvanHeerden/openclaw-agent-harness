import { randomBytes } from "node:crypto";
import { ControlError, } from "./service.js";
const CHANGE_ID = /chg_[A-Za-z0-9_-]{12,}/g;
const INTERNAL_MARKERS = [
    "<<<begin_openclaw_internal_context>>>",
    "[subagent context]",
    "[runtime context]",
    "[system message]",
    "[tool result]",
];
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
function timestampMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        return undefined;
    return value < 100_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}
function list(value) {
    const unwrapped = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (!unwrapped)
        return undefined;
    const items = unwrapped.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
}
function sameList(left, right) {
    return !!left && left.length === right.length && left.every((item, index) => item === right[index]);
}
/**
 * Deliberately narrow parser. It accepts an explicit confirmation or merge
 * sentence, an optional change id, and only four material modifiers. Unknown
 * prose, negation, questions, multiple ids, or mixed operations are rejected.
 */
export function parseControlIntent(input) {
    const raw = input.trim();
    if (!raw || raw.length > 2000)
        return undefined;
    const lower = raw.toLowerCase();
    if (INTERNAL_MARKERS.some((marker) => lower.includes(marker)))
        return undefined;
    if (/[?]/.test(raw) || /\b(?:not|don['’]?t|do not|cancel|instead|unless|maybe|perhaps)\b/i.test(raw))
        return undefined;
    const ids = [...raw.matchAll(CHANGE_ID)].map((match) => match[0]);
    if (new Set(ids).size > 1)
        return undefined;
    let rest = raw.replace(CHANGE_ID, " ").trim();
    let operation;
    const confirm = /^(?:yes\s*[,;:]?\s*)?(?:i\s+)?(?:confirm|approve)(?:\s+(?:this|the))?(?:\s+(?:exact\s+)?(?:prepared\s+)?change)?\b/i;
    const merge = /^(?:yes\s*[,;:]?\s*)?(?:i\s+)?(?:authorize\s+(?:the\s+)?merge|merge)(?:\s+of)?(?:\s+(?:this|the))?(?:\s+(?:ready\s+)?(?:change|pull\s+request|pr))?\b/i;
    const confirmMatch = rest.match(confirm);
    const mergeMatch = rest.match(merge);
    if (!!confirmMatch === !!mergeMatch)
        return undefined;
    if (confirmMatch) {
        operation = "confirm_change";
        rest = rest.slice(confirmMatch[0].length);
    }
    else if (mergeMatch) {
        operation = "merge_change";
        rest = rest.slice(mergeMatch[0].length);
    }
    const modifiers = {};
    rest = rest.replace(/(?:^|[,;])\s*budget(?:\s+is|\s*=|\s*:)?\s*\$?([0-9]+(?:\.[0-9]{1,2})?)\s*(?:usd)?\b/gi, (_all, amount) => {
        if (modifiers.budgetUsd !== undefined)
            return " __duplicate__ ";
        modifiers.budgetUsd = Number(amount);
        return " ";
    });
    rest = rest.replace(/(?:^|[,;])\s*time(?:\s+limit)?(?:\s+is|\s*=|\s*:)?\s*([0-9]+)\s*(seconds?|secs?|s)\b/gi, (_all, amount) => {
        if (modifiers.timeLimitSeconds !== undefined)
            return " __duplicate__ ";
        modifiers.timeLimitSeconds = Number(amount);
        return " ";
    });
    rest = rest.replace(/(?:^|[,;])\s*excluded\s+scope(?:\s+is|\s*=|\s*:)?\s*(\[[^\]]*\]|[^;]+)/gi, (_all, value) => {
        if (modifiers.excludedScope !== undefined)
            return " __duplicate__ ";
        modifiers.excludedScope = list(value);
        return " ";
    });
    rest = rest.replace(/(?:^|[,;])\s*scope(?:\s+is|\s*=|\s*:)?\s*(\[[^\]]*\]|[^;]+)/gi, (_all, value) => {
        if (modifiers.scope !== undefined)
            return " __duplicate__ ";
        modifiers.scope = list(value);
        return " ";
    });
    if (rest.replace(/[\s.,;:!]+/g, "").length > 0 || rest.includes("__duplicate__"))
        return undefined;
    return { operation: operation, ...(ids[0] ? { changeId: ids[0] } : {}), modifiers };
}
function exactModifiers(modifiers, target) {
    if (modifiers.budgetUsd !== undefined && modifiers.budgetUsd !== target.budgetUsd)
        return false;
    if (modifiers.timeLimitSeconds !== undefined && modifiers.timeLimitSeconds !== target.timeLimitSeconds)
        return false;
    if (modifiers.scope !== undefined && !sameList(modifiers.scope, target.scope))
        return false;
    if (modifiers.excludedScope !== undefined && !sameList(modifiers.excludedScope, target.excludedScope))
        return false;
    return true;
}
function inboundBinding(event, ctx) {
    const channel = text(ctx.channelId);
    const conversationId = text(ctx.conversationId);
    if (!channel || !conversationId)
        return undefined;
    return {
        channel,
        accountId: text(ctx.accountId),
        conversationId,
        threadId: text(event.threadId),
    };
}
function toolBinding(ctx) {
    const conversationId = text(ctx.nativeChannelId) || text(ctx.conversationId) || text(ctx.deliveryContext?.to);
    const channel = text(ctx.messageChannel) || text(ctx.deliveryContext?.channel);
    if (!channel || !conversationId)
        return undefined;
    return {
        channel,
        accountId: text(ctx.agentAccountId) || text(ctx.deliveryContext?.accountId),
        conversationId,
        threadId: text(ctx.deliveryContext?.threadId),
    };
}
function sameBinding(left, right) {
    return left.channel === right.channel &&
        left.accountId === right.accountId &&
        left.conversationId === right.conversationId &&
        left.threadId === right.threadId;
}
/** In-memory, short-lived, one-shot bridge from a raw host event to a tool call. */
export function registerControlAttestationHook(api, broker) {
    if (!api.on) {
        api.logger?.warn?.("[harness] message_received hook unavailable; confirmations remain fail-closed");
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
export class ControlAttestationBroker {
    service;
    now;
    ttlMs;
    records = new Map();
    constructor(service, now = Date.now, ttlMs = 60_000) {
        this.service = service;
        this.now = now;
        this.ttlMs = ttlMs;
    }
    observe(event, ctx) {
        this.prune();
        if (Number(ctx.callDepth ?? 0) > 0 || text(ctx.runId) || text(event.runId))
            return;
        const actorIdentity = text(ctx.senderId) || text(event.senderId);
        const hostEventId = text(ctx.messageId) || text(event.messageId);
        const issuedAt = timestampMs(event.timestamp);
        const binding = inboundBinding(event, ctx);
        const content = text(event.content);
        if (!actorIdentity || !hostEventId || !issuedAt || !binding || !content)
            return;
        if (text(ctx.senderId) && text(event.senderId) && text(ctx.senderId) !== text(event.senderId))
            return;
        if (text(ctx.messageId) && text(event.messageId) && text(ctx.messageId) !== text(event.messageId))
            return;
        const intent = parseControlIntent(content);
        if (!intent)
            return;
        let target;
        try {
            target = this.service.attestationTarget(intent.operation, actorIdentity, binding.conversationId, intent.changeId);
        }
        catch {
            return;
        }
        if (issuedAt <= target.updatedAt || issuedAt > this.now() + 5_000 || !exactModifiers(intent.modifiers, target))
            return;
        const expiresAt = Math.min(this.now() + this.ttlMs, target.expiresAt);
        if (expiresAt <= this.now())
            return;
        const shell = {
            version: 2,
            provenance: "host_verified",
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
        const attestation = Object.freeze(shell);
        const key = this.key(actorIdentity, intent.operation, target.changeId);
        this.records.set(key, {
            changeId: target.changeId,
            actorIdentity,
            binding,
            attestation,
            targetDigest: target.targetDigest,
            expiresAt,
        });
    }
    consume(operation, changeId, context) {
        this.prune();
        const actorIdentity = text(context.requesterSenderId);
        const binding = toolBinding(context);
        if (!actorIdentity || !binding) {
            throw new ControlError(operation === "merge_change" ? "merge_attestation_required" : "confirmation_attestation_required", "A fresh raw-user confirmation event is required.");
        }
        const key = this.key(actorIdentity, operation, changeId);
        const record = this.records.get(key);
        // Delete before any state lookup: a matching broker authorization is one
        // shot even when the state changed or downstream validation rejects it.
        if (record)
            this.records.delete(key);
        if (!record || record.expiresAt < this.now() || !sameBinding(record.binding, binding)) {
            throw new ControlError(operation === "merge_change" ? "merge_attestation_required" : "confirmation_attestation_required", "A fresh raw-user confirmation event is required.");
        }
        const current = this.service.attestationTarget(operation, actorIdentity, binding.conversationId, changeId);
        if (current.targetDigest !== record.targetDigest) {
            throw new ControlError(operation === "merge_change" ? "stale_pr_head" : "stale_confirmation", "The reviewed state changed before authorization was consumed.");
        }
        return record.attestation;
    }
    prune() {
        const now = this.now();
        for (const [key, record] of this.records)
            if (record.expiresAt < now)
                this.records.delete(key);
    }
    key(actor, operation, changeId) {
        return `${actor}\0${operation}\0${changeId}`;
    }
}
//# sourceMappingURL=attestation-broker.js.map