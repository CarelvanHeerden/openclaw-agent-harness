import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
export interface BriefState {
    sessionId: string;
    brief: CrystallisedBrief;
    budgetUsd: number;
    hardTimeoutSeconds: number;
}
export interface BriefProposal extends BriefState {
    version: 1;
    nonce: string;
    baseHash: string;
}
export declare function briefStateHash(value: unknown): string;
export declare function makeBriefProposal(base: BriefState, correction: string, limits: {
    budgetUsd?: number;
    hardTimeoutSeconds?: number;
}): BriefProposal;
export declare function renderBriefProposal(proposal: BriefProposal): string;
/** Both the stored payload and its base must still be exactly what was reviewed. */
export declare function verifyBriefProposal(proposal: BriefProposal, suppliedHash: string, base: BriefState, ceiling?: number): boolean;
//# sourceMappingURL=brief-proposal.d.ts.map