/**
 * rc.8 -- the harness inherits NODE_ENV=production, and npm honours it.
 *
 * StitchGuard. The allocator bootstrapped the worktree with
 *
 *   npm ci --ignore-scripts --no-audit --no-fund --legacy-peer-deps
 *
 * and npm, reading NODE_ENV=production from the harness container, defaulted
 * to `omit=dev`. The runtime tree installed; every devDependency was skipped.
 * TypeScript is a devDependency there, so `node_modules/.bin/tsc` was never
 * written, `npm run typecheck` exited 127, and beta.69 (F4) -- correctly --
 * classified that as `env_unavailable`. Review reported a broken environment
 * instead of a verdict, on every cycle, for a repo whose tooling was fine.
 *
 * The no-lockfile branch had carried `--include=dev` since beta.53. Only the
 * lockfile branch was missing it, which is why this survived so long: the
 * fix was already written, one branch over.
 *
 * Restoring `include=dev` in the container user's ~/.npmrc also fixes it,
 * which is how the defect was found. That is a host workaround: it makes one
 * machine work and leaves the harness broken. These tests therefore run with
 * npm's user AND global config pointed at empty files, so a workaround on the
 * developer's machine cannot make them pass -- and so they cannot write to
 * the developer's real npm configuration either.
 *
 * The installs here are real but offline: the dev-only dependency is a
 * `file:` package built in the temp directory, whose bin is named `tsc`
 * precisely because that is the binary StitchGuard lost.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { GitAdapter } from "../dist/adapters/git-worktree.js";

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/**
 * bootstrapWorktreeDeps is best-effort: it swallows install failures into a
 * warn. Keep them, or a broken fixture looks identical to the defect.
 */
function adapter() {
  const logged = [];
  const sink = (level) => (msg) => logged.push(`${level}: ${msg}`);
  const a = new GitAdapter({
    worktreesRoot: mkdtempSync(join(tmpdir(), "rc8-wt-")),
    logger: { info() {}, debug() {}, warn: sink("warn"), error: sink("error") },
    // beta.76's disk preflight would skip the install on a full machine and
    // make these tests fail for a reason that has nothing to do with them.
    minFreeDiskBytes: 0,
  });
  a.logged = logged;
  return a;
}

/**
 * A worktree shaped like StitchGuard's: a runtime dependency that installs
 * under production settings, plus a dev-only `file:` package providing a `tsc`
 * bin that the `typecheck` script calls. Both are local, so nothing here needs
 * the network, and `tsc` is a binary beta.69's `declaredCheckBinsPresent`
 * probe actually looks for.
 *
 * The runtime dependency matters: without it the defect leaves NO node_modules
 * at all, which is a different -- and much more visible -- failure than the one
 * that shipped. What shipped was a populated tree missing only its dev tools.
 */
function fixture({ lockfile }) {
  const root = mkdtempSync(join(tmpdir(), "rc8-"));
  const tool = join(root, "tool");
  const lib = join(root, "lib");
  const app = join(root, "app");
  mkdirSync(join(tool, "bin"), { recursive: true });
  mkdirSync(lib, { recursive: true });
  mkdirSync(app, { recursive: true });

  writeFileSync(
    join(tool, "package.json"),
    JSON.stringify({ name: "fake-typescript", version: "1.0.0", bin: { tsc: "bin/tsc.js" } }, null, 2),
  );
  writeFileSync(join(tool, "bin", "tsc.js"), "#!/usr/bin/env node\nconsole.log('tsc ok');\n");
  writeFileSync(
    join(lib, "package.json"),
    JSON.stringify({ name: "fake-runtime-lib", version: "1.0.0", main: "index.js" }, null, 2),
  );
  writeFileSync(join(lib, "index.js"), "module.exports = 1;\n");

  writeFileSync(
    join(app, "package.json"),
    JSON.stringify(
      {
        name: "app",
        version: "1.0.0",
        private: true,
        scripts: { typecheck: "tsc --noEmit" },
        dependencies: { "fake-runtime-lib": "file:../lib" },
        devDependencies: { "fake-typescript": "file:../tool" },
      },
      null,
      2,
    ),
  );

  // npm refuses to load one file as both user and global config.
  writeFileSync(join(root, "user-npmrc"), "");
  writeFileSync(join(root, "global-npmrc"), "");

  if (lockfile) {
    npm(app, ["install", "--package-lock-only", "--no-audit", "--no-fund"], root);
    assert.ok(existsSync(join(app, "package-lock.json")), "fixture must have a lockfile");
  }
  return { root, app, tool };
}

/** Run npm directly, under the fixture's isolated config and NODE_ENV=production. */
function npm(cwd, args, root) {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...prodEnv(root) },
  });
}

function prodEnv(root) {
  return {
    NODE_ENV: "production",
    npm_config_userconfig: join(root, "user-npmrc"),
    npm_config_globalconfig: join(root, "global-npmrc"),
    npm_config_cache: join(root, "npm-cache"),
  };
}

/**
 * bootstrapWorktreeDeps spawns npm with `{ ...process.env }`, so production
 * settings have to be staged on this process and restored afterwards.
 */
