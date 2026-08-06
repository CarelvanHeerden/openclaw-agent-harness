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
 *   3. The token is stored in the vault as `git-pat:<userid>` (or a configured
 *      pattern) via `credential_store`, validated with `GET /user` first.
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
export interface OnboardingDeps {
    slackToken: string;
    fetchImpl?: typeof fetch;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
}
export interface OnboardResult {
    ok: boolean;
    error?: string;
    value?: string;
}
/**
 * PURE: the vault service name a user's git token is stored under. Mirrors the
 * pat-router's per-user resolution intent. Default `git-pat:<userid>`; an
 * optional pattern may use `{userid}` / `{provider}` placeholders.
 */
export declare function resolveOnboardVaultService(slackUserId: string, opts?: {
    pattern?: string;
    provider?: string;
}): string;
export declare class OnboardingSlack {
    private readonly deps;
    constructor(deps: OnboardingDeps);
    private fetchFn;
    /**
     * Open (or resolve) a DM channel with a user via `conversations.open`.
     * Returns the DM channel id, or { ok:false } on any failure. Never throws.
     */
    openDm(userId: string): Promise<OnboardResult>;
    /** Post a DM message; returns the message ts (so we can delete it later). */
    postDm(channel: string, text: string): Promise<OnboardResult>;
    /**
     * Delete a message the BOT authored (e.g. our own onboarding prompt).
     * A bot token cannot delete a USER's message -- that is why the flow asks
     * the user to delete their own token message. Never throws.
     */
    deleteOwnMessage(channel: string, ts: string): Promise<OnboardResult>;
}
/**
 * Validate a git token against the provider's `GET /user` before storing it,
 * so a bad/expired paste is rejected up front instead of dying mid-run.
 * PURE except for the injected fetch. Never throws.
 */
export declare function validateGitToken(token: string, apiBase: string, fetchImpl?: typeof fetch): Promise<{
    ok: boolean;
    login?: string;
    error?: string;
}>;
//# sourceMappingURL=onboarding.d.ts.map