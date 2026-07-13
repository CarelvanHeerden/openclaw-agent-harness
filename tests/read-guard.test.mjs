import test from "node:test";
import assert from "node:assert/strict";

let buildBashGuard;
try {
  ({ buildBashGuard } = await import("../dist/safety/bash-guard.js"));
} catch {
  buildBashGuard = null;
}

function makeGuard(extraDeny = []) {
  return buildBashGuard({
    bash_whitelist: ["git", "npm", "node", "ls", "cat", "test"],
    bash_denylist_tokens: ["sudo", "rm"],
    path_denylist: [".env", "*.pem", "credentials.db", "**/id_rsa", "/etc/", ...extraDeny],
    allow_git_push: false,
    allow_network_commands: false,
  });
}

test("read-guard: Read on .env is denied",
  { skip: buildBashGuard === null }, async () => {
    const guard = makeGuard();
    const r = await guard("Read", { file_path: "/repo/.env" });
    assert.equal(r.allow, false);
    assert.match(r.reason, /read path .* is denylisted/);
  });

test("read-guard: Read on plain source file is allowed",
  { skip: buildBashGuard === null }, async () => {
    const guard = makeGuard();
    const r = await guard("Read", { file_path: "/repo/src/index.ts" });
    assert.equal(r.allow, true);
  });

test("read-guard: NotebookRead honours the same denylist",
  { skip: buildBashGuard === null }, async () => {
    const guard = makeGuard();
    const r = await guard("NotebookRead", { notebook_path: "/repo/credentials.db" });
    assert.equal(r.allow, false);
  });

test("read-guard: Read of *.pem private key is denied",
  { skip: buildBashGuard === null }, async () => {
    const guard = makeGuard();
    const r = await guard("Read", { file_path: "/home/svc/key.pem" });
    assert.equal(r.allow, false);
  });

test("read-guard: Glob patterns that hit the denylist are refused",
  { skip: buildBashGuard === null }, async () => {
    const guard = makeGuard();
    const r = await guard("Glob", { pattern: "**/id_rsa" });
    assert.equal(r.allow, false);
  });

test("read-guard: Write side still denied for the same paths",
  { skip: buildBashGuard === null }, async () => {
    const guard = makeGuard();
    const r = await guard("Write", { file_path: "/repo/.env" });
    assert.equal(r.allow, false);
    assert.match(r.reason, /write path .* is denylisted/);
  });

test("read-guard: unknown tool passes through as allow",
  { skip: buildBashGuard === null }, async () => {
    const guard = makeGuard();
    const r = await guard("Task", { anything: true });
    assert.equal(r.allow, true);
  });
