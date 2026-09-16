/**
 * rc.10 / F1 -- a checkpoint of a partial clone is a NETWORK operation, and
 * rc.9 shipped it unauthenticated.
 *
 * Client Offboarding smoke test, 15 September 2026, session
 * aad3fc57-662d-401e-9386-79e858ff7183. Audits 5602 and 5628, both identical:
 *
 *   git bundle create failed: remote: Invalid username or token. Password
 *   authentication is not supported for Git operations.
 *   fatal: Authentication failed for 'https://github.com/Stitch-Vercel/StitchGuard.git/'
 *   fatal: could not fetch e704e95... from promisor remote
 *   error: pack-objects died
 *
 * The PAT was fine -- the report's read-only controls got HTTP 200 from /user
 * and from the repo endpoint, and `git ls-remote` succeeded the moment the same
 * routed token was injected into the child environment. What was missing was
 * the injection. rc.9's `defaultGitRunner` is `execFile("git", ...)` with no
 * `env`, and the loop passed no runner, so the credential helper that reads
 * `$OAH_GH_TOKEN` had nothing to read. The session held commit 065063e and
 * still reported durability as unknown.
 *
 * WHAT THIS FILE DOES NOT MOCK. A stubbed GitRunner could only re-assert the
 * stub. These tests stand up a real bare repository, serve it over HTTP through
 * `git http-backend` behind HTTP Basic auth, and clone it `--filter=blob:none`
 * so the worktree is a genuine promisor partial clone. `git bundle create` then
 * really does have to fetch, and really does fail the way the audits recorded
 * when the credential is absent. No live PAT and no network egress: the server
 * is on 127.0.0.1 and the "token" is a literal in this file.
 *
 * NOTE ON ASYNC. The HTTP server runs in this process, so every git invocation
 * here must be asynchronous. A synchronous spawn blocks the event loop, the
 * server never answers, and the clone hangs until it times out.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGitHttpServer } from "./helpers/git-http-server.mjs";
import { createCheckpoint, loadCheckpoint, restoreCheckpoint, defaultGitRunner } from "../dist/state/checkpoint-bundle.js";
import { GitAdapter } from "../dist/adapters/git-worktree.js";

/**
 * The only "credentials" in play. Not real tokens, never leave 127.0.0.1.
 *
 * Shaped like real `ghp_` classic tokens (no underscore after the prefix) on
 * purpose: `redactTokenShapes` matches `gh[posru]_[A-Za-z0-9]{20,}`, and a
 * fixture with an underscore in the body would quietly slip past the very
 * redaction these tests are here to prove.
 */
const TOKEN = "ghp_" + "T3stOnly" + "abcdefghijklmnopqrstuvwxyz0123";
const OTHER_TOKEN = "ghp_" + "0th3rOne" + "zyxwvutsrqponmlkjihgfedcba9876";

let T;
let server;
/** A genuine blob:none partial clone whose promisor remote requires auth. */
let partialWorktree;
/** An ordinary local repository with every object present. */
let localWorktree;
let checkpointRoot;

const BASE_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", HOME: T });

function git(args, cwd, env = {}) {
  return new Promise((resolve) =>
    execFile("git", args, { cwd, env: { ...BASE_ENV(), ...env }, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })));
}

async function mustGit(args, cwd, env) {
  const r = await git(args, cwd, env);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
}