async function underProduction(root, fn) {
  const patch = prodEnv(root);
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  Object.assign(process.env, patch);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const hasTsc = (app) => existsSync(join(app, "node_modules", ".bin", "tsc"));

/** Run the real bootstrap under production settings; return anything it complained about. */
async function bootstrap(root, app) {
  const a = adapter();
  await underProduction(root, () => a.bootstrapWorktreeDeps(app));
  return a.logged.join("\n");
}

/* ------------------------------------------------------------------ *
 * The command the allocator actually builds
 * ------------------------------------------------------------------ */

/** Capture the bootstrap's npm invocation without running it. */
async function bootstrapArgs(app) {
  const a = adapter();
  const calls = [];
  a.runCmd = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve("");
  };
  await a.bootstrapWorktreeDeps(app);
  assert.equal(calls.length, 1, "bootstrap must run exactly one install");
  assert.equal(calls[0].cmd, "npm");
  return calls[0].args;
}

test("rc.8: the LOCKFILE path asks for devDependencies", async () => {
  const { app } = fixture({ lockfile: true });
  const args = await bootstrapArgs(app);
  assert.equal(args[0], "ci", "a lockfile must still mean `npm ci` -- determinism is not the thing being fixed");
  assert.ok(args.includes("--include=dev"), `--include=dev missing from: npm ${args.join(" ")}`);
});

test("rc.8: the NO-LOCKFILE path still asks for devDependencies", async () => {
  const { app } = fixture({ lockfile: false });
  const args = await bootstrapArgs(app);
  assert.equal(args[0], "install");
  assert.ok(args.includes("--include=dev"), `--include=dev missing from: npm ${args.join(" ")}`);
});

test("rc.8: neither path drops the flags it already had", async () => {
  const keep = ["--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"];
  for (const lockfile of [true, false]) {
    const { app } = fixture({ lockfile });
    const args = await bootstrapArgs(app);
    for (const flag of keep) {
      assert.ok(args.includes(flag), `${args[0]} path dropped ${flag}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * ...and what npm does with it, under production settings
 * ------------------------------------------------------------------ */

test("rc.8 premise: under NODE_ENV=production npm SKIPS devDependencies unless told", () => {
  // Without this control the tests below would pass on a machine whose
  // ~/.npmrc carries the workaround, and prove nothing.
  const { root, app } = fixture({ lockfile: true });
  npm(app, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"], root);
  assert.equal(hasTsc(app), false, "npm installed dev deps unasked; this fixture cannot detect the defect");
  // The shipped shape exactly: a populated runtime tree, no dev tooling.
  assert.ok(existsSync(join(app, "node_modules", "fake-runtime-lib")), "the runtime dependency should still install");
});

test("rc.8: a lockfile worktree gets a RUNNABLE dev binary under production", async () => {
  const { root, app } = fixture({ lockfile: true });
  const complaints = await bootstrap(root, app);
  assert.ok(hasTsc(app), `tsc absent -- this is StitchGuard's exit 127. ${complaints}`);
  // Installed is not the same as usable: 127 was about executing it.
  const out = execFileSync(join(app, "node_modules", ".bin", "tsc"), { encoding: "utf8" });
  assert.match(out, /tsc ok/);
});

test("rc.8: a lockfile-less worktree gets one too", async () => {
  const { root, app } = fixture({ lockfile: false });
  const complaints = await bootstrap(root, app);
  assert.ok(hasTsc(app), `tsc absent on the \`npm install\` path. ${complaints}`);
});

test("rc.8: a non-empty node_modules missing the declared binary is reinstalled", async () => {
  // beta.69 (F4): the "already installed" skip is bin-aware, so a worktree
  // left half-populated by the old command self-heals on the next allocation
  // rather than staying broken for the life of the session.
  const { root, app } = fixture({ lockfile: true });
  npm(app, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"], root);
  assert.equal(hasTsc(app), false, "precondition: the old command's partial tree");
  assert.ok(existsSync(join(app, "node_modules")), "precondition: node_modules is non-empty, not absent");

  const complaints = await bootstrap(root, app);
  assert.ok(hasTsc(app), `a partial tree must not be mistaken for a complete one. ${complaints}`);
});

test("rc.8: a complete node_modules is still left alone", async () => {
  const { root, app } = fixture({ lockfile: true });
  const complaints = await bootstrap(root, app);
  assert.ok(hasTsc(app), complaints);

  const a = adapter();
  let ran = false;
  a.runCmd = () => { ran = true; return Promise.resolve(""); };
  await a.bootstrapWorktreeDeps(app);
  assert.equal(ran, false, "a healthy worktree must not be reinstalled on every allocation");
});

/* ------------------------------------------------------------------ *
 * The workaround stays out of the fix
 * ------------------------------------------------------------------ */

test("rc.8: the harness fixes this in its own command, not in npm's configuration", () => {
  const src = S("src/adapters/git-worktree.ts");
  // Setting NODE_ENV or writing an .npmrc would fix the symptom by mutating
  // state the harness does not own -- the host workaround, moved into code.
  assert.doesNotMatch(src, /npmrc/i);
  assert.doesNotMatch(src, /process\.env\.NODE_ENV\s*=/);
  assert.doesNotMatch(src, /npm_config_/i);
  // One expression, so the two branches cannot diverge again.
  assert.match(src, /hasLock \? "ci" : "install", "--include=dev"/);
});

test("rc.8: the fixture cannot have written to the developer's npm config", () => {
  const { root, app } = fixture({ lockfile: true });
  const before = readFileSync(join(root, "user-npmrc"), "utf8");
  npm(app, ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  assert.equal(readFileSync(join(root, "user-npmrc"), "utf8"), before);
  assert.equal(existsSync(join(root, "npm-cache")), true, "npm must have used the fixture's cache, not the real one");
  rmSync(root, { recursive: true, force: true });
});
