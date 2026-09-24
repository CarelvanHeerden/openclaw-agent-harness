import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createManagedTemp, pruneManagedTemps } from "../scripts/managed-temp.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

test("managed temporary workspaces prune abandoned owners but preserve live processes", () => {
  const parent = mkdtempSync(join(process.env.TMPDIR || "/tmp", "oah-managed-temp-test-"));
  try {
    const stale = join(parent, ".oah-test-stale");
    mkdirSync(stale);
    writeFileSync(join(stale, ".oah-temp-owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: 1 }));
    const live = join(parent, ".oah-test-live");
    mkdirSync(live);
    writeFileSync(join(live, ".oah-temp-owner.json"), JSON.stringify({ pid: process.pid, createdAt: 1 }));

    assert.deepEqual(pruneManagedTemps(parent, ".oah-test-", { staleAfterMs: 0 }), [stale]);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(live), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("managed temporary workspaces clean up on termination signals", () => {
  const parent = mkdtempSync(join(process.env.TMPDIR || "/tmp", "oah-managed-temp-signal-"));
  try {
    const helper = pathToFileURL(join(root, "scripts", "managed-temp.mjs")).href;
    const script = `import { createManagedTemp } from ${JSON.stringify(helper)}; const managed = createManagedTemp(${JSON.stringify(parent)}, ".oah-child-"); console.log(managed.path); setTimeout(() => process.kill(process.pid, "SIGTERM"), 20); setInterval(() => {}, 1000);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    const path = child.stdout.trim().split("\n").at(-1);
    assert.equal(child.status, 143, child.stderr);
    assert.ok(path.startsWith(parent));
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("managed temporary workspace cleanup is idempotent", () => {
  const parent = mkdtempSync(join(process.env.TMPDIR || "/tmp", "oah-managed-temp-idempotent-"));
  try {
    const managed = createManagedTemp(parent, ".oah-idempotent-", { staleAfterMs: 0 });
    assert.equal(existsSync(managed.path), true);
    managed.cleanup();
    managed.cleanup();
    assert.equal(existsSync(managed.path), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
