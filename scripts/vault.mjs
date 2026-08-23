#!/usr/bin/env node
/**
 * beta.110: operator CLI for the harness credential vault.
 *
 * DELIBERATELY NOT AN AGENT TOOL. The whole point of moving off memory-hybrid's
 * `credential_get` was that a registered tool can be invoked by any turn that
 * can call tools. Seeding a vault is an operator task performed once at install
 * time with shell access, so it belongs on the shell, not on the tool surface.
 *
 * Usage:
 *   node scripts/vault.mjs list
 *   node scripts/vault.mjs set <service> [--type token|api_key] [--notes "..."]
 *   node scripts/vault.mjs get <service> --reveal
 *   node scripts/vault.mjs delete <service>
 *   node scripts/vault.mjs rotate
 *
 * `set` reads the secret from stdin so it never lands in shell history:
 *   printf '%s' "$TOKEN" | node scripts/vault.mjs set github-carel
 *
 * The vault directory is derived from the SAME config the plugin reads, so a
 * token seeded here is a token the running harness can find. rc.2: it used to
 * default to ~/.openclaw/harness/harness-vault while the plugin resolved
 * <dirname(storage.state_db_path)>/harness-vault — by default
 * ~/.openclaw/workspace/openclaw-agent-harness/harness-vault. Every documented
 * `vault.mjs set` therefore wrote a real, correctly encrypted entry into a
 * directory nothing ever read, and the failure only surfaced later as a
 * credential lookup miss against a vault that visibly contained the name.
 *
 * Resolution order: --dir, then $OAH_VAULT_DIR, then openclaw.json, then the
 * harness's own defaults. The directory in use is printed to stderr, because a
 * vault CLI that is silent about which vault it opened is how the above
 * happened.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DIST = new URL("../dist/adapters/credential-vault.js", import.meta.url);
let CredentialVault;
let parseHarnessConfig;
try {
  ({ CredentialVault } = await import(DIST.href));
  ({ parseHarnessConfig } = await import(new URL("../dist/config.js", import.meta.url).href));
} catch {
  console.error("Could not load dist/. Run `npm run build` first.");
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reveal") out.reveal = true;
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--type") out.type = argv[++i];
    else if (a === "--notes") out.notes = argv[++i];
    else if (a === "--key-file") out.keyFile = argv[++i];
    else out._.push(a);
  }
  return out;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * The harness's own defaults, read from the parser rather than restated here.
 * Restating them is what produced the drift this function exists to close.
 */
export function harnessDefaults() {
  return parseHarnessConfig({
    slack: { channel: "C0000000000", authorised_users: ["U0000000000"] },
    repos: { allowed: ["example-org/example-repo"] },
  });
}

/**
 * Where the running plugin will look. Mirrors src/index.ts: the vault sits
 * beside the state DB, under `credentials.dir`.
 */
export function runtimeVaultDir({ home = process.env.HOME ?? ".", configPath, defaults } = {}) {
  const expand = (p) => p.replace(/^~/, home);
  const cfgPath = configPath ?? resolve(expand("~"), ".openclaw/openclaw.json");
  let harness = {};
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    harness = raw?.plugins?.entries?.["openclaw-agent-harness"]?.config ?? {};
  } catch {
    // No readable config is normal on a fresh box; fall through to defaults.
  }
  const dbPath = expand(harness?.storage?.state_db_path ?? defaults.storage.state_db_path);
  return resolve(dirname(dbPath), harness?.credentials?.dir ?? defaults.credentials.dir);
}

// Importing this file must not open a vault or exit the process; the CLI body
// runs only when it is the entry point, so a test can check the path
// resolution that the rc.2 mismatch turned on.
if (process.argv[1]?.endsWith("vault.mjs")) main();

function main() {
const args = parseArgs(process.argv.slice(2));
const [cmd, service] = args._;
if (!cmd) {
  console.error("usage: vault.mjs <list|set|get|delete|rotate> [service] [--dir <path>]");
  process.exit(2);
}

const dir = resolve(args.dir ?? process.env.OAH_VAULT_DIR ?? runtimeVaultDir({ defaults: harnessDefaults() }));

const logger = {
  info: (m, meta) => console.error(m, meta ?? ""),
  warn: (m, meta) => console.error(m, meta ?? ""),
};

console.error(`vault: ${dir}`);

let vault;
try {
  vault = CredentialVault.open({ dir, keyFile: args.keyFile, logger });
} catch (err) {
  console.error(`vault: ${String(err)}`);
  process.exit(1);
}

try {
  switch (cmd) {
    case "list": {
      const rows = vault.list();
      if (rows.length === 0) {
        console.log(`(empty) ${dir}`);
        break;
      }
      for (const r of rows) {
        console.log(`${r.service}\t${r.type}\tupdated ${new Date(r.updatedAt).toISOString()}${r.notes ? `\t${r.notes}` : ""}`);
      }
      break;
    }
    case "set": {
      if (!service) throw new Error("set needs a service name");
      // stdin keeps the secret out of argv (and therefore out of ps and shell history).
      const value = readStdin().replace(/\n$/, "");
      if (!value) throw new Error("no value on stdin; pipe the secret in, e.g. printf '%s' \"$TOKEN\" | vault.mjs set <service>");
      vault.set(service, value, { type: args.type ?? "token", notes: args.notes });
      console.log(`stored '${service}' (${value.length} chars) in ${dir}`);
      break;
    }
    case "get": {
      if (!service) throw new Error("get needs a service name");
      const v = vault.get(service, args.type === "api_key" ? "api_key" : "token");
      if (v === undefined) {
        console.error(`'${service}' is not in the vault`);
        process.exitCode = 1;
        break;
      }
      // Printing a secret must be a deliberate act, not a side effect of
      // checking whether one exists.
      if (!args.reveal) {
        console.log(`'${service}' is present (${v.length} chars). Pass --reveal to print it.`);
        break;
      }
      process.stdout.write(v);
      break;
    }
    case "delete": {
      if (!service) throw new Error("delete needs a service name");
      console.log(vault.delete(service) ? `deleted '${service}'` : `'${service}' was not present`);
      break;
    }
    case "rotate": {
      const r = vault.rotate();
      console.log(`re-encrypted ${r.rotated} credential(s) under a new key at ${r.keyFilePath}`);
      console.log("BACK UP THE NEW KEY FILE. The previous key can no longer read this vault.");
      break;
    }
    default:
      throw new Error(`unknown command '${cmd}'`);
  }
} catch (err) {
  console.error(`vault: ${String(err)}`);
  process.exit(1);
} finally {
  vault.close();
}
}
