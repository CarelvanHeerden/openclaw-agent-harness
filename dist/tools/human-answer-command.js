import { createHash, randomBytes } from "node:crypto";
import { listenerLooksAlive } from "../orchestrator/time-extension.js";
const REVIEW_PAGE_CHARS = 12_000;
/** Includes all execution-authority state, excluding routine heartbeat timestamps. */
export function pendingAnswerState(db, sessionId) {
    const row = db.prepare(`SELECT id, status, requester, requester_gh, crystallised_prompt,
    lead_plan_json, clarification_question, clarification_seq, clarification_id,
    clarification_subtask, clarification_answer, budget_usd, hard_timeout_seconds,
    plan_revision, cycles_ran, clarification_heartbeat_at, final_pr_url, pr_number,
    branch, cost_usd FROM sessions WHERE id = ?`).get(sessionId);
    if (!row)
        return undefined;
    const { clarification_heartbeat_at: heartbeatAt, ...stable } = row;
    return { ...stable, clarification_listener_alive: listenerLooksAlive(heartbeatAt) };
}
export function answerStateHash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function textHash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function parseJson(value) {
    if (typeof value !== "string" || value.length === 0)
        return value ?? null;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
/**
 * Show everything that can affect THIS decision without dumping every unrelated
 * plan task into Slack. The receipt still hashes the complete persisted state,
 * including the full lead_plan_json, so omitted plan tasks cannot change after
 * review. Large decision payloads are paged rather than rejected.
 */
export function pendingAnswerReview(state) {
    const plan = parseJson(state.lead_plan_json);
    const subTasks = plan && typeof plan === "object" && Array.isArray(plan.subTasks) ? plan.subTasks : [];
    const seq = state.clarification_seq;
    const matchingTasks = subTasks.filter((task) => task?.seq === seq);
    const planMetadata = plan && typeof plan === "object"
        ? Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "subTasks"))
        : null;
    const review = {
        session_id: state.id,
        status: state.status,
        requester: state.requester,
        requester_gh: state.requester_gh,
        decision: {
            question: state.clarification_question,
            clarification_seq: state.clarification_seq,
            clarification_id: state.clarification_id,
            paused_context: parseJson(state.clarification_subtask),
            prior_answer: state.clarification_answer,
        },
        governing_brief: parseJson(state.crystallised_prompt),
        execution_limits: {
            budget_usd: state.budget_usd,
            hard_timeout_seconds: state.hard_timeout_seconds,
            plan_revision: state.plan_revision,
            cycles_ran: state.cycles_ran,
            cost_usd: state.cost_usd,
        },
        recovery_context: {
            clarification_listener_alive: state.clarification_listener_alive,
            final_pr_url: state.final_pr_url,
            pr_number: state.pr_number,
            branch: state.branch,
        },
        lead_plan_context: state.lead_plan_json ? {
            full_plan_sha256: textHash(state.lead_plan_json),
            full_state_chars: state.lead_plan_json.length,
            total_subtasks: subTasks.length,
            omitted_unrelated_subtasks: Math.max(0, subTasks.length - matchingTasks.length),
            matching_subtasks: matchingTasks,
            plan_metadata: planMetadata,
        } : null,
    };
    return JSON.stringify(review, null, 2);
}
export function reviewPages(state) {
    const text = pendingAnswerReview(state);
    const pages = [];
    for (let offset = 0; offset < text.length; offset += REVIEW_PAGE_CHARS) {
        pages.push(text.slice(offset, offset + REVIEW_PAGE_CHARS));
    }
    return pages.length > 0 ? pages : [""];
}
export function renderHumanAnswerReview(state, sessionId, challenge, page) {
    const pages = reviewPages(state);
    if (!Number.isInteger(page) || page < 1 || page > pages.length) {
        return { text: `Review page must be between 1 and ${pages.length}. Nothing changed.` };
    }
    const next = page < pages.length
        ? `\n\nContinue the same state-bound review:\n/harness-answer ${sessionId} ${challenge} review ${page + 1}`
        : `\n\nReview complete. Send this command yourself (not through an agent):\n/harness-answer ${sessionId} ${challenge} <your answer>`;
    return { text: `Review the complete current decision (page ${page}/${pages.length}):\n${pages[page - 1]}${next}\n\nThis review is bound to the full persisted state, including the complete lead plan. Valid for ten minutes and one use only. For a revised brief, the answer must be its exact confirm brief <hash>. To propose a correction use revise brief: <correction>.` };
}
export function issueHumanAnswer(db, sessionId, sender) {
    const state = pendingAnswerState(db, sessionId);
    if (!state || state.status !== "awaiting_clarification" || state.requester !== sender) {
        return { text: "No pending question owned by this sender. Nothing changed." };
    }
    const pages = reviewPages(state);
    const challenge = randomBytes(24).toString("hex");
    const now = Date.now();
    db.prepare(`INSERT INTO human_answer_challenges
    (id, session_id, sender, state_hash, expires_at, review_page_count, reviewed_through)
    VALUES (?, ?, ?, ?, ?, ?, 1)`).run(challenge, sessionId, sender, answerStateHash(state), now + 10 * 60_000, pages.length);
    return renderHumanAnswerReview(state, sessionId, challenge, 1);
}
//# sourceMappingURL=human-answer-command.js.map