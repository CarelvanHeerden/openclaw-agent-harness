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

export interface OnboardingDeps {
  slackToken: string;
  fetchImpl?: typeof fetch;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
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
export function resolveOnboardVaultService(
  slackUserId: string,
  opts?: { pattern?: string; provider?: string },
): string {
  const provider = opts?.provider ?? "github";
  const pattern = opts?.pattern && opts.pattern.trim().length > 0 ? opts.pattern : "git-pat:{userid}";
  return pattern
    .replaceAll("{userid}", slackUserId)
    .replaceAll("{provider}", provider);
}

export interface OnboardConsistency {
  /** False only when we know the written name is unreadable. */
  ok: boolean;
  /** The name onboarding would write. */
  writing: string;
  /** The names sessions would actually look up, de-duplicated. */
  expected: string[];
  /** True when there was nothing to compare against, so no verdict was possible. */
  undetermined: boolean;
}

/**
 * PURE: does the name `harness_onboard` writes match a name the pat-router will
 * later read?
 *
 * beta.133. The two patterns ship with defaults that cannot agree -- onboarding
 * writes `git-pat:{userid}` while resolution reads `github-{owner}` -- and
 * nothing noticed. The token validated, the vault stored it, the tool said it
 * had worked, and the first session died at clone with a "credential not found"
 * for a name the operator had never seen.
 *
 * An empty `expected` means we could not work out what any session would look
 * up (no allow-listed repos, or routing that refused to resolve). That is not
 * evidence of a mismatch, so it reports `ok` with `undetermined` set rather
 * than blocking an onboarding that may well be fine.
 */
export function checkOnboardConsistency(writing: string, expected: readonly string[]): OnboardConsistency {
  const seen = new Set<string>();
  for (const name of expected) {
    const trimmed = name.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  const names = [...seen];
  if (names.length === 0) return { ok: true, writing, expected: [], undetermined: true };
  return { ok: names.includes(writing.trim()), writing, expected: names, undetermined: false };
}

export class OnboardingSlack {
  constructor(private readonly deps: OnboardingDeps) {}

  private fetchFn(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  /**
   * Open (or resolve) a DM channel with a user via `conversations.open`.
   * Returns the DM channel id, or { ok:false } on any failure. Never throws.
   */
  async openDm(userId: string): Promise<OnboardResult> {
    try {
      const res = await this.fetchFn()("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.slackToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ users: userId }),
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const j = (await res.json()) as { ok: boolean; error?: string; channel?: { id?: string } };
      if (!j.ok || !j.channel?.id) return { ok: false, error: j.error ?? "no_channel" };
      return { ok: true, value: j.channel.id };
    } catch (err) {
      this.deps.logger.warn("[onboard] conversations.open failed", { userId, err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /** Post a DM message; returns the message ts (so we can delete it later). */
  async postDm(channel: string, text: string): Promise<OnboardResult> {
    try {
      const res = await this.fetchFn()("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.slackToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text }),
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const j = (await res.json()) as { ok: boolean; error?: string; ts?: string };
      if (!j.ok) return { ok: false, error: j.error ?? "unknown" };
      return { ok: true, value: j.ts };
    } catch (err) {
      this.deps.logger.warn("[onboard] postDm failed", { channel, err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Delete a message the BOT authored (e.g. our own onboarding prompt).
   * A bot token cannot delete a USER's message -- that is why the flow asks
   * the user to delete their own token message. Never throws.
   */
  async deleteOwnMessage(channel: string, ts: string): Promise<OnboardResult> {
    try {
      const res = await this.fetchFn()("https://slack.com/api/chat.delete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.slackToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, ts }),
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!j.ok) return { ok: false, error: j.error ?? "unknown" };
      return { ok: true };
    } catch (err) {
      this.deps.logger.warn("[onboard] chat.delete failed", { channel, err: String(err) });
      return { ok: false, error: String(err) };
    }
  }
}

/**
 * Epoch ms for a token expiry header, or undefined.
 *
 * GitHub discloses a fine-grained PAT's expiry on every response as
 * `github-authentication-token-expiration`, written as
 * `2026-09-01 12:00:00 UTC` rather than as ISO-8601. Recording it lets the
 * management view warn before a token dies mid-run instead of after.
 *
 * Anything unparseable returns undefined: a wrong expiry is worse than none,
 * since it would either cry wolf or hide a real one.
 */
export function parseTokenExpiry(header: string | null | undefined): number | undefined {
  const raw = (header ?? "").trim();
  if (!raw) return undefined;
  // "2026-09-01 12:00:00 UTC" -> "2026-09-01T12:00:00Z". Date.parse handles the
  // ISO form natively, so try it first and only reshape if that fails.
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const reshaped = Date.parse(raw.replace(" ", "T").replace(/\s*UTC$/i, "Z"));
  return Number.isFinite(reshaped) ? reshaped : undefined;
}

export interface GitTokenIdentity {
  ok: boolean;
  /** The account this token authenticates as. Drives the identity check. */
  login?: string;
  /** Display name, used for git commits when the caller gives none. */
  name?: string;
  /** Public email, often absent -- GitHub hides it by default. */
  email?: string;
  /** Epoch ms, when the provider discloses it. */
  expiresAt?: number;
  error?: string;
}

/**
 * Validate a git token against the provider's `GET /user` before storing it,
 * so a bad/expired paste is rejected up front instead of dying mid-run.
 * PURE except for the injected fetch. Never throws.
 *
 * The response is also the cheapest source of truth for WHO the token belongs
 * to, which is what lets a later submission be checked against the account the
 * credential was first stored for.
 */
export async function validateGitToken(
  token: string,
  apiBase: string,
  fetchImpl?: typeof fetch,
): Promise<GitTokenIdentity> {
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
    if (res.status === 401 || res.status === 403) return { ok: false, error: `auth_${res.status}` };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const j = (await res.json()) as { login?: string; name?: string; email?: string; username?: string };
    // `headers` is optional here only because test doubles omit it; a real
    // Response always carries one.
    const expiresAt = parseTokenExpiry(res.headers?.get?.("github-authentication-token-expiration"));
    return {
      ok: true,
      // GitLab calls it `username`; GitHub calls it `login`.
      login: j.login ?? j.username,
      name: j.name ?? undefined,
      email: j.email ?? undefined,
      expiresAt,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Does this token actually reach the repo it will be used on?
 *
 * `GET /user` proves a token is live; it says nothing about whether it can see
 * the org being onboarded. A fine-grained PAT scoped to the wrong org passes
 * validation and then fails at clone, which is the same hour-late failure this
 * whole area exists to prevent.
 *
 * Checked against a CONCRETE allowed repo rather than the org itself, because
 * `GET /orgs/<name>` 404s for a personal namespace and would refuse a perfectly
 * good personal token. Returns "unknown" when there is nothing concrete to
 * check, so an undetermined answer never becomes a refusal.
 */
export async function checkRepoAccess(
  token: string,
  apiBase: string,
  repoFullName: string,
  fetchImpl?: typeof fetch,
): Promise<{ reach: "ok" | "denied" | "unknown"; status?: number; error?: string }> {
  const f = fetchImpl ?? fetch;
  const base = apiBase.replace(/\/+$/, "");
  try {
    const res = await f(`${base}/repos/${repoFullName}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "openclaw-agent-harness",
      },
    });
    if (res.ok) return { reach: "ok", status: res.status };
    // 404 is what GitHub returns for "exists but you cannot see it" as well as
    // "does not exist", and both mean this token cannot work here.
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { reach: "denied", status: res.status };
    }
    return { reach: "unknown", status: res.status };
  } catch (err) {
    // A transport failure is not evidence the token is wrong.
    return { reach: "unknown", error: String(err) };
  }
}

/**
 * The vault name for an onboarded route.
 *
 * Keyed on provider, org AND person, because one person holding different
 * tokens for two orgs is the case a flat per-user name cannot express: the
 * second onboarding would overwrite the first and a run would push with the
 * wrong org's token.
 */
export const onboardRouteService = (provider: string, org: string, person: string): string =>
  `${provider}:${org}:${person}`.toLowerCase();
