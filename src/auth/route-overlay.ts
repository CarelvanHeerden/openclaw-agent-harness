/**
 * Credential route overlay.
 *
 * The routing tree `pat_routing.<provider>.<org>.<person>` lives in plugin
 * config, which is read-only at runtime. `harness_onboard` could therefore
 * store a secret but nothing that told the router to use it -- the token landed
 * in the vault under a name no session looked up, every step reported success,
 * and the run died at clone.
 *
 * This is the missing half: the routing entry onboarding writes. `PatRouter`
 * merges it BENEATH config, so a hand-written tree always wins and a chat
 * message can never silently override an operator.
 *
 * Holds NO secret. A row NAMES a vault entry (`vaultService`); the token itself
 * lives in the credential vault, a separate database under a separate key.
 *
 * Synchronous throughout, because `PatRouter.resolve()` is synchronous and
 * `node:sqlite` is too.
 */

import type { DatabaseSync } from "node:sqlite";

import type { GitProvider } from "../config.js";

export interface CredentialRoute {
  provider: GitProvider;
  /** Repo owner. Always stored and compared lower-cased. */
  org: string;
  /** Person key, as it would read in a config tree. */
  person: string;
  /** The authoritative link from an inbound request to this person. */
  slackUserId: string;
  commitName: string;
  commitEmail: string;
  /** Names the vault entry holding the token. Never the token. */
  vaultService: string;
  /** The login this token authenticated as, recorded so a later swap can be refused. */
  providerLogin?: string;
  /** Epoch ms, when the provider discloses an expiry. */
  tokenExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * The read half, kept separate so `PatRouter` can depend on a lookup without
 * depending on a database.
 */
export interface RouteLookup {
  lookup(provider: GitProvider, org: string, slackUserId: string): CredentialRoute | undefined;
}

interface RouteRow {
  provider: string;
  org: string;
  person: string;
  slack_user_id: string;
  commit_name: string;
  commit_email: string;
  vault_service: string;
  provider_login: string | null;
  token_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Org and provider are matched case-insensitively; the router does the same. */
export const normaliseOrg = (org: string): string => org.trim().toLowerCase();

const toRoute = (r: RouteRow): CredentialRoute => ({
  provider: r.provider as GitProvider,
  org: r.org,
  person: r.person,
  slackUserId: r.slack_user_id,
  commitName: r.commit_name,
  commitEmail: r.commit_email,
  vaultService: r.vault_service,
  providerLogin: r.provider_login ?? undefined,
  tokenExpiresAt: r.token_expires_at ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SELECT_COLUMNS =
  "provider, org, person, slack_user_id, commit_name, commit_email, vault_service, " +
  "provider_login, token_expires_at, created_at, updated_at";

export class RouteOverlay implements RouteLookup {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The route for one requester in one org, or undefined.
   *
   * Matched on `slack_user_id` rather than on the person key, because the
   * person key is a label an operator chose and the Slack id is the only thing
   * an inbound request actually carries.
   */
  lookup(provider: GitProvider, org: string, slackUserId: string): CredentialRoute | undefined {
    const row = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM credential_routes ` +
          "WHERE provider = ? AND org = ? AND slack_user_id = ?",
      )
      .get(provider, normaliseOrg(org), slackUserId) as RouteRow | undefined;
    return row ? toRoute(row) : undefined;
  }

  /** Everything one requester has onboarded, for the management view. */
  listForRequester(slackUserId: string): CredentialRoute[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM credential_routes WHERE slack_user_id = ? ORDER BY provider, org`)
      .all(slackUserId) as unknown as RouteRow[];
    return rows.map(toRoute);
  }

  /** Everyone configured for one org. Used to spot a person key already in use. */
  listForOrg(provider: GitProvider, org: string): CredentialRoute[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM credential_routes WHERE provider = ? AND org = ? ORDER BY person`)
      .all(provider, normaliseOrg(org)) as unknown as RouteRow[];
    return rows.map(toRoute);
  }

  /**
   * Insert or update one route, preserving `created_at` across updates so the
   * management view can show when a credential was first added rather than when
   * it was last rotated.
   */
  upsert(
    route: Omit<CredentialRoute, "createdAt" | "updatedAt"> & { createdAt?: number },
  ): CredentialRoute {
    const org = normaliseOrg(route.org);
    const ts = this.now();
    const existing = this.db
      .prepare("SELECT created_at FROM credential_routes WHERE provider = ? AND org = ? AND person = ?")
      .get(route.provider, org, route.person) as { created_at: number } | undefined;
    const createdAt = existing?.created_at ?? route.createdAt ?? ts;

    this.db
      .prepare(
        "INSERT OR REPLACE INTO credential_routes " +
          "(provider, org, person, slack_user_id, commit_name, commit_email, vault_service, " +
          "provider_login, token_expires_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        route.provider,
        org,
        route.person,
        route.slackUserId,
        route.commitName,
        route.commitEmail,
        route.vaultService,
        route.providerLogin ?? null,
        route.tokenExpiresAt ?? null,
        createdAt,
        ts,
      );

    return { ...route, org, createdAt, updatedAt: ts };
  }

  /** Returns true when a row was actually removed. */
  remove(provider: GitProvider, org: string, person: string): boolean {
    const r = this.db
      .prepare("DELETE FROM credential_routes WHERE provider = ? AND org = ? AND person = ?")
      .run(provider, normaliseOrg(org), person);
    return Number(r.changes ?? 0) > 0;
  }
}
