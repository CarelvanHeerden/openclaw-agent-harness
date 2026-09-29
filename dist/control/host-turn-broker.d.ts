import type { DatabaseSync } from "node:sqlite";
import { type ControlOperation, type ControlPlaneService, type TrustedControlContext } from "./service.js";
export interface InboundHostTurnEvent {
    content?: unknown;
    timestamp?: unknown;
    threadId?: unknown;
    messageId?: unknown;
    senderId?: unknown;
    sessionKey?: unknown;
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
export interface InboundHostTurnContext {
    channelId?: unknown;
    accountId?: unknown;
    conversationId?: unknown;
    senderId?: unknown;
    messageId?: unknown;
    sessionKey?: unknown;
    callDepth?: unknown;
}
export interface HostTurnToolContext {
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
export declare function registerHostTurnHook(api: {
    on?: (event: string, handler: (event: unknown, context?: unknown) => unknown) => (() => void) | {
        dispose?: () => void;
    } | undefined;
    logger?: {
        warn?: (message: string) => void;
    };
}, broker: HostTurnAuthorityBroker): () => void;
export declare class HostTurnAuthorityBroker {
    private readonly service;
    private readonly db;
    private readonly now;
    private readonly ttlMs;
    constructor(service: ControlPlaneService, db: DatabaseSync, now?: () => number, ttlMs?: number);
    observe(event: InboundHostTurnEvent, ctx: InboundHostTurnContext): void;
    consume(operation: ControlOperation, changeId: string, context: HostTurnToolContext): Attestation;
    private loadCandidates;
    private claim;
    private required;
}
export {};
//# sourceMappingURL=host-turn-broker.d.ts.map