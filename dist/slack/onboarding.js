/**
 * Per-user credential onboarding (beta.78, Feature 4).
 *
 * WHY THIS EXISTS
 * ---------------
 * In production the harness runs multi-user with the hybrid-memory vault. Each
 * authorised user needs their OWN git token so PR ops run under their identity
 * (the pat-router already resolves a per-user vault service via
 * `default_service_pattern` with `{requester}`). Onboarding must:
 *   - be invokable ONLY by users in `slack.authorised_users`,
 *   - capture the token PRIVATELY (a DM, never a public channel), and
 *   - keep the operator (Carel) from ever seeing another user's token.
 *
 * DELIVERY MODEL (decided with Carel 2026-07-28): DM FLOW.
 *   1. Authorised user triggers onboarding.
 *   2. The harness opens a DM (`conversations.open`) and posts an instruction
 *      prompt (this module's helpers).
 *   3. The token is stored in the harness credential vault as `git-pat:<userid>`
 *      (or a configured pattern), validated with `GET /user` first. beta.110:
 *      this is a library call on our own vault, not memory-hybrid's tool.
 *   4. The harness deletes ITS OWN prompt (`chat.delete`). A bot token CANNOT
 *      delete the USER's message, so the confirmation asks the user to delete
 *      their token message themselves. (A Slack modal would keep the token out
 *      of chat entirely, but raw modal submission is not exposed to plugins.)
 *
 * SLACK-APP CAVEAT: the `/harness-onboard` slash command must be added to the
 * Slack app manifest (`slash_commands[]`) and the app reinstalled before Slack
 * will route it. That is a one-time host/admin step, documented in the README.
 *
 * This module is pure/side-effect-injected (fetch is injectable) so it is
 * trivially unit-testable and never throws into the run path.
 */
/**
 * PURE: the vault service name a user's git token is stored under. Mirrors the
 * pat-router's per-user resolution intent. Default `git-pat:<userid>`; an
 * optional pattern may use `{userid}` / `{provider}` placeholders.
 */
export function resolveOnboardVaultService(slackUserId, opts) {
    const provider = opts?.provider ?? "github";
    const pattern = opts?.pattern && opts.pattern.trim().length > 0 ? opts.pattern : "git-pat:{userid}";
    return pattern
        .replaceAll("{userid}", slackUserId)
        .replaceAll("{provider}", provider);
}
export class OnboardingSlack {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    fetchFn() {
        return this.deps.fetchImpl ?? fetch;
    }
    /**
     * Open (or resolve) a DM channel with a user via `conversations.open`.
     * Returns the DM channel id, or { ok:false } on any failure. Never throws.
     */
    async openDm(userId) {
        try {
            const res = await this.fetchFn()("https://slack.com/api/conversations.open", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.deps.slackToken}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                body: JSON.stringify({ users: userId }),
            });
            if (!res.ok)
                return { ok: false, error: `http_${res.status}` };
            const j = (await res.json());
            if (!j.ok || !j.channel?.id)
                return { ok: false, error: j.error ?? "no_channel" };
            return { ok: true, value: j.channel.id };
        }
        catch (err) {
            this.deps.logger.warn("[onboard] conversations.open failed", { userId, err: String(err) });
            return { ok: false, error: String(err) };
        }
    }
    /** Post a DM message; returns the message ts (so we can delete it later). */
    async postDm(channel, text) {
        try {
            const res = await this.fetchFn()("https://slack.com/api/chat.postMessage", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.deps.slackToken}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                body: JSON.stringify({ channel, text }),
            });
            if (!res.ok)
                return { ok: false, error: `http_${res.status}` };
            const j = (await res.json());
            if (!j.ok)
                return { ok: false, error: j.error ?? "unknown" };
            return { ok: true, value: j.ts };
        }
        catch (err) {
            this.deps.logger.warn("[onboard] postDm failed", { channel, err: String(err) });
            return { ok: false, error: String(err) };
        }
    }
    /**
     * Delete a message the BOT authored (e.g. our own onboarding prompt).
     * A bot token cannot delete a USER's message -- that is why the flow asks
     * the user to delete their own token message. Never throws.
     */
    async deleteOwnMessage(channel, ts) {
        try {
            const res = await this.fetchFn()("https://slack.com/api/chat.delete", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.deps.slackToken}`,
                    "Content-Type": "application/json; charset=utf-8",
                },
                body: JSON.stringify({ channel, ts }),
            });
            if (!res.ok)
                return { ok: false, error: `http_${res.status}` };
            const j = (await res.json());
            if (!j.ok)
                return { ok: false, error: j.error ?? "unknown" };
            return { ok: true };
        }
        catch (err) {
            this.deps.logger.warn("[onboard] chat.delete failed", { channel, err: String(err) });
            return { ok: false, error: String(err) };
        }
    }
}
/**
 * Validate a git token against the provider's `GET /user` before storing it,
 * so a bad/expired paste is rejected up front instead of dying mid-run.
 * PURE except for the injected fetch. Never throws.
 */
export async function validateGitToken(token, apiBase, fetchImpl) {
    const f = fetchImpl ?? fetch;
    const base = apiBase.replace(/\/+$/, "");
    try {
        const res = await f(`${base}/user`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "openclaw-agent-harness",
            },
        });
        if (res.status === 401 || res.status === 403)
            return { ok: false, error: `auth_${res.status}` };
        if (!res.ok)
            return { ok: false, error: `http_${res.status}` };
        const j = (await res.json());
        return { ok: true, login: j.login };
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
//# sourceMappingURL=onboarding.js.map