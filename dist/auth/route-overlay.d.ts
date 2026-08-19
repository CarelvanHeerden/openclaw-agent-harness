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
/** Org and provider are matched case-insensitively; the router does the same. */
export declare const normaliseOrg: (org: string) => string;
export declare class RouteOverlay implements RouteLookup {
    private readonly db;
    private readonly now;
    constructor(db: DatabaseSync, now?: () => number);
    /**
     * The route for one requester in one org, or undefined.
     *
     * Matched on `slack_user_id` rather than on the person key, because the
     * person key is a label an operator chose and the Slack id is the only thing
     * an inbound request actually carries.
     */
    lookup(provider: GitProvider, org: string, slackUserId: string): CredentialRoute | undefined;
    /** Everything one requester has onboarded, for the management view. */
    listForRequester(slackUserId: string): CredentialRoute[];
    /** Everyone configured for one org. Used to spot a person key already in use. */
    listForOrg(provider: GitProvider, org: string): CredentialRoute[];
    /**
     * Insert or update one route, preserving `created_at` across updates so the
     * management view can show when a credential was first added rather than when
     * it was last rotated.
     */
    upsert(route: Omit<CredentialRoute, "createdAt" | "updatedAt"> & {
        createdAt?: number;
    }): CredentialRoute;
    /** Returns true when a row was actually removed. */
    remove(provider: GitProvider, org: string, person: string): boolean;
}
//# sourceMappingURL=route-overlay.d.ts.map