/**
 * ACP permission-guard tests.
 *
 * The payload shapes asserted here are not invented: they are the shapes
 * observed on the wire from live OpenCode and Codex sessions during the M2
 * capability probe. See docs/acp-capability-matrix.md and probe/runs/.
 *
 * The central property under test is FAIL-CLOSED. Every field the guard reads
 * is optional in the ACP spec, so anything the guard cannot positively
 * identify as safe must be denied.
 */
import test from "node:test";
import assert from "node:assert/strict";

let buildAcpGuard, acpPathsFromToolCall, acpCommandFromToolCall;
try {
  ({ buildAcpGuard, acpPathsFromToolCall, acpCommandFromToolCall } = await import(
    "../dist/safety/bash-guard.js"
  ));
} catch {
  buildAcpGuard = null;
}

const skip = { skip: buildAcpGuard === null };

function makeGuard(over = {}) {
  return buildAcpGuard({
    bash_whitelist: ["git", "npm", "node", "ls", "cat", "echo", "test"],
    bash_denylist_tokens: ["sudo", "rm", "curl"],
    path_denylist: [".env", "*.pem", "credentials.db", "**/id_rsa", "/etc/"],
    allow_git_push: false,
    allow_network_commands: false,
    ...over,
  });
}

// --- fail-closed: the property that makes this safe to point at any backend ---

test("acp-guard: a tool call with no kind is denied", skip, async () => {
  const r = await makeGuard()({ rawInput: { command: "ls" } });
  assert.equal(r.allow, false);
  assert.match(r.reason, /no kind/i);
});

test("acp-guard: an unrecognised kind is denied", skip, async () => {
  const r = await makeGuard()({ kind: "teleport", rawInput: {} });
  assert.equal(r.allow, false);
  assert.match(r.reason, /unrecognised/i);
});

test("acp-guard: execute with no command string is denied", skip, async () => {
  // Exactly the OpenCode status:"pending" payload -- cwd present, command absent.
  const r = await makeGuard()({
    kind: "execute",
    rawInput: { cwd: "/repo" },
  });
  assert.equal(r.allow, false);
  assert.match(r.reason, /no command/i);
});

test("acp-guard: edit exposing no path at all is denied", skip, async () => {
  const r = await makeGuard()({ kind: "edit", rawInput: {}, locations: [] });
  assert.equal(r.allow, false);
  assert.match(r.reason, /no path/i);
});

test("acp-guard: search exposing no pattern is denied", skip, async () => {
  const r = await makeGuard()({ kind: "search", rawInput: {} });
  assert.equal(r.allow, false);
  assert.match(r.reason, /no pattern/i);
});

// --- execute: the bash whitelist/denylist must actually run ---

test("acp-guard: OpenCode-shaped execute runs guardCommand and allows a safe command", skip, async () => {
  const r = await makeGuard()({
    kind: "execute",
    rawInput: { command: "echo acp-probe-marker", cwd: "/repo" },
  });
  assert.equal(r.allow, true);
});

test("acp-guard: execute of a denylisted token is rejected", skip, async () => {
  const r = await makeGuard()({
    kind: "execute",
    rawInput: { command: "sudo rm -rf /", cwd: "/repo" },
  });
  assert.equal(r.allow, false);
});

test("acp-guard: execute of a non-whitelisted binary is rejected", skip, async () => {
  const r = await makeGuard()({ kind: "execute", rawInput: { command: "wget http://x" } });
  assert.equal(r.allow, false);
});

test("acp-guard: execute cannot read a denylisted path via cat", skip, async () => {
  const r = await makeGuard()({ kind: "execute", rawInput: { command: "cat .env" } });
  assert.equal(r.allow, false);
});

test("acp-guard: Codex-shaped execute payload is understood", skip, async () => {
  // Codex carries extra bookkeeping keys alongside the command.
  const r = await makeGuard()({
    kind: "execute",
    rawInput: {
      call_id: "call_7tDPVhD",
      turn_id: "019fc724",
      started_at_ms: 1785752516290,
      command: "sudo cat /etc/shadow",
      cwd: "/repo",
      parsed_cmd: [{ type: "read" }],
    },
  });
  assert.equal(r.allow, false);
});

// --- edit/read paths, across all three observed payload shapes ---

test("acp-guard: OpenCode-shaped edit on .env is denied via filepath", skip, async () => {
  const r = await makeGuard()({
    kind: "edit",
    rawInput: { filepath: "/repo/.env", diff: "@@ -0,0 +1 @@\n+leak\n" },
    locations: [{ path: "/repo/.env" }],
  });
  assert.equal(r.allow, false);
  assert.match(r.reason, /denylisted/);
});

