// beta.29 restored: keep authenticated worktree coverage; replace retired thread reclaim with strict control state.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { allowedControlTransitions, isTerminalControlState } from "../dist/control/state-machine.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("beta29: worktree add is invoked with askpass in source", () => {
  const src = readFileSync(resolve(root, "src/adapters/git-worktree.ts"), "utf8");
  assert.match(src, /run\(\s*\[\s*"-C",\s*bare,\s*"worktree",\s*"add"[\s\S]*?\]\s*,\s*undefined\s*,\s*ask\.path\s*(?:,\s*ctx\.ghToken\s*)?\)/);
});

test("beta29: compiled worktree add carries askpass", { skip: !existsSync(resolve(root, "dist/adapters/git-worktree.js")) }, () => {
  assert.match(readFileSync(resolve(root, "dist/adapters/git-worktree.js"), "utf8"), /"worktree",\s*"add"[\s\S]{0,180}?ask\.path/);
});

test("beta29: canonical terminal states cannot be reclaimed into new work", () => {
  for (const state of ["done", "failed", "cancelled"]) {
    assert.equal(isTerminalControlState(state), true);
    assert.deepEqual(allowedControlTransitions(state), []);
  }
  assert.equal(isTerminalControlState("autonomous_run"), false);
});
