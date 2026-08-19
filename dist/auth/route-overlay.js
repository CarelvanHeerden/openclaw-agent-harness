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
/** Org and provider are matched case-insensitively; the router does the same. */
export const normaliseOrg = (org) => org.trim().toLowerCase();
const toRoute = (r) => ({
    provider: r.provider,
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
const SELECT_COLUMNS = "provider, org, person, slack_user_id, commit_name, commit_email, vault_service, " +
    "provider_login, token_expires_at, created_at, updated_at";
export class RouteOverlay {
    db;
    now;
    constructor(db, now = () => Date.now()) {
        this.db = db;
        this.now = now;
    }
    /**
     * The route for one requester in one org, or undefined.
     *
     * Matched on `slack_user_id` rather than on the person key, because the
     * person key is a label an operator chose and the Slack id is the only thing
     * an inbound request actually carries.
     */
    lookup(provider, org, slackUserId) {
        const row = this.db
            .prepare(`SELECT ${SELECT_COLUMNS} FROM credential_routes ` +
            "WHERE provider = ? AND org = ? AND slack_user_id = ?")
            .get(provider, normaliseOrg(org), slackUserId);
        return row ? toRoute(row) : undefined;
    }
    /** Everything one requester has onboarded, for the management view. */
    listForRequester(slackUserId) {
        const rows = this.db
            .prepare(`SELECT ${SELECT_COLUMNS} FROM credential_routes WHERE slack_user_id = ? ORDER BY provider, org`)
            .all(slackUserId);
        return rows.map(toRoute);
    }
    /** Everyone configured for one org. Used to spot a person key already in use. */
    listForOrg(provider, org) {
        const rows = this.db
            .prepare(`SELECT ${SELECT_COLUMNS} FROM credential_routes WHERE provider = ? AND org = ? ORDER BY person`)
            .all(provider, normaliseOrg(org));
        return rows.map(toRoute);
    }
    /**
     * Insert or update one route, preserving `created_at` across updates so the
     * management view can show when a credential was first added rather than when
     * it was last rotated.
     */
    upsert(route) {
        const org = normaliseOrg(route.org);
        const ts = this.now();
        const existing = this.db
            .prepare("SELECT created_at FROM credential_routes WHERE provider = ? AND org = ? AND person = ?")
            .get(route.provider, org, route.person);
        const createdAt = existing?.created_at ?? route.createdAt ?? ts;
        this.db
            .prepare("INSERT OR REPLACE INTO credential_routes " +
            "(provider, org, person, slack_user_id, commit_name, commit_email, vault_service, " +
            "provider_login, token_expires_at, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(route.provider, org, route.person, route.slackUserId, route.commitName, route.commitEmail, route.vaultService, route.providerLogin ?? null, route.tokenExpiresAt ?? null, createdAt, ts);
        return { ...route, org, createdAt, updatedAt: ts };
    }
    /** Returns true when a row was actually removed. */
    remove(provider, org, person) {
        const r = this.db
            .prepare("DELETE FROM credential_routes WHERE provider = ? AND org = ? AND person = ?")
            .run(provider, normaliseOrg(org), person);
        return Number(r.changes ?? 0) > 0;
    }
}
//# sourceMappingURL=route-overlay.js.map