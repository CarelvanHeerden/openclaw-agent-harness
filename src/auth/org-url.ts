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

export type OrgUrlResult = { ok: true; value: ParsedOrgUrl } | { ok: false; error: string };

/** `git@host:org/repo.git`, with or without an explicit ssh:// scheme. */
const SSH_FORM = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/;

/** Anything of the shape `scheme://`, used to spot a URL that needs no help. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Landing-page prefixes that sit in front of the org itself. GitHub writes an
 * org page as /orgs/<name>; GitLab writes a group page as /groups/<name>.
 */
const ORG_PREFIXES = new Set(["orgs", "groups"]);

/**
 * Web hosts that map to each configured provider.
 *
 * `api_base` names the API host, which is not always the host a human copies
 * out of an address bar: github.com serves its API from api.github.com, while
 * gitlab.com serves both from a single host. Accept both forms so either paste
 * resolves.
 */
export function acceptedHosts(
  providers: Partial<Record<GitProvider, ProviderConfig>> | undefined,
): Map<string, GitProvider> {
  const hosts = new Map<string, GitProvider>();
  for (const [name, cfg] of Object.entries(providers ?? {})) {
    if (!cfg?.api_base) continue;
    let hostname: string;
    try {
      hostname = new URL(cfg.api_base).hostname.toLowerCase();
    } catch {
      continue; // A malformed api_base is the config validator's problem, not ours.
    }
    const provider = name as GitProvider;
    hosts.set(hostname, provider);
    // api.github.com -> github.com, and the same for a GitHub Enterprise host.
    if (hostname.startsWith("api.")) hosts.set(hostname.slice("api.".length), provider);
  }
  return hosts;
}

/**
 * Parse an org URL into a provider and an org.
 *
 * Accepts the forms people actually paste: a browser URL, a clone URL, an ssh
 * remote, and a bare `host/org` with no scheme. Returns a refusal rather than
 * throwing, because every caller is a chat-facing tool that wants to explain
 * the problem instead of surfacing a stack trace.
 */
export function parseOrgUrl(
  input: string | undefined,
  providers: Partial<Record<GitProvider, ProviderConfig>> | undefined,
): OrgUrlResult {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "no org URL was given" };

  const hosts = acceptedHosts(providers);
  if (hosts.size === 0) return { ok: false, error: "no git providers are configured" };

  let host: string;
  let path: string;
  const ssh = SSH_FORM.exec(raw);
  if (ssh) {
    host = ssh[1]!;
    path = ssh[2]!;
  } else {
    // A bare "github.com/acme" parses as a relative path without this.
    const withScheme = HAS_SCHEME.test(raw) ? raw : `https://${raw}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return { ok: false, error: `"${raw}" is not a URL` };
    }
    host = url.hostname;
    path = url.pathname;
  }

  const provider = hosts.get(host.toLowerCase());
  if (!provider) {
    const known = [...hosts.keys()].sort().join(", ");
    return {
      ok: false,
      error: `host "${host}" is not a configured git provider (configured: ${known}). ` +
        `Add it under pat_routing.providers before onboarding a token for it.`,
    };
  }

  const segments = path
    .replace(/\.git$/i, "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length > 0 && ORG_PREFIXES.has(segments[0]!.toLowerCase())) segments.shift();

  const first = segments[0];
  if (!first) return { ok: false, error: `"${raw}" names a host but no org` };

  let org: string;
  try {
    org = decodeURIComponent(first);
  } catch {
    org = first; // Malformed escapes: take it literally rather than refusing.
  }
  if (!org) return { ok: false, error: `"${raw}" names a host but no org` };

  return { ok: true, value: { provider, org } };
}
