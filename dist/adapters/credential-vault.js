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
 * copied around for debugging; secrets must not ride along. The file is useless
 * without the key, which lives outside it.
 *
 * Crypto: AES-256-GCM, a fresh 96-bit IV per write, 128-bit auth tag. The
 * SERVICE NAME is bound in as additional authenticated data, so ciphertext
 * cannot be moved between rows -- an attacker with write access to the DB
 * cannot promote the `github-readonly` row into `github-admin`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
/** Default env var carrying a raw key; overrides the key file when set. */
export const VAULT_KEY_ENV = "OAH_VAULT_KEY";
/** Default env var carrying an explicit key-file path. */
export const VAULT_KEY_FILE_ENV = "OAH_VAULT_KEY_FILE";
const KEY_BYTES = 32;
const IV_BYTES = 12;
/** Known plaintext sealed under the active key so a wrong key fails loudly at open, not at first use. */
const VERIFIER_PLAINTEXT = "openclaw-agent-harness/vault/v1";
const VERIFIER_KEY = "verifier";
/** Thrown when the key cannot decrypt the vault -- a wrong or rotated-away key. */
export class VaultKeyError extends Error {
    constructor(message) {
        super(message);
        this.name = "VaultKeyError";
    }
}
function seal(key, plaintext, aad) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ct.toString("base64") };
}
function unseal(key, row, aad) {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
/**
 * Accept hex (64 chars) or base64 (44 chars). Operators paste keys from
 * different tooling and a silently-truncated key would encrypt happily and
 * fail to decrypt later, so anything that is not exactly 32 bytes is rejected.
 */
export function parseVaultKey(raw, source) {
    const s = raw.trim();
    if (!s)
        throw new VaultKeyError(`vault key from ${source} is empty`);
    let buf;
    if (/^[0-9a-fA-F]{64}$/.test(s))
        buf = Buffer.from(s, "hex");
    else {
        try {
            const b = Buffer.from(s, "base64");
            if (b.length === KEY_BYTES)
                buf = b;
        }
        catch { /* fall through to the length error below */ }
    }
    if (!buf || buf.length !== KEY_BYTES) {
        throw new VaultKeyError(`vault key from ${source} must be ${KEY_BYTES} bytes as 64 hex chars or base64; got ${s.length} chars`);
    }
    return buf;
}
export function generateVaultKey() {
    return randomBytes(KEY_BYTES);
}
/** Write a key file atomically at mode 0600, never leaving a readable partial. */
function writeKeyFile(path, key) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${key.toString("hex")}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}
export class CredentialVault {
    opts;
    db;
    key;
    /** Where the active key came from. Rotation is refused for `env` (see rotate). */
    keySource;
    keyFilePath;
    dbPath;
    constructor(db, key, keySource, keyFilePath, dbPath, opts) {
        this.opts = opts;
        this.db = db;
        this.key = key;
        this.keySource = keySource;
        this.keyFilePath = keyFilePath;
        this.dbPath = dbPath;
    }
    static open(opts) {
        const dir = resolve(opts.dir.replace(/^~/, process.env.HOME ?? ""));
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const keyEnvVar = opts.keyEnvVar ?? VAULT_KEY_ENV;
        const keyFilePath = resolve(opts.keyFile ?? process.env[VAULT_KEY_FILE_ENV] ?? join(dir, "vault.key"));
        // Env wins over file: a container injects the key without a mounted volume,
        // and an operator overriding at runtime must not be silently ignored.
        let key;
        let keySource;
        const fromEnv = process.env[keyEnvVar];
        if (fromEnv && fromEnv.trim()) {
            key = parseVaultKey(fromEnv, `$${keyEnvVar}`);
            keySource = "env";
        }
        else if (existsSync(keyFilePath)) {
            key = parseVaultKey(readFileSync(keyFilePath, "utf8"), keyFilePath);
            keySource = "file";
            const mode = statSync(keyFilePath).mode & 0o777;
            if (mode !== 0o600) {
                chmodSync(keyFilePath, 0o600);
                opts.logger.warn("[vault] key file had loose permissions; tightened to 0600", { keyFilePath, was: mode.toString(8) });
            }
        }
        else {
            // First boot. Production installs start empty, so generating beats
            // failing and demanding a manual step before the harness can run.
            key = generateVaultKey();
            writeKeyFile(keyFilePath, key);
            keySource = "generated";
            opts.logger.warn("[vault] no key found; generated a new one. BACK THIS FILE UP -- without it every stored credential is unrecoverable.", { keyFilePath });
        }
        const dbPath = join(dir, "vault.db");
        const db = new DatabaseSync(dbPath);
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        service    TEXT PRIMARY KEY,
        type       TEXT NOT NULL DEFAULT 'token',
        iv         TEXT NOT NULL,
        tag        TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        notes      TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_meta (
        k          TEXT PRIMARY KEY,
        iv         TEXT NOT NULL,
        tag        TEXT NOT NULL,
        ciphertext TEXT NOT NULL
      );
    `);
        if (existsSync(dbPath)) {
            try {
                chmodSync(dbPath, 0o600);
            }
            catch { /* best effort; WAL siblings inherit the dir mode */ }
        }
        const vault = new CredentialVault(db, key, keySource, keyFilePath, dbPath, opts);
        vault.verifyKey();
        return vault;
    }
    /**
     * Confirm the active key matches the vault BEFORE any read is attempted. A
     * wrong key would otherwise surface as a per-service "not found", sending the
     * operator hunting for a missing entry when the real fault is the key.
     */
    verifyKey() {
        const row = this.db
            .prepare("SELECT iv, tag, ciphertext FROM vault_meta WHERE k = ?")
            .get(VERIFIER_KEY);
        if (!row) {
            const sealed = seal(this.key, VERIFIER_PLAINTEXT, VERIFIER_KEY);
            this.db
                .prepare("INSERT OR REPLACE INTO vault_meta (k, iv, tag, ciphertext) VALUES (?, ?, ?, ?)")
                .run(VERIFIER_KEY, sealed.iv, sealed.tag, sealed.ciphertext);
            return;
        }
        let plain;
        try {
            plain = unseal(this.key, row, VERIFIER_KEY);
        }
        catch {
            throw new VaultKeyError(`the vault key does not match ${this.dbPath}. The key came from ${this.describeKeySource()}. ` +
                `Restore the original key, or delete the vault to start over (every stored credential is lost).`);
        }
        if (plain !== VERIFIER_PLAINTEXT) {
            throw new VaultKeyError(`vault verifier mismatch at ${this.dbPath}; refusing to use a vault we cannot authenticate`);
        }
    }
    describeKeySource() {
        if (this.keySource === "env")
            return `$${this.opts.keyEnvVar ?? VAULT_KEY_ENV}`;
        return this.keyFilePath;
    }
    /** Resolve a secret. Returns undefined when absent; throws only on a broken vault. */
    get(service, type = "token") {
        const row = this.db
            .prepare("SELECT iv, tag, ciphertext FROM credentials WHERE service = ?")
            .get(service);
        if (!row) {
            this.opts.audit?.("vault.miss", { service, type });
            return undefined;
        }
        let value;
        try {
            value = unseal(this.key, row, service);
        }
        catch {
            // The verifier passed, so the key is right for the vault as a whole --
            // this single row is corrupt or was tampered with. Never fall back to a
            // partial read; report it as a fault.
            this.opts.audit?.("vault.corrupt", { service });
            throw new VaultKeyError(`credential '${service}' failed authenticated decryption; the row is corrupt or was tampered with`);
        }
        this.opts.audit?.("vault.read", { service, type });
        return value;
    }
    /** Store (or replace) a secret. */
    set(service, value, opts) {
        if (!service.trim())
            throw new Error("vault: service name is required");
        if (!value)
            throw new Error(`vault: refusing to store an empty value for '${service}'`);
        const sealed = seal(this.key, value, service);
        const now = Date.now();
        const existing = this.db.prepare("SELECT created_at FROM credentials WHERE service = ?").get(service);
        this.db
            .prepare(`INSERT OR REPLACE INTO credentials (service, type, iv, tag, ciphertext, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(service, opts?.type ?? "token", sealed.iv, sealed.tag, sealed.ciphertext, opts?.notes ?? null, existing?.created_at ?? now, now);
        this.opts.audit?.("vault.write", { service, type: opts?.type ?? "token" });
    }
    delete(service) {
        const r = this.db.prepare("DELETE FROM credentials WHERE service = ?").run(service);
        const removed = Number(r.changes) > 0;
        if (removed)
            this.opts.audit?.("vault.delete", { service });
        return removed;
    }
    /** Metadata for every stored credential. Deliberately never returns values. */
    list() {
        const rows = this.db
            .prepare("SELECT service, type, notes, created_at, updated_at FROM credentials ORDER BY service")
            .all();
        return rows.map((r) => ({
            service: r.service,
            type: r.type,
            notes: r.notes ?? undefined,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }
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
    rotate() {
        if (this.keySource === "env") {
            throw new VaultKeyError(`refusing to rotate: the active key comes from $${this.opts.keyEnvVar ?? VAULT_KEY_ENV}, which would keep ` +
                `overriding the newly written key file. Unset it and rotate against the key file instead.`);
        }
        const newKey = generateVaultKey();
        const staged = `${this.keyFilePath}.new`;
        writeKeyFile(staged, newKey);
        const rows = this.db
            .prepare("SELECT service, iv, tag, ciphertext FROM credentials")
            .all();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            for (const row of rows) {
                const plain = unseal(this.key, row, row.service);
                const sealed = seal(newKey, plain, row.service);
                this.db
                    .prepare("UPDATE credentials SET iv = ?, tag = ?, ciphertext = ? WHERE service = ?")
                    .run(sealed.iv, sealed.tag, sealed.ciphertext, row.service);
            }
            const v = seal(newKey, VERIFIER_PLAINTEXT, VERIFIER_KEY);
            this.db
                .prepare("INSERT OR REPLACE INTO vault_meta (k, iv, tag, ciphertext) VALUES (?, ?, ?, ?)")
                .run(VERIFIER_KEY, v.iv, v.tag, v.ciphertext);
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            try {
                unlinkSync(staged);
            }
            catch { /* the staged key is now meaningless */ }
            throw err;
        }
        renameSync(staged, this.keyFilePath);
        this.key = newKey;
        this.opts.audit?.("vault.rotate", { rotated: rows.length });
        this.opts.logger.warn("[vault] key rotated; back up the new key file", { keyFilePath: this.keyFilePath, rotated: rows.length });
        return { rotated: rows.length, keyFilePath: this.keyFilePath };
    }
    close() {
        try {
            this.db.close();
        }
        catch { /* already closed */ }
    }
}
//# sourceMappingURL=credential-vault.js.map