/**
 * beta.110: HARNESS-OWNED CREDENTIAL VAULT.
 *
 * Replaces the memory-hybrid `credential_get` / `credential_store` MCP tools.
 * Two reasons the dependency had to go, and only the first was the ask:
 *
 *   1. It coupled the harness to a plugin we are retiring. A memory backend and
 *      a secret store are different products with different threat models, and
 *      the next memory backend is a retrieval system for agents -- precisely
 *      where a PAT must never live.
 *   2. Reaching secrets through a TOOL means any turn that can call tools can
 *      ask for an arbitrary service name. This vault is a library call. No LLM
 *      turn can reach it, because there is nothing registered to reach.
 *
 * Storage is a DEDICATED SQLite file, not the harness state DB. State DBs get
 * copied around for debugging; secrets must not ride along. The ciphertext is
 * useless without the key, which lives outside the DB FILE.
 *
 * rc.3, after an external review read the previous wording as a stronger claim
 * than it is: by default the key file lives in the same DIRECTORY as the
 * ciphertext (`<dir>/vault.key` next to `<dir>/vault.db`, both under the
 * harness data dir, the key at 0600 and the dir at 0700). So the default
 * defends against the threat it was built for -- a state DB copied off the box
 * for debugging takes no secrets with it -- and does NOT defend against anyone
 * who can read the harness data dir, because they get both halves.
 *
 * Set `$OAH_VAULT_KEY_FILE` to a path outside the data dir, or `$OAH_VAULT_KEY`
 * to inject the key from a secret manager, if you need at-rest protection
 * against data-dir read. Starting the harness is deliberately NOT gated on
 * this: refusing to open a vault that thousands of existing installs are
 * already using would turn a documentation problem into an outage.
 *
 * Crypto: AES-256-GCM, a fresh 96-bit IV per write, 128-bit auth tag. The
 * SERVICE NAME is bound in as additional authenticated data, so ciphertext
 * cannot be moved between rows -- an attacker with write access to the DB
 * cannot promote the `github-readonly` row into `github-admin`.
 */
/** Default env var carrying a raw key; overrides the key file when set. */
export declare const VAULT_KEY_ENV = "OAH_VAULT_KEY";
/** Default env var carrying an explicit key-file path. */
export declare const VAULT_KEY_FILE_ENV = "OAH_VAULT_KEY_FILE";
export interface VaultLogger {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
}
export interface CredentialVaultOptions {
    /** Directory holding `vault.db` and (unless overridden) `vault.key`. Created 0700 if absent. */
    dir: string;
    /** Env var name checked for a raw key. Default `OAH_VAULT_KEY`. */
    keyEnvVar?: string;
    /** Explicit key-file path. Defaults to `<dir>/vault.key`, or `$OAH_VAULT_KEY_FILE`. */
    keyFile?: string;
    logger: VaultLogger;
    /**
     * Audit sink. Called with the SERVICE NAME and never the value, so a vault
     * read is traceable without the audit log becoming a second copy of the
     * secret store.
     */
    audit?: (event: string, payload: Record<string, unknown>) => void;
}
export interface CredentialRecord {
    service: string;
    type: string;
    notes?: string;
    createdAt: number;
    updatedAt: number;
}
/** Thrown when the key cannot decrypt the vault -- a wrong or rotated-away key. */
export declare class VaultKeyError extends Error {
    constructor(message: string);
}
/**
 * Accept hex (64 chars) or base64 (44 chars). Operators paste keys from
 * different tooling and a silently-truncated key would encrypt happily and
 * fail to decrypt later, so anything that is not exactly 32 bytes is rejected.
 */
export declare function parseVaultKey(raw: string, source: string): Buffer;
export declare function generateVaultKey(): Buffer;
export declare class CredentialVault {
    private readonly opts;
    private readonly db;
    private key;
    /** Where the active key came from. Rotation is refused for `env` (see rotate). */
    readonly keySource: "env" | "file" | "generated";
    readonly keyFilePath: string;
    readonly dbPath: string;
    private constructor();
    static open(opts: CredentialVaultOptions): CredentialVault;
    /**
     * Confirm the active key matches the vault BEFORE any read is attempted. A
     * wrong key would otherwise surface as a per-service "not found", sending the
     * operator hunting for a missing entry when the real fault is the key.
     */
    private verifyKey;
    private describeKeySource;
    /** Resolve a secret. Returns undefined when absent; throws only on a broken vault. */
    get(service: string, type?: "token" | "api_key"): string | undefined;
    /** Store (or replace) a secret. */
    set(service: string, value: string, opts?: {
        type?: string;
        notes?: string;
    }): void;
    delete(service: string): boolean;
    /** Metadata for every stored credential. Deliberately never returns values. */
    list(): CredentialRecord[];
    /**
     * Re-encrypt every entry under a fresh key.
     *
     * The new key file is written BEFORE the transaction commits and renamed into
     * place after, so an interruption leaves either the old key with the old
     * ciphertext or the new key on disk next to the new ciphertext -- never a
     * committed vault whose only key was lost to a failed write.
     *
     * Refused when the active key came from the environment: re-encrypting to a
     * file key while the env var still overrides it would brick the vault on the
     * next boot.
     */
    rotate(): {
        rotated: number;
        keyFilePath: string;
    };
    close(): void;
}
//# sourceMappingURL=credential-vault.d.ts.map