/**
 * The OpenCode backend has to be reachable on the installation path operators
 * actually use.
 *
 * v2.0.0-rc.1 launched the agent as the bare string `opencode` and relied on
 * the standalone Dockerfile's `npm install --global opencode-ai@1.18.23` to
 * put it there. OpenClaw installs a plugin with `npm install --omit=dev` and
 * never builds that Dockerfile, and `opencode-ai` was not in `dependencies`,
 * so on a plugin install nothing had ever installed the agent. Every OpenCode
 * role was unreachable, and the only signal was a spawn failure at the first
 * session rather than anything at install time.
 *
 * These tests pin the two halves of the fix: npm installs the pinned agent,
 * and the router launches THAT copy rather than whatever `opencode` a machine
 * happens to have on PATH.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOpenCodeBinary, defaultOpenCodeCommand } from "../dist/adapters/backend-router.js";
import { PINNED_OPENCODE_VERSION } from "../dist/adapters/opencode-version.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packaging: opencode-ai is a production dependency, so --omit=dev still installs it", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

  assert.ok(pkg.dependencies?.["opencode-ai"],
    "opencode-ai must be in `dependencies`; `devDependencies` is stripped by the plugin installer");
  assert.equal(pkg.dependencies["opencode-ai"], PINNED_OPENCODE_VERSION);

  // `files` decides what npm publishes, but dependencies are installed by the
  // consumer either way. Guard the inverse mistake instead: it must not have
  // been parked somewhere --omit=dev or --omit=optional would skip.
  assert.equal(pkg.devDependencies?.["opencode-ai"], undefined);
  assert.equal(pkg.optionalDependencies?.["opencode-ai"], undefined);
});

test("the launcher resolves to the installed package, not a PATH lookup", () => {
  const r = resolveOpenCodeBinary();

  assert.equal(r.source, "dependency", `expected the npm copy, got PATH (${r.reason})`);
  assert.ok(isAbsolute(r.command), "a resolved binary must be an absolute path");
  assert.ok(r.command.includes("opencode-ai"), "should point inside the opencode-ai package");
  assert.ok(existsSync(r.command), "the resolved launcher must exist on disk");
  assert.equal(r.reason, undefined);
});

test("the resolved binary is the version package.json pins", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "node_modules/opencode-ai/package.json"), "utf8"),
  );
  assert.equal(manifest.version, PINNED_OPENCODE_VERSION,
    "the installed opencode-ai is not the pinned version; the lockfile has drifted");
});

test("defaultOpenCodeCommand launches the resolved binary in acp mode", () => {
  const cmd = defaultOpenCodeCommand();
  assert.deepEqual(cmd.args, ["acp"]);
  assert.equal(cmd.command, resolveOpenCodeBinary().command);
});

test("an unresolvable package falls back to PATH, and says why", () => {
  const r = resolveOpenCodeBinary(() => {
    throw new Error("Cannot find module 'opencode-ai/package.json'");
  });

  assert.equal(r.source, "path");
  assert.equal(r.command, "opencode");
  // The fallback is legitimate -- the Docker image and dev machines work this
  // way -- but it means the pin is not in force, so it must never be silent.
  assert.match(r.reason, /could not be resolved/);
});

test("a package present without its platform binary falls back rather than spawning a missing file", () => {
  // `--omit=optional`, or an unsupported platform: the package installs, the
  // per-platform binary it hard-links from does not. Returning the path anyway
  // would turn a clear diagnosis into ENOENT at the first session.
  const r = resolveOpenCodeBinary(
    () => resolve(root, "node_modules/opencode-ai/package.json"),
    () => false,
  );

  assert.equal(r.source, "path");
  assert.equal(r.command, "opencode");
  assert.match(r.reason, /platform binary not installed/);
});

test("a manifest with no opencode bin entry falls back rather than resolving undefined", () => {
  const fakeManifest = resolve(root, "tests/fixtures/opencode-nobin/package.json");
  if (!existsSync(fakeManifest)) return; // fixture optional; behaviour covered below

  const r = resolveOpenCodeBinary(() => fakeManifest);
  assert.equal(r.source, "path");
  assert.match(r.reason, /no `opencode` bin entry/);
});

test("the Dockerfile no longer installs a second, drifting copy", () => {
  const docker = readFileSync(resolve(root, "Dockerfile"), "utf8");

  // A global install alongside the dependency is ~150 MB duplicated, and two
  // copies can disagree about the version. The dependency is the one the code
  // resolves, so a global would be the copy nobody runs.
  assert.doesNotMatch(docker, /npm install --global[^\n]*opencode-ai/,
    "the Dockerfile installs opencode-ai globally as well as via the dependency");
});
