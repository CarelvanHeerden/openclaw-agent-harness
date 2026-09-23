import { createHash, randomUUID } from "node:crypto";
export function briefStateHash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function makeBriefProposal(base, correction, limits) {
    if (!correction.trim() || correction.length > 8_000) {
        throw new Error("A brief revision must contain 1–8,000 characters of correction text.");
    }
    const brief = structuredClone(base.brief);
    brief.acceptanceCriteria = [...brief.acceptanceCriteria,
        `OPERATOR CORRECTION TO THIS BRIEF: ${correction}. This supersedes conflicting feature requirements; all other restrictions remain in force.`];
    const proposal = {
        ...base,
        brief,
        ...limits,
        version: 1,
        nonce: randomUUID(),
        baseHash: briefStateHash(base),
    };
    return proposal;
}
export function renderBriefProposal(proposal) {
    const hash = briefStateHash(proposal);
    return [
        "No work has started. The complete revised proposal is stored with the current pause.",
        `Review the complete stored proposal in this authenticated OpenClaw conversation before confirming it. OpenClaw binds the reply to session ${proposal.sessionId} and the current pause.`,
        `After that complete review, start exactly this proposal with: confirm brief ${hash}`,
        "A plain confirm will not activate a revised proposal. To replace it, send revise brief: <correction, optionally with budget/time controls>. Revisions are based on the original brief, not an unapproved proposal.",
    ].join("\n\n");
}
/** Both the stored payload and its base must still be exactly what was reviewed. */
export function verifyBriefProposal(proposal, suppliedHash, base, ceiling) {
    return proposal?.version === 1 &&
        typeof proposal.nonce === "string" && proposal.nonce.length > 0 &&
        proposal.sessionId === base.sessionId &&
        proposal.baseHash === briefStateHash(base) &&
        suppliedHash === briefStateHash(proposal) &&
        !!proposal.brief && Array.isArray(proposal.brief.acceptanceCriteria) &&
        Number.isFinite(proposal.budgetUsd) && proposal.budgetUsd > 0 &&
        (ceiling === undefined || ceiling <= 0 || proposal.budgetUsd <= ceiling) &&
        Number.isFinite(proposal.hardTimeoutSeconds) && proposal.hardTimeoutSeconds > 0 &&
        proposal.hardTimeoutSeconds <= 24 * 3600;
}
//# sourceMappingURL=brief-proposal.js.map