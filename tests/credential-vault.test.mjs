// The harness owns its credential vault.
//
// WHY THIS EXISTS: credentials used to come from memory-hybrid's `credential_get`
// MCP tool. Two problems, and only the first was the stated reason for moving:
//   1. It tied the harness to a plugin being retired, and the replacement memory
//      backend is a RETRIEVAL system for agents -- the last place a PAT belongs.
//   2. Reaching a secret through a registered TOOL means any turn that can call
//      tools can ask for an arbitrary service name.
//
// The vault is therefore an in-process library call with no tool surface. These
// tests drive the REAL vault against real files and a real SQLite database --
// this is a crypto and file-permission change, and a source-grep assertion
// could not tell a working seal from a broken one.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

import { GitAdapter } from "../dist/adapters/git-worktree.js";

import {
  CredentialVault,
  VaultKeyError,
  generateVaultKey,
  parseVaultKey,
} from "../dist/adapters/credential-vault.js";
import { CredentialAdapter } from "../dist/adapters/credentials.js";
import { buildSdkEnv, registerDeniedSdkEnvVar } from "../dist/adapters/claude-sdk.js";
import { buildBashGuard } from "../dist/safety/bash-guard.js";
import { parseHarnessConfig } from "../dist/config.js";

const QUIET = { info: () => {}, warn: () => {} };

function freshDir() {
  return mkdtempSync(join(tmpdir(), "oah-vault-"));
}

/** Open a vault in a fresh directory, with the env key var guaranteed unset. */
function openFresh(extra = {}) {
  delete process.env.OAH_VAULT_KEY;
  const dir = freshDir();
  return { dir, vault: CredentialVault.open({ dir, logger: QUIET, ...extra }) };
}

// ---------------------------------------------------------------------------
// Storage round-trip
// ---------------------------------------------------------------------------

test("stores and retrieves a secret", () => {
  const { vault } = openFresh();
  vault.set("github-carel", "ghp_example_token_value");
  assert.equal(vault.get("github-carel"), "ghp_example_token_value");
  vault.close();
});

test("a missing service returns undefined rather than throwing", () => {
  const { vault } = openFresh();
  assert.equal(vault.get("never-stored"), undefined);
  vault.close();
});

test("set replaces an existing value but keeps the original created_at", () => {
  const { vault } = openFresh();
  vault.set("svc", "first");
  const createdAt = vault.list()[0].createdAt;
  vault.set("svc", "second");
  assert.equal(vault.get("svc"), "second");
  assert.equal(vault.list().length, 1, "replace must not create a second row");
  assert.equal(vault.list()[0].createdAt, createdAt);
  vault.close();
});

test("refuses to store an empty value", () => {
  const { vault } = openFresh();
  assert.throws(() => vault.set("svc", ""), /refusing to store an empty value/);
  vault.close();
});

test("delete removes an entry and reports whether it was there", () => {
  const { vault } = openFresh();
  vault.set("svc", "v");
  assert.equal(vault.delete("svc"), true);
  assert.equal(vault.delete("svc"), false);
  assert.equal(vault.get("svc"), undefined);
  vault.close();
});

test("list returns metadata and never the values", () => {
  const { vault } = openFresh();
  vault.set("a", "secret-a", { notes: "note a" });
  vault.set("b", "secret-b", { type: "api_key" });
  const rows = vault.list();
  assert.deepEqual(rows.map((r) => r.service), ["a", "b"]);
  assert.equal(rows[1].type, "api_key");
  const serialised = JSON.stringify(rows);
  assert.ok(!serialised.includes("secret-a"), "list() leaked a value");
  assert.ok(!serialised.includes("secret-b"), "list() leaked a value");
  vault.close();
});

// ---------------------------------------------------------------------------
// The value is genuinely encrypted at rest
// ---------------------------------------------------------------------------

test("the plaintext never appears in the database file", () => {
  const { dir, vault } = openFresh();
  vault.set("github-carel", "ghp_SUPERSECRETVALUE_9876");
  vault.close();
  const raw = readFileSync(join(dir, "vault.db"));
  assert.ok(!raw.includes(Buffer.from("ghp_SUPERSECRETVALUE_9876")), "secret stored in plaintext");
});

test("each write uses a fresh IV, so the same value encrypts differently", () => {
  const { dir, vault } = openFresh();
  vault.set("a", "identical-value");
  vault.set("b", "identical-value");
  vault.close();
  const db = new DatabaseSync(join(dir, "vault.db"));
  const rows = db.prepare("SELECT service, iv, ciphertext FROM credentials ORDER BY service").all();
  db.close();
  assert.notEqual(rows[0].iv, rows[1].iv, "IV was reused across writes");
  assert.notEqual(rows[0].ciphertext, rows[1].ciphertext, "identical plaintexts produced identical ciphertext");
});

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

