/**
 * Org URL parsing for credential onboarding.
 *
 * `harness_onboard` asks for an org URL rather than a bare org name because the
 * URL states the provider as well: "https://github.com/stitch-vercel" says both
 * "github" and "stitch-vercel", where "stitch-vercel" on its own says neither.
 * A person holding tokens on two providers otherwise has no way to express
 * which one they are pasting.
 *
 * Accepted hosts are DERIVED from the configured providers rather than
 * hard-coded, so a self-hosted GitLab is accepted exactly when an operator has
 * configured it. An unrecognised host is refused rather than guessed: inferring
 * a provider from an unknown host would send someone's token to an API the
 * operator never approved.
 *
 * Pure -- no network, no config mutation -- so it is trivially unit-testable
 * and safe to log.
 */
import type { GitProvider, ProviderConfig } from "../config.js";
export interface ParsedOrgUrl {
    provider: GitProvider;
    /**
     * Repo owner / org exactly as written, so a confirmation can echo back what
     * the user typed. Callers that key storage off this must normalise case
     * themselves; `PatRouter` matches an org as either the literal key or its
     * lower-cased form.
     */
    org: string;
}
export type OrgUrlResult = {
    ok: true;
    value: ParsedOrgUrl;
} | {
    ok: false;
    error: string;
};
/**
 * Web hosts that map to each configured provider.
 *
 * `api_base` names the API host, which is not always the host a human copies
 * out of an address bar: github.com serves its API from api.github.com, while
 * gitlab.com serves both from a single host. Accept both forms so either paste
 * resolves.
 */
export declare function acceptedHosts(providers: Partial<Record<GitProvider, ProviderConfig>> | undefined): Map<string, GitProvider>;
/**
 * Parse an org URL into a provider and an org.
 *
 * Accepts the forms people actually paste: a browser URL, a clone URL, an ssh
 * remote, and a bare `host/org` with no scheme. Returns a refusal rather than
 * throwing, because every caller is a chat-facing tool that wants to explain
 * the problem instead of surfacing a stack trace.
 */
export declare function parseOrgUrl(input: string | undefined, providers: Partial<Record<GitProvider, ProviderConfig>> | undefined): OrgUrlResult;
//# sourceMappingURL=org-url.d.ts.map