import { createHash, randomBytes } from "node:crypto";
/** Includes all execution-authority state, excluding routine heartbeat timestamps. */
export function pendingAnswerState(db, sessionId) {
    return db.prepare(`SELECT id, status, requester, requester_gh, crystallised_prompt,
    lead_plan_json, clarification_question, clarification_seq, clarification_id,
    clarification_subtask, clarification_answer, budget_usd, hard_timeout_seconds,
    plan_revision, cycles_ran FROM sessions WHERE id = ?`).get(sessionId);
}
export function answerStateHash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function issueHumanAnswer(db, sessionId, sender) {
    const state = pendingAnswerState(db, sessionId);
    if (!state || state.status !== "awaiting_clarification" || state.requester !== sender) {
        return { text: "No pending question owned by this sender. Nothing changed." };
    }
    // The whole stored authority state is shown, never silently truncated.
    const preview = JSON.stringify(state, null, 2);
    if (preview.length > 24_000)
        return { text: "Pending state is too large for complete command review. Approval is blocked; shorten the brief first." };
    const challenge = randomBytes(24).toString("hex");
    const now = Date.now();
    db.prepare(`INSERT INTO human_answer_challenges (id, session_id, sender, state_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)`).run(challenge, sessionId, sender, answerStateHash(state), now + 10 * 60_000);
    return { text: `Review the complete current pause before answering:\n${preview}\n\nSend this command yourself (not through an agent):\n/harness-answer ${sessionId} ${challenge} <your answer>\n\nValid for ten minutes and one use only. For a revised brief, the answer must be its exact confirm brief <hash>. To propose a correction use revise brief: <correction>. No work has started.` };
}
//# sourceMappingURL=human-answer-command.js.map