test("first boot generates a key file at mode 0600", () => {
  const { dir, vault } = openFresh();
  const keyFile = join(dir, "vault.key");
  assert.ok(existsSync(keyFile), "no key file generated");
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  vault.close();
});

test("a loose key file is tightened to 0600 on open", () => {
  const { dir, vault } = openFresh();
  vault.close();
  const keyFile = join(dir, "vault.key");
  chmodSync(keyFile, 0o644);
  const reopened = CredentialVault.open({ dir, logger: QUIET });
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  reopened.close();
});

test("the environment key overrides the key file", () => {
  const { dir, vault } = openFresh();
  vault.set("svc", "from-file-key");
  vault.close();

  // A DIFFERENT key in the env must not silently open a vault sealed with the
  // file key -- it must be detected as the wrong key.
  process.env.OAH_VAULT_KEY = generateVaultKey().toString("hex");
  try {
    assert.throws(() => CredentialVault.open({ dir, logger: QUIET }), VaultKeyError);
  } finally {
    delete process.env.OAH_VAULT_KEY;
  }

  // The same key as the file's, supplied via env, opens it fine.
  process.env.OAH_VAULT_KEY = readFileSync(join(dir, "vault.key"), "utf8").trim();
  try {
    const v = CredentialVault.open({ dir, logger: QUIET });
    assert.equal(v.keySource, "env");
    assert.equal(v.get("svc"), "from-file-key");
    v.close();
  } finally {
    delete process.env.OAH_VAULT_KEY;
  }
});

test("a wrong key fails at OPEN, not as a procession of missing entries", () => {
  const { dir, vault } = openFresh();
  vault.set("github-carel", "value");
  vault.close();
  writeFileSync(join(dir, "vault.key"), `${generateVaultKey().toString("hex")}\n`, { mode: 0o600 });
  // The distinction matters: "not found" sends an operator hunting for an entry
  // that is present but sealed.
  assert.throws(() => CredentialVault.open({ dir, logger: QUIET }), (err) => {
    assert.ok(err instanceof VaultKeyError);
    assert.match(String(err), /key does not match/);
    return true;
  });
});

test("parseVaultKey accepts hex and base64 but rejects the wrong length", () => {
  const key = generateVaultKey();
  assert.deepEqual(parseVaultKey(key.toString("hex"), "test"), key);
  assert.deepEqual(parseVaultKey(key.toString("base64"), "test"), key);
  // A truncated key would otherwise encrypt happily and fail to decrypt later.
  assert.throws(() => parseVaultKey("abcd", "test"), VaultKeyError);
  assert.throws(() => parseVaultKey("", "test"), VaultKeyError);
});

// ---------------------------------------------------------------------------
// Tamper detection (this is what GCM buys us over plain AES)
// ---------------------------------------------------------------------------

test("a tampered row is rejected rather than returned", () => {
  const { dir, vault } = openFresh();
  vault.set("svc", "original-value");
  vault.close();

  const db = new DatabaseSync(join(dir, "vault.db"));
  const row = db.prepare("SELECT ciphertext FROM credentials WHERE service = 'svc'").get();
  const flipped = Buffer.from(row.ciphertext, "base64");
  flipped[0] ^= 0xff;
  db.prepare("UPDATE credentials SET ciphertext = ? WHERE service = 'svc'").run(flipped.toString("base64"));
  db.close();

  const reopened = CredentialVault.open({ dir, logger: QUIET });
  assert.throws(() => reopened.get("svc"), /failed authenticated decryption/);
  reopened.close();
});

