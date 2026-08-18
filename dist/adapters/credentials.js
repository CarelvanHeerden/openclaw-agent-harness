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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export class CredentialAdapter {
    deps;
    cache = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    async getToken(service, kind = "token") {
        if (this.cache.has(service))
            return this.cache.get(service);
        const devDir = process.env.OAH_DEV_CRED_DIR;
        if (devDir) {
            try {
                const v = (await readFile(join(devDir, `${service}.txt`), "utf8")).trim();
                if (v) {
                    this.cache.set(service, v);
                    this.deps.logger.warn("[cred] dev-mode file lookup (do not use in prod)", { service });
                    return v;
                }
            }
            catch { /* fall through */ }
        }
        const value = this.deps.vault.get(service, kind);
        if (!value) {
            throw new Error(`credential '${service}' not found in vault`);
        }
        this.cache.set(service, value);
        return value;
    }
    /** Purge all cached secrets. Call after a session terminates. */
    purge() {
        this.cache.clear();
    }
    /** Purge a single service (e.g. one session ending). */
    drop(service) {
        this.cache.delete(service);
    }
}
//# sourceMappingURL=credentials.js.map