before(async () => {
  T = mkdtempSync(join(tmpdir(), "rc10-f1-"));
  checkpointRoot = join(T, "durable");

  // --- an origin that behaves like a real promisor remote ---
  const origin = join(T, "origin.git");
  await mustGit(["init", "-q", "--bare", origin], T);
  await mustGit(["-C", origin, "config", "uploadpack.allowfilter", "true"], T);
  await mustGit(["-C", origin, "config", "uploadpack.allowanysha1inwant", "true"], T);

  const seed = join(T, "seed");
  await mustGit(["init", "-q", seed], T);
  await mustGit(["-C", seed, "config", "user.email", "t@example.invalid"], T);
  await mustGit(["-C", seed, "config", "user.name", "t"], T);
  // Distinct content per commit, so historical blobs are distinct objects that
  // a blob:none checkout does NOT hold. This is what makes the bundle fetch.
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(seed, "data.txt"), `revision ${i} ${"payload".repeat(40)}`);
    await mustGit(["-C", seed, "add", "."], T);
    await mustGit(["-C", seed, "commit", "-qm", `c${i}`], T);
  }
  await mustGit(["-C", seed, "branch", "-M", "feature"], T);
  await mustGit(["-C", seed, "remote", "add", "origin", origin], T);
  await mustGit(["-C", seed, "push", "-q", "origin", "feature"], T);

  server = await startGitHttpServer({ repoPath: origin, password: TOKEN });

  // The beta.34 arrangement: a helper that holds no secret and reads
  // $OAH_GH_TOKEN from whatever environment git is invoked with.
  const helper = join(T, "cred.sh");
  writeFileSync(
    helper,
    `#!/bin/sh\ncase "$1" in\n  get)\n    printf 'username=x-access-token\\n'\n    printf 'password=%s\\n' "$OAH_GH_TOKEN"\n    ;;\nesac\n`,
  );
  chmodSync(helper, 0o700);

  partialWorktree = join(T, "partial");
  await mustGit(
    ["clone", "-q", "--filter=blob:none", "--branch", "feature",
      "-c", "credential.helper=", "-c", `credential.helper=${helper}`,
      server.url, partialWorktree],
    T,
    { OAH_GH_TOKEN: TOKEN },
  );

  // A plain local repo, for the "no network involved" control.
  localWorktree = join(T, "local");
  await mustGit(["init", "-q", "-b", "feature", localWorktree], T);
  await mustGit(["-C", localWorktree, "config", "user.email", "t@example.invalid"], T);
  await mustGit(["-C", localWorktree, "config", "user.name", "t"], T);
  writeFileSync(join(localWorktree, "a.txt"), "local only");
  await mustGit(["-C", localWorktree, "add", "."], T);
  await mustGit(["-C", localWorktree, "commit", "-qm", "local"], T);
});

