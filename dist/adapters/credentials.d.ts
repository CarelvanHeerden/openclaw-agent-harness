/**
 * Credential adapter.
 *
 * beta.110: reads from the harness-owned CredentialVault (an in-process library
 * call) rather than the memory-hybrid `credential_get` MCP tool. The vault is
 * deliberately NOT a registered tool, so no agent turn can ask it for a service
 * name -- see adapters/credential-vault.ts.
 *
 * We NEVER cache secrets to disk, and only in memory for the life of a session.
 * If a session ends (done/failed/aborted), we drop the token from the cache.
 *
 * The adapter also supports a file-based fallback for local dev, controlled
 * by env var `OAH_DEV_CRED_DIR`, where each secret lives at
 * `<dir>/<service>.txt` (mode 0600). Never enable in production.
 */
/** The slice of CredentialVault this adapter needs. Keeps tests trivial to fake. */
export interface CredentialSource {
    get: (service: string, type?: "token" | "api_key") => string | undefined;
}
export interface CredentialAdapterDeps {
    vault: CredentialSource;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
}
export declare class CredentialAdapter {
    private readonly deps;
    private readonly cache;
    constructor(deps: CredentialAdapterDeps);
    getToken(service: string, kind?: "token" | "api_key"): Promise<string>;
    /** Purge all cached secrets. Call after a session terminates. */
    purge(): void;
    /** Purge a single service (e.g. one session ending). */
    drop(service: string): void;
}
//# sourceMappingURL=credentials.d.ts.map