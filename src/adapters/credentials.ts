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

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CredentialAdapterDeps {
  callCredentialGetTool: (input: { service: string; type?: string }) => Promise<{ value?: string; error?: string }>;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}

export class CredentialAdapter {
  private readonly cache = new Map<string, string>();

  constructor(private readonly deps: CredentialAdapterDeps) {}

  async getToken(service: string, kind: "token" | "api_key" = "token"): Promise<string> {
    if (this.cache.has(service)) return this.cache.get(service)!;

    const devDir = process.env.OAH_DEV_CRED_DIR;
    if (devDir) {
      try {
        const v = (await readFile(join(devDir, `${service}.txt`), "utf8")).trim();
        if (v) {
          this.cache.set(service, v);
          this.deps.logger.warn("[cred] dev-mode file lookup (do not use in prod)", { service });
          return v;
        }
      } catch { /* fall through */ }
    }

    const r = await this.deps.callCredentialGetTool({ service, type: kind });
    if (!r.value) {
      throw new Error(`credential '${service}' not found in vault (${r.error ?? "no value"})`);
    }
    this.cache.set(service, r.value);
    return r.value;
  }

  /** Purge all cached secrets. Call after a session terminates. */
  purge(): void {
    this.cache.clear();
  }

  /** Purge a single service (e.g. one session ending). */
  drop(service: string): void {
    this.cache.delete(service);
  }
}
