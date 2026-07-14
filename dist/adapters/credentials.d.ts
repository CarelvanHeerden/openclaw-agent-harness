/**
 * Credential adapter.
 *
 * Fetches PATs (and any other secrets the harness needs) from the OpenClaw
 * hybrid-memory credential vault via the `credential_get` MCP tool that
 * lives on the OpenClaw plugin API surface.
 *
 * We NEVER cache secrets to disk or memory beyond one session. If a session
 * ends (done/failed/aborted), we drop the token from the in-process cache.
 *
 * The adapter also supports a file-based fallback for local dev, controlled
 * by env var `OAH_DEV_CRED_DIR`, where each secret lives at
 * `<dir>/<service>.txt` (mode 0600). Never enable in production.
 */
export interface CredentialAdapterDeps {
    callCredentialGetTool: (input: {
        service: string;
        type?: string;
    }) => Promise<{
        value?: string;
        error?: string;
    }>;
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