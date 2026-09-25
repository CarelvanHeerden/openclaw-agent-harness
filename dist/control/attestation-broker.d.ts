import { type ControlOperation, type ControlPlaneService, type TrustedControlContext } from "./service.js";
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
/**
 * Deliberately bounded natural-language parser. It accepts ordinary positive
 * authorization wording and an optional human label, but never treats a
 * question, negation, hesitation, mixed operation, or requested contract
 * change as approval. The label is only descriptive: the broker still resolves
 * exactly one current target from authenticated host identity and conversation.
 */
export declare function parseControlIntent(input: string): ParsedIntent | undefined;
/** In-memory, short-lived, one-shot bridge from a raw host event to a tool call. */
export declare function registerControlAttestationHook(api: {
    on?: (event: string, handler: (event: unknown, context?: unknown) => unknown) => (() => void) | {
        dispose?: () => void;
    } | undefined;
    logger?: {
        warn?: (message: string) => void;
    };
}, broker: ControlAttestationBroker): () => void;
export declare class ControlAttestationBroker {
    private readonly service;
    private readonly now;
    private readonly ttlMs;
    private readonly records;
    private readonly observedEvents;
    constructor(service: ControlPlaneService, now?: () => number, ttlMs?: number);
    observe(event: InboundConfirmationEvent, ctx: InboundConfirmationContext): void;
    consume(operation: ControlOperation, changeId: string, context: ConfirmationToolContext): Attestation;
    private prune;
    private key;
    private eventKey;
}
export {};
//# sourceMappingURL=attestation-broker.d.ts.map