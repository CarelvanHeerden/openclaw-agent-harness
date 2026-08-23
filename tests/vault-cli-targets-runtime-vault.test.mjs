// The operator CLI and the running plugin have to mean the same directory when
// they say "the vault".
//
// Through 1.0.0-rc.1 they did not. scripts/vault.mjs defaulted to
// ~/.openclaw/harness/harness-vault; src/index.ts resolved the vault beside the
// state DB, which by default is
// ~/.openclaw/workspace/openclaw-agent-harness/harness-vault. So every
// documented `vault.mjs set` wrote a real, correctly encrypted credential into
// a directory nothing would ever open, and `vault.mjs list` then confirmed it
// was there. The failure surfaced much later, as a credential lookup miss
// against a vault that visibly contained the name.
//
// Nothing in the suite compared the two paths, because each was individually
// correct. This test is the comparison.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { harnessDefaults, runtimeVaultDir } from "../scripts/vault.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What src/index.ts does, expressed here so a change to the runtime derivation
 * fails this test rather than silently splitting the two again.
 */
function runtimeDerivation(config, home) {
  const dbPath = config.storage.state_db_path.replace(/^~/, home);
  return resolve(dirname(dbPath), config.credentials?.dir ?? "harness-vault");
}

test("the CLI default is the directory the plugin actually opens", () => {
  const home = "/home/example";
  const defaults = harnessDefaults();
  const cli = runtimeVaultDir({ home, configPath: join(tmpdir(), "definitely-absent.json"), defaults });
  assert.equal(cli, runtimeDerivation(defaults, home));
  assert.equal(cli, "/home/example/.openclaw/workspace/openclaw-agent-harness/harness-vault");
});

test("a configured state_db_path moves the CLI with it", () => {
  const home = "/home/example";
  const dir = mkdtempSync(join(tmpdir(), "vaultcfg-"));
  const configPath = join(dir, "openclaw.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        entries: {
          "openclaw-agent-harness": { config: { storage: { state_db_path: "/srv/harness/state.db" } } },
        },
      },
    }),
    "utf8",
  );
  assert.equal(runtimeVaultDir({ home, configPath, defaults: harnessDefaults() }), "/srv/harness/harness-vault");
});

test("credentials.dir moves it too, the same way it moves the plugin", () => {
  const home = "/home/example";
  const dir = mkdtempSync(join(tmpdir(), "vaultcfg-"));
  const configPath = join(dir, "openclaw.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        entries: {
          "openclaw-agent-harness": {
            config: { storage: { state_db_path: "/srv/harness/state.db" }, credentials: { dir: "secrets" } },
          },
        },
      },
    }),
    "utf8",
  );
  assert.equal(runtimeVaultDir({ home, configPath, defaults: harnessDefaults() }), "/srv/harness/secrets");
});

test("the CLI no longer carries a hard-coded vault path of its own", () => {
  const src = readFileSync(join(root, "scripts", "vault.mjs"), "utf8");
  const code = src.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "");
  assert.ok(
    !/\.openclaw\/harness\/harness-vault/.test(code),
    "the pre-rc.2 default path must not come back; derive it from the config instead",
  );
});
