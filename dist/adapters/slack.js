/**
 * Slack adapter.
 *
 * The harness uses this adapter only for outbound messages.
 *
 * We prefer to use OpenClaw's built-in messaging pipeline (`api.sendMessage`
 * / hook events) instead of hitting Slack's Web API directly. This keeps
 * routing consistent and lets OpenClaw handle rate limits, redaction, and
 * envelope metadata for us.
 *
 * The adapter is a thin wrapper so tests can inject mocks.
 */
export class SlackAdapter {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async replyInThread(channel, threadTs, text, blocks) {
        return this.deps.sendMessage({ channel, threadTs, text, blocks });
    }
    async postNew(channel, text) {
        return this.deps.sendMessage({ channel, text });
    }
}
//# sourceMappingURL=slack.js.map