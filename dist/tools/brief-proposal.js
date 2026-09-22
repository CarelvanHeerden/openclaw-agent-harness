import { createHash, randomUUID } from "node:crypto";
export function briefStateHash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Keep the complete proposal visible, never approve a truncated preview. */
const MAX_PROPOSAL_CHARS = 24_000;
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
    if (JSON.stringify(proposal, null, 2).length > MAX_PROPOSAL_CHARS) {
        throw new Error("The complete revised brief is too large to display safely; shorten the brief before proposing a revision.");
    }
    return proposal;
}
export function renderBriefProposal(proposal) {
    return [
        "No work has started. Review this complete stored proposal (budget is a warning target, timeout is active-work seconds):",
        JSON.stringify(proposal, null, 2),
        `To start exactly this proposal, use this answer in your direct /harness-answer command: confirm brief ${briefStateHash(proposal)}`,
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
        proposal.hardTimeoutSeconds <= 24 * 3600 &&
        JSON.stringify(proposal, null, 2).length <= MAX_PROPOSAL_CHARS;
}
//# sourceMappingURL=brief-proposal.js.map