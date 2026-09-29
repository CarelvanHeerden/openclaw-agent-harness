import { type AuthorityDecision, type AuthorityEnvelope, type AuthorityRequest, type ControlRun } from "./types.js";
export interface AuthorityNonceStore {
    consume(nonce: string, envelopeDigest: string, consumedAt: number): boolean;
}
export declare function authorityEnvelopeDigest(envelope: AuthorityEnvelope): string;
export declare function executionAuthorityEnvelope(run: ControlRun): AuthorityEnvelope | undefined;
export declare function executionAuthorityDigest(run: ControlRun): string | undefined;
export declare function createAuthorityEnvelope(input: AuthorityEnvelope): AuthorityEnvelope;
export declare function evaluateAuthority(envelope: AuthorityEnvelope, request: AuthorityRequest, nonceStore?: AuthorityNonceStore): AuthorityDecision;
//# sourceMappingURL=authority.d.ts.map