test("ciphertext cannot be moved between services", () => {
  // The service name is bound in as additional authenticated data precisely so
  // that someone with write access to the DB cannot promote a low-privilege
  // row into a high-privilege service name.
  const { dir, vault } = openFresh();
  vault.set("github-readonly", "low-privilege-token");
  vault.set("github-admin", "high-privilege-token");
  vault.close();

  const db = new DatabaseSync(join(dir, "vault.db"));
  const src = db.prepare("SELECT iv, tag, ciphertext FROM credentials WHERE service = 'github-readonly'").get();
  db.prepare("UPDATE credentials SET iv = ?, tag = ?, ciphertext = ? WHERE service = 'github-admin'")
    .run(src.iv, src.tag, src.ciphertext);
  db.close();

  const reopened = CredentialVault.open({ dir, logger: QUIET });
  assert.throws(() => reopened.get("github-admin"), /failed authenticated decryption/);
  reopened.close();
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test("rotate re-encrypts every entry and the old key stops working", () => {
  const { dir, vault } = openFresh();
  vault.set("a", "value-a");
  vault.set("b", "value-b");
  const oldKey = readFileSync(join(dir, "vault.key"), "utf8").trim();

  const result = vault.rotate();
  assert.equal(result.rotated, 2);
  assert.equal(vault.get("a"), "value-a", "rotation lost a value");
  assert.equal(vault.get("b"), "value-b", "rotation lost a value");
  vault.close();

  const newKey = readFileSync(join(dir, "vault.key"), "utf8").trim();
  assert.notEqual(newKey, oldKey, "rotate did not change the key");

  // Reopening with the new key on disk works...
  const reopened = CredentialVault.open({ dir, logger: QUIET });
  assert.equal(reopened.get("a"), "value-a");
  reopened.close();

  // ...and the superseded key does not.
  writeFileSync(join(dir, "vault.key"), `${oldKey}\n`, { mode: 0o600 });
  assert.throws(() => CredentialVault.open({ dir, logger: QUIET }), VaultKeyError);
});

test("rotate leaves no staged key file behind", () => {
  const { dir, vault } = openFresh();
  vault.set("a", "v");
  vault.rotate();
  vault.close();
  assert.ok(!existsSync(join(dir, "vault.key.new")), "staged key file was not renamed away");
});

test("rotate is refused when the key comes from the environment", () => {
  // Writing a new key FILE while the env var still overrides it would brick the
  // vault on the next boot, so this has to fail loudly rather than half-work.
  const { dir, vault } = openFresh();
  vault.set("a", "v");
  vault.close();
  process.env.OAH_VAULT_KEY = readFileSync(join(dir, "vault.key"), "utf8").trim();
  try {
    const v = CredentialVault.open({ dir, logger: QUIET });
    assert.throws(() => v.rotate(), /refusing to rotate/);
    assert.equal(v.get("a"), "v", "the refused rotation must not have disturbed anything");
    v.close();
  } finally {
    delete process.env.OAH_VAULT_KEY;
  }
});

// ---------------------------------------------------------------------------
// Auditing
// ---------------------------------------------------------------------------

test("audit records the service name and never the value", () => {
  delete process.env.OAH_VAULT_KEY;
  const events = [];
  const vault = CredentialVault.open({
    dir: freshDir(),
    logger: QUIET,
    audit: (event, payload) => events.push({ event, payload }),
  });
  vault.set("github-carel", "ghp_AUDIT_LEAK_CANARY");
  vault.get("github-carel");
  vault.get("absent-service");
  vault.close();

  assert.deepEqual(events.map((e) => e.event), ["vault.write", "vault.read", "vault.miss"]);
  assert.equal(events[1].payload.service, "github-carel");
  assert.ok(
    !JSON.stringify(events).includes("ghp_AUDIT_LEAK_CANARY"),
    "the audit trail became a second copy of the secret store",
  );
});

// ---------------------------------------------------------------------------
// The adapter on top
// ---------------------------------------------------------------------------

test("CredentialAdapter reads through the vault and caches until purged", async () => {
  let reads = 0;
  const adapter = new CredentialAdapter({
    logger: QUIET,
    vault: { get: (service) => { reads++; return service === "svc" ? "token-value" : undefined; } },
  });
  assert.equal(await adapter.getToken("svc"), "token-value");
  assert.equal(await adapter.getToken("svc"), "token-value");
  assert.equal(reads, 1, "the second read should have been served from cache");

  adapter.purge();
  assert.equal(await adapter.getToken("svc"), "token-value");
  assert.equal(reads, 2, "purge did not clear the cache");

  await assert.rejects(adapter.getToken("missing"), /not found in vault/);
});

// ---------------------------------------------------------------------------
// Keeping the key away from the worker subprocess
// ---------------------------------------------------------------------------

test("the vault key never reaches the worker subprocess env", () => {
  process.env.OAH_VAULT_KEY = "should-not-be-inherited";
  process.env.OAH_VAULT_KEY_FILE = "/tmp/should-not-be-inherited";
  try {
    const env = buildSdkEnv("sk-ant-test", 1000);
    assert.equal(env.OAH_VAULT_KEY, undefined);
    assert.equal(env.OAH_VAULT_KEY_FILE, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
  } finally {
    delete process.env.OAH_VAULT_KEY;
    delete process.env.OAH_VAULT_KEY_FILE;
  }
});

test("the denylist still applies when no API key is resolved", () => {
  // REGRESSION: buildSdkEnv used to `return undefined` without a key, which
  // tells the SDK "inherit the parent env" -- handing the child every secret
  // the denylist exists to withhold, the vault key among them.
  process.env.OAH_VAULT_KEY = "should-not-be-inherited";
  process.env.SOME_API_KEY = "also-secret";
  try {
    const env = buildSdkEnv(undefined, 1000);
    assert.ok(env && typeof env === "object", "no-key path returned an unfiltered environment");
    assert.equal(env.OAH_VAULT_KEY, undefined);
    assert.equal(env.SOME_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "no key was resolved, so none should be injected");
  } finally {
    delete process.env.OAH_VAULT_KEY;
    delete process.env.SOME_API_KEY;
  }
});

test("an operator-renamed key var can be denied too", () => {
  process.env.MY_CUSTOM_VAULT_UNLOCK = "secret";
  try {
    assert.equal(buildSdkEnv("k", 1).MY_CUSTOM_VAULT_UNLOCK, "secret", "precondition: not denied yet");
    registerDeniedSdkEnvVar("MY_CUSTOM_VAULT_UNLOCK");
    assert.equal(buildSdkEnv("k", 1).MY_CUSTOM_VAULT_UNLOCK, undefined);
  } finally {
    delete process.env.MY_CUSTOM_VAULT_UNLOCK;
  }
});

// ---------------------------------------------------------------------------
// ...and away from the worker's file access
// ---------------------------------------------------------------------------

test("the worker cannot read the vault or its key by path", async () => {
  // Stripping the env var stops `echo $OAH_VAULT_KEY`. It does NOT stop
  // `cat .../vault.key`, because the worker runs as the same uid as the
  // harness. Both defences are required; neither substitutes for the other.
  const config = parseHarnessConfig({
    slack: { authorised_users: ["U0000000000"] },
    repos: { allowed: ["CarelvanHeerden/*"] },
  });
  const guard = buildBashGuard(config.safety);

  for (const path of [
    "/home/node/.openclaw/harness/harness-vault/vault.key",
    "/home/node/.openclaw/harness/harness-vault/vault.db",
  ]) {
    const read = await guard("Read", { file_path: path });
    assert.equal(read.allow, false, `Read of ${path} was allowed`);
    const write = await guard("Write", { file_path: path });
    assert.equal(write.allow, false, `Write to ${path} was allowed`);
  }

  const cat = await guard("Bash", { command: "cat /home/node/.openclaw/harness/harness-vault/vault.key" });
  assert.equal(cat.allow, false, "a worker could cat the vault key");
});

/* ------------------------------------------------------------------ *
 * Ported in from beta.110: a vault artefact can never reach a commit
 * ------------------------------------------------------------------ */

// gpgsign off and identity inline, matching beta110-scope-blowout: a developer
// with a global commit.gpgsign=true, or a CI runner with no global user.name,
// otherwise fails here for reasons that have nothing to do with the vault.
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-c", "commit.gpgsign=false",
      "-c", "tag.gpgsign=false",
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "-C", cwd,
      ...args,
    ],
    { encoding: "utf8" },
  );

test("a vault artefact inside a worktree is excluded from git, not committed", async () => {
  // The vault resolves against the harness data dir, so this configuration
  // should not arise. It is asserted anyway because beta.110's 12,291-file
  // commit came from a path a model chose freely, and the artefact at risk
  // here is a private key rather than a cache blob.
  const dir = mkdtempSync(join(tmpdir(), "vault-excl-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");

  const adapter = new GitAdapter({
    worktreesRoot: mkdtempSync(join(tmpdir(), "vault-excl-wt-")),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await adapter.applyHarnessExcludes(dir);

  mkdirSync(join(dir, "harness-vault"), { recursive: true });
  writeFileSync(join(dir, "harness-vault", "vault.key"), "0".repeat(64));
  writeFileSync(join(dir, "harness-vault", "vault.db"), "sqlite");
  writeFileSync(join(dir, "vault.key"), "0".repeat(64));
  writeFileSync(join(dir, "real-work.txt"), "the sub-task's actual change\n");

  const untracked = git(dir, "status", "--porcelain");
  assert.ok(untracked.includes("real-work.txt"), "the sub-task's own file must still be committable");
  for (const leaked of ["vault.key", "vault.db", "harness-vault"]) {
    assert.ok(!untracked.includes(leaked), `${leaked} was visible to git status: ${untracked}`);
  }

  // The exclusion has to survive the operation that actually caused #932.
  git(dir, "add", "-A");
  const staged = git(dir, "diff", "--cached", "--name-only");
  assert.ok(staged.includes("real-work.txt"), "real work must still stage");
  assert.ok(!staged.includes("vault.key"), `a private key reached the index: ${staged}`);
  assert.ok(!staged.includes("vault.db"), `the vault database reached the index: ${staged}`);
});
