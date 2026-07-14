export class SlackChannelListener {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Pure decision function. Given an inbound message + current DB state,
     * decides how to route it. Kept pure so it can be unit-tested without
     * mocking Slack, the SDK, or the DB.
     */
    routeMessage(evt) {
        // Ignore bot, edit, delete, join, leave events
        if (evt.bot_id)
            return { kind: "ignore", reason: "bot_message" };
        if (evt.subtype && evt.subtype !== "thread_broadcast") {
            return { kind: "ignore", reason: `subtype:${evt.subtype}` };
        }
        // Wrong channel
        if (evt.channel !== this.deps.config.slack.channel) {
            return { kind: "ignore", reason: "wrong_channel" };
        }
        // Non-allow-listed user
        if (!this.deps.config.slack.authorised_users.includes(evt.user)) {
            return { kind: "ignore", reason: "unauthorised_user" };
        }
        if (evt.thread_ts) {
            // Reply inside an existing thread. Bind to that thread's session (if any).
            const row = this.deps.state.db
                .prepare(`SELECT id, status FROM sessions WHERE slack_channel = ? AND slack_thread = ?`)
                .get(evt.channel, evt.thread_ts);
            if (!row) {
                // In-thread message but no session yet: only valid if we're mid-
                // crystallisation. For now, be strict and ignore. Prevents accidental
                // "resurrecting" of an old thread.
                return { kind: "ignore", reason: "reply_in_thread_without_session" };
            }
            return {
                kind: "continue_session",
                sessionId: row.id,
                threadTs: evt.thread_ts,
            };
        }
        // Top-level channel post: always starts a fresh thread + fresh session.
        // The thread_ts becomes the message's own ts.
        return { kind: "start_new_session", threadTs: evt.ts };
    }
    async handle(evt) {
        const decision = this.routeMessage(evt);
        this.deps.logger.info("[slack-listener] route", { decision, ts: evt.ts });
        switch (decision.kind) {
            case "ignore":
                return;
            case "start_new_session":
                await this.deps.dispatcher.startNewSession(evt);
                return;
            case "continue_session":
                await this.deps.dispatcher.continueSession(decision.sessionId, evt);
                return;
            case "reject_top_level_reply":
                this.deps.logger.info("[slack-listener] reject_top_level_reply currently unused");
                return;
        }
    }
}
//# sourceMappingURL=channel-listener.js.map