test("acp-guard: Codex-shaped edit is denied via the changes object KEYS", skip, async () => {
  // Codex edits carry no path field; the paths are the keys of `changes`.
  const r = await makeGuard()({
    kind: "edit",
    rawInput: {
      call_id: "call_x",
      changes: { "/repo/credentials.db": { type: "add", content: "x" } },
    },
  });
  assert.equal(r.allow, false);
  assert.match(r.reason, /denylisted/);
});

test("acp-guard: Claude-Code-shaped edit is denied via file_path", skip, async () => {
  const r = await makeGuard()({ kind: "edit", rawInput: { file_path: "/repo/server.pem" } });
  assert.equal(r.allow, false);
});

test("acp-guard: edit on an ordinary source file is allowed", skip, async () => {
  const r = await makeGuard()({
    kind: "edit",
    rawInput: { filepath: "/repo/src/index.ts" },
    locations: [{ path: "/repo/src/index.ts" }],
  });
  assert.equal(r.allow, true);
});

test("acp-guard: read of a denylisted path is denied", skip, async () => {
  const r = await makeGuard()({ kind: "read", locations: [{ path: "/repo/.env" }] });
  assert.equal(r.allow, false);
});

test("acp-guard: delete and move honour the denylist too", skip, async () => {
  const g = makeGuard();
  assert.equal((await g({ kind: "delete", rawInput: { path: "/repo/.env" } })).allow, false);
  assert.equal((await g({ kind: "move", rawInput: { path: "/repo/id_rsa" } })).allow, false);
});

test("acp-guard: a denylisted path anywhere in locations is denied", skip, async () => {
  // Multi-file edits must not pass just because the first path is innocent.
  const r = await makeGuard()({
    kind: "edit",
    locations: [{ path: "/repo/src/a.ts" }, { path: "/repo/.env" }],
  });
  assert.equal(r.allow, false);
});

// --- search / fetch / think ---

test("acp-guard: a glob that enumerates secrets is denied", skip, async () => {
  const r = await makeGuard()({ kind: "search", rawInput: { pattern: ".env" } });
  assert.equal(r.allow, false);
});

test("acp-guard: an ordinary search pattern is allowed", skip, async () => {
  const r = await makeGuard()({ kind: "search", rawInput: { pattern: "TODO" } });
  assert.equal(r.allow, true);
});

test("acp-guard: fetch is denied when network commands are off", skip, async () => {
  const r = await makeGuard()({ kind: "fetch", rawInput: { url: "http://example.com" } });
  assert.equal(r.allow, false);
});

test("acp-guard: fetch is allowed when network commands are enabled", skip, async () => {
  const g = makeGuard({ allow_network_commands: true });
  assert.equal((await g({ kind: "fetch", rawInput: { url: "http://example.com" } })).allow, true);
});

test("acp-guard: think has no side effect and is allowed", skip, async () => {
  const r = await makeGuard()({ kind: "think", rawInput: { thought: "planning" } });
  assert.equal(r.allow, true);
});

// --- extractor helpers ---

test("acp-guard: acpPathsFromToolCall unions locations, rawInput and changes keys", skip, () => {
  const paths = acpPathsFromToolCall({
    locations: [{ path: "/a" }, null, { path: "" }],
    rawInput: { filepath: "/b", file_path: "/c", changes: { "/d": {}, "/e": {} } },
  });
  assert.deepEqual(paths.sort(), ["/a", "/b", "/c", "/d", "/e"]);
});

test("acp-guard: acpCommandFromToolCall rejects blank and non-string commands", skip, () => {
  assert.equal(acpCommandFromToolCall({ rawInput: { command: "ls -la" } }), "ls -la");
  assert.equal(acpCommandFromToolCall({ rawInput: { command: "   " } }), null);
  assert.equal(acpCommandFromToolCall({ rawInput: { command: 42 } }), null);
  assert.equal(acpCommandFromToolCall({ rawInput: null }), null);
  assert.equal(acpCommandFromToolCall({}), null);
});

// --- regression: the Claude Code path must be untouched ---

test("acp-guard: buildBashGuard still allows unknown SDK tool names (unchanged behaviour)", skip, async () => {
  const { buildBashGuard } = await import("../dist/safety/bash-guard.js");
  const legacy = buildBashGuard({
    bash_whitelist: ["git"],
    bash_denylist_tokens: ["sudo"],
    path_denylist: [".env"],
    allow_git_push: false,
    allow_network_commands: false,
  });
  // Deliberately asserting the OLD fail-open behaviour: the SDK backend relies
  // on it and this change must not regress the working path.
  assert.equal((await legacy("WebSearch", { query: "x" })).allow, true);
  assert.equal((await legacy("Bash", { command: "sudo rm -rf /" })).allow, false);
});