after(async () => {
  await server?.close();
  try { rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* ------------------------------------------------------------------ *
 * 1. The fixture really is the incident's shape
 * ------------------------------------------------------------------ */

test("rc.10 (F1): the worktree is a genuine promisor partial clone", async () => {
  const promisor = await git(["-C", partialWorktree, "config", "remote.origin.promisor"], T);
  const filter = await git(["-C", partialWorktree, "config", "remote.origin.partialclonefilter"], T);
  assert.equal(promisor.stdout.trim(), "true");
  assert.equal(filter.stdout.trim(), "blob:none", "the same filter the harness allocates worktrees with");
});

test("rc.10 (F1, audits 5602/5628): an unauthenticated bundle fails exactly as recorded", async () => {
  const r = await git(["bundle", "create", join(T, "manual.bundle"), "feature"], partialWorktree, {
    OAH_GH_TOKEN: "",
  });
  assert.notEqual(r.code, 0, "rc.9 believed this was a local operation");
  assert.match(r.stderr, /could not fetch .* from promisor remote/);
  assert.match(r.stderr, /pack-objects died/);
});

/* ------------------------------------------------------------------ *
 * 2. createCheckpoint through the rc.9 default runner, and through
 *    the adapter's authenticated one
 * ------------------------------------------------------------------ */

test("rc.10 (F1): rc.9's default runner cannot checkpoint a private partial clone", async () => {
  const res = await createCheckpoint({
    sessionId: "s-default",
    cycle: 1,
    worktreePath: partialWorktree,
    branch: "feature",
    checkpointRoot,
    git: (args, cwd) => defaultGitRunner(args, cwd), // no env, exactly as shipped
  });
  assert.equal(res.durable, false, "this is the rc.9 behaviour the incident recorded");
  assert.equal(res.manifest.recoverable, false);
  assert.match(res.manifest.error ?? "", /bundle create failed/);
  assert.match(res.manifest.error ?? "", /promisor remote/);
});

test("rc.10 (F1): the adapter's authenticated runner makes the same checkpoint durable", async () => {
  const adapter = new GitAdapter({ worktreesRoot: join(T, "unused"), logger: silentLogger() });
  const auth = await adapter.authenticatedRunner(TOKEN);
  try {
    const res = await createCheckpoint({
      sessionId: "s-auth",
      cycle: 1,
      subTaskId: "3",
      worktreePath: partialWorktree,
      branch: "feature",
      checkpointRoot,
      git: auth.run,
    });
    assert.equal(res.durable, true, res.manifest.error ?? "expected a durable checkpoint");
    assert.equal(res.manifest.recoverable, true);
    assert.ok(res.manifest.commitCount >= 4);
    assert.ok(res.manifest.bundleSha256);

    // And it must survive a re-read, which re-verifies the bytes.
    const reloaded = loadCheckpoint(res.manifestPath);
    assert.ok(reloaded, "a durable checkpoint must load");
    assert.equal(reloaded.tip, res.manifest.tip);
  } finally {
    await auth.dispose();
  }
});

test("rc.10 (F1): the durable checkpoint actually restores the commits", async () => {
  // The point of the whole module: not that a file exists, but that the work
  // comes back. This is what the incident never got to prove.
  const adapter = new GitAdapter({ worktreesRoot: join(T, "unused"), logger: silentLogger() });
  const auth = await adapter.authenticatedRunner(TOKEN);
  let manifestPath;
  try {
    const res = await createCheckpoint({
      sessionId: "s-restore",
      cycle: 1,
      worktreePath: partialWorktree,
      branch: "feature",
      checkpointRoot,
      git: auth.run,
    });
    assert.equal(res.durable, true, res.manifest.error ?? "");
    manifestPath = res.manifestPath;
    const target = join(T, "restored");
    const out = await restoreCheckpoint(manifestPath, target);
    assert.equal(out.ok, true, out.reason ?? "");
    assert.equal(out.tip, res.manifest.tip);
    const log = await git(["-C", target, "rev-list", "--count", "HEAD"], T);
    assert.ok(Number.parseInt(log.stdout.trim(), 10) >= 4);
  } finally {
    await auth.dispose();
  }
});

test("rc.10 (F1): an INVALID credential is not durable, and says so honestly", async () => {
  const adapter = new GitAdapter({ worktreesRoot: join(T, "unused"), logger: silentLogger() });
  const auth = await adapter.authenticatedRunner("ghp_TESTONLY_WRONG_" + "z".repeat(18));
  try {
    const res = await createCheckpoint({
      sessionId: "s-badcred",
      cycle: 1,
      worktreePath: join(T, "partial-fresh-invalid"),
      branch: "feature",
      checkpointRoot,
      git: auth.run,
    });
    assert.equal(res.durable, false);
    assert.match(res.manifest.error ?? "", /does not exist/, "a missing worktree is reported as such");
  } finally {
    await auth.dispose();
  }
});

test("rc.10 (F1): a checkpoint of a plain local repo needs no credential at all", async () => {
  // The fix must not make the no-network case depend on a token.
  const res = await createCheckpoint({
    sessionId: "s-local",
    cycle: 1,
    worktreePath: localWorktree,
    branch: "feature",
    checkpointRoot,
  });
  assert.equal(res.durable, true, res.manifest.error ?? "");
  assert.equal(res.manifest.commitCount, 1);
});

/* ------------------------------------------------------------------ *
 * 3. The credential must reach the child env and nowhere else
 * ------------------------------------------------------------------ */

test("rc.10 (F1): the token reaches git through the ENVIRONMENT, not argv", async () => {
  const adapter = new GitAdapter({ worktreesRoot: join(T, "unused"), logger: silentLogger() });
  const withToken = await adapter.authenticatedRunner(TOKEN);
  const without = await adapter.authenticatedRunner();
  try {
    // A real git shell alias, so this is git's own view of its own environment.
    const probe = ["-c", 'alias.probe=!printf "%s" "$OAH_GH_TOKEN"', "probe"];
    const seen = await withToken.run(probe, partialWorktree);
    const blank = await without.run(probe, partialWorktree);
    assert.equal(seen.code, 0, seen.stderr);

    // It comes back as `***` rather than as the token, and that IS the proof:
    // the runner redacts its own output, and redaction only fires on a value
    // that was actually there. The unauthenticated runner echoes nothing.
    assert.equal(seen.stdout.trim(), "***", "git saw a value in $OAH_GH_TOKEN");
    assert.equal(blank.stdout.trim(), "", "and sees none when no token is routed");
  } finally {
    await withToken.dispose();
    await without.dispose();
  }
});

test("rc.10 (F1): two requesters' runners cannot see each other's token", async () => {
  const adapter = new GitAdapter({ worktreesRoot: join(T, "unused"), logger: silentLogger() });
  const a = await adapter.authenticatedRunner(TOKEN);
  const b = await adapter.authenticatedRunner(OTHER_TOKEN);
  try {
    // Checksum rather than the value: each runner redacts its own token out of
    // its own output, so comparing the raw strings would compare two `***`.
    // A checksum identifies WHICH token the child actually held.
    const probe = ["-c", 'alias.probe=!printf "%s" "$OAH_GH_TOKEN" | cksum', "probe"];
    // Concurrently, because that is the case that would expose shared state.
    const [ra, rb] = await Promise.all([a.run(probe, partialWorktree), b.run(probe, partialWorktree)]);
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(rb.code, 0, rb.stderr);
    assert.notEqual(ra.stdout.trim(), rb.stdout.trim(), "each child held its own requester's token");

    const expect = async (tok) => {
      const solo = await adapter.authenticatedRunner(tok);
      try { return (await solo.run(probe, partialWorktree)).stdout.trim(); } finally { await solo.dispose(); }
    };
    assert.equal(ra.stdout.trim(), await expect(TOKEN));
    assert.equal(rb.stdout.trim(), await expect(OTHER_TOKEN));
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

test("rc.10 (F1): a failure message carrying the token is redacted", async () => {
  const adapter = new GitAdapter({ worktreesRoot: join(T, "unused"), logger: silentLogger() });
  const auth = await adapter.authenticatedRunner(TOKEN);
  try {
    // `rev-parse` on an unknown revision echoes the argument back in its error,
    // which is the shape that would otherwise put a token in a log line.
    const r = await auth.run(["rev-parse", TOKEN], partialWorktree);
    assert.notEqual(r.code, 0);
    assert.ok(!r.stderr.includes(TOKEN), "the token must not survive into an error string");
    assert.ok(!r.stdout.includes(TOKEN));
    assert.match(r.stderr, /\*\*\*/);
  } finally {
    await auth.dispose();
  }
});

test("rc.10 (F1): the askpass helper is removed when the checkpoint is done", async () => {
  const adapter = new GitAdapter({ worktreesRoot: join(T, "unused"), logger: silentLogger() });
  const auth = await adapter.authenticatedRunner(TOKEN);
  const probe = await auth.run(["-c", 'alias.p=!printf "%s" "$GIT_ASKPASS"', "p"], partialWorktree);
  const askpath = probe.stdout.trim();
  assert.ok(askpath && existsSync(askpath), "precondition: an askpass helper was written");
  assert.ok(!readFileSync(askpath, "utf8").includes(TOKEN), "the secret is never written to disk");
  await auth.dispose();
  assert.ok(!existsSync(askpath), "disposed with the checkpoint, not left in tmp");
});

test("rc.10 (F1): no token is persisted into the repository config or the remote URL", async () => {
  const cfg = readFileSync(join(partialWorktree, ".git", "config"), "utf8");
  assert.ok(!cfg.includes(TOKEN), "the token must never reach a persisted remote URL or config");
  const remote = await git(["-C", partialWorktree, "remote", "get-url", "origin"], T);
  assert.ok(!remote.stdout.includes(TOKEN));
});

test("rc.10 (F1): a failed checkpoint manifest carries no secret", async () => {
  const adapter = new GitAdapter({ worktreesRoot: join(T, "unused"), logger: silentLogger() });
  const auth = await adapter.authenticatedRunner(TOKEN);
  try {
    const res = await createCheckpoint({
      sessionId: "s-manifest",
      cycle: 1,
      worktreePath: partialWorktree,
      branch: `nonexistent-${TOKEN}`,
      checkpointRoot,
      git: auth.run,
    });
    assert.equal(res.durable, false);
    assert.ok(res.manifestPath, "a failure is still recorded");
    const written = readFileSync(res.manifestPath, "utf8");
    assert.ok(!written.includes(TOKEN), "redaction covers what gets written, not just what gets logged");
  } finally {
    await auth.dispose();
  }
});

/* ------------------------------------------------------------------ *
 * 4. The wiring, so the runner is actually reached in production
 * ------------------------------------------------------------------ */

test("rc.10 (F1): the loop hands the authenticated runner to createCheckpoint", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const loop = rf(new URL("../src/orchestrator/loop.ts", import.meta.url), "utf8");
  assert.match(loop, /checkpointGitRunner/, "the dependency exists");
  assert.match(loop, /git: auth\?\.run/, "and is passed to createCheckpoint");
  assert.match(loop, /await auth\.dispose\(\)/, "and disposed");

  const index = rf(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /checkpointGitRunner: async \(\{ repo, requester \}\)/, "wired in production");
  // Routed through the SAME pat.resolve/resolveGitToken path as a push, not a
  // second credential mechanism.
  const at = index.indexOf("checkpointGitRunner:");
  const body = index.slice(at, at + 700);
  assert.match(body, /pat\.resolve/);
  assert.match(body, /resolveGitToken/);
});

test("rc.10 (F1): a real run routes its checkpoint through the authenticated runner", async () => {
  // The two tests above this one read src/. That is worth something, but it is
  // exactly the shape the scenario helper's header warns about: a grep for the
  // call site passes while the feature is dead. The mutation check found it --
  // disabling the wiring in dist/ left every F1 test green, because none of
  // them ran the loop. This one does.
  const { scenarioAvailable, runScenario, mutateSubTask, makeWorld } = await import("./helpers/scenario.mjs");
  if (!(await scenarioAvailable())) return;

  const base = mkdtempSync(join(tmpdir(), "rc10-cp-wiring-"));
  const checkpointRoot = join(base, "checkpoints");
  const world = await makeWorld();

  // Records every call, and really runs git, so the bundle produced is real.
  const calls = [];
  const runs = [];
  let disposed = 0;

  const res = await runScenario({
    world,
    configOver: {
      storage: {
        state_db_path: ":memory:",
        worktree_root: join(base, "wt"),
        checkpoint_root: checkpointRoot,
        audit_retention_days: 90,
        prune_terminal_sessions: 365,
      },
    },
    subTasks: [mutateSubTask({ seq: 1, title: "add a thing", path: "src/thing.ts" })],
    deps: {
      checkpointGitRunner: async ({ repo, requester }) => {
        calls.push({ repo, requester });
        return {
          run: async (args, cwd) => {
            runs.push(args[0]);
            const { defaultGitRunner } = await import("../dist/state/checkpoint-bundle.js");
            return defaultGitRunner(args, cwd);
          },
          dispose: async () => {
            disposed += 1;
          },
        };
      },
    },
  });

  assert.ok(calls.length > 0, "the loop never asked for a credential for the checkpoint");
  // It asks for the credential of the session's repo and requester, which is
  // the whole point -- a checkpoint fetches from that repo's promisor remote.
  assert.equal(calls[0].repo, "o/r");
  assert.equal(calls[0].requester, "U1");
  // And the runner it got back is the one git actually ran on.
  assert.ok(runs.includes("bundle"), `the bundle must run on the authenticated runner, saw ${JSON.stringify(runs)}`);
  assert.equal(disposed, calls.length, "every runner obtained is disposed");
  assert.ok(res.out.status !== undefined);
  rmSync(base, { recursive: true, force: true });
});

test("rc.10 (F1): credential resolution failing does not take the run down", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const loop = rf(new URL("../src/orchestrator/loop.ts", import.meta.url), "utf8");
  const at = loop.indexOf("if (this.deps.checkpointGitRunner && repo && requester)");
  assert.ok(at > 0);
  const body = loop.slice(at, at + 600);
  assert.match(body, /catch/, "a vault that will not open is recorded, not thrown");
  assert.match(body, /checkpoint_auth_unavailable/);
});

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
