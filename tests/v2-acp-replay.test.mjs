/**
 * M9: drive the adapter against REAL captured OpenCode sessions.
 *
 * The rest of the ACP suite uses a fixture we wrote, which agrees with the
 * adapter by construction — a shared misreading of the protocol would survive
 * all of it. These captures are actual wire transcripts recorded by
 * `probe/acp-probe.mjs` against OpenCode 1.18.11, before the adapter existed,
 * so they cannot be flattering.
 *
 * The first thing this found was `fs/write_text_file`: OpenCode asks permission
 * for an edit and then asks the CLIENT to perform the write, despite our
 * `initialize` declaring `fs: {writeTextFile: false}`. The adapter answered
 * `{}` — a success — for a write it never performed, so a worker delegating its
 * edits would lose every one of them and then report the sub-task done.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { assessOpenCodeVersion, CAPTURED_OPENCODE_VERSIONS, PINNED_OPENCODE_VERSION } from "../dist/adapters/opencode-version.js";
import { runWorkerAcp } from "../dist/adapters/acp.js";

const root = resolve(import.meta.dirname, "..");
const runsDir = resolve(root, "probe/runs");
const REPLAY = resolve(root, "tests/fixtures/acp-replay-agent.mjs");

const scratch = () => mkdtempSync(resolve(tmpdir(), "acp-replay-"));

/** Run the real adapter against a real captured session. */
function replayAgent(capturePath, extra) {
  return { command: process.execPath, args: [REPLAY, capturePath], env: { NO_COLOR: "1" }, ...extra };
}

const captures = readdirSync(runsDir)
  .filter((f) => f.startsWith("opencode-") && f.endsWith(".jsonl"))
  .map((f) => resolve(runsDir, f));

function framesOf(path) {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("the captures exist and are real OpenCode transcripts", () => {
  assert.ok(captures.length >= 3, `expected several captures, found ${captures.length}`);
  for (const path of captures) {
    const frames = framesOf(path);
    assert.ok(frames.length > 5, `${path} is too short to be a real session`);
    const init = frames.find((f) => f.dir === "in" && f.payload?.result?.agentInfo);
    assert.ok(init, `${path} has no initialize result`);
    assert.equal(init.payload.result.agentInfo.name, "OpenCode");
  }
});

test("the captured version is recorded, so the pin cannot drift silently past it", () => {
  const seen = new Set();
  for (const path of captures) {
    const init = framesOf(path).find((f) => f.dir === "in" && f.payload?.result?.agentInfo);
    seen.add(init.payload.result.agentInfo.version);
  }
  // The captures are a compatibility FLOOR, not the pin. If someone re-captures
  // against a newer build, this list must be updated deliberately.
  assert.deepEqual([...seen].sort(), [...CAPTURED_OPENCODE_VERSIONS].sort(),
    "the captured OpenCode versions no longer match CAPTURED_OPENCODE_VERSIONS");
});

// ---------------------------------------------------------------------------
// What the real transcripts prove about the protocol
// ---------------------------------------------------------------------------

test("real OpenCode asks permission before a bash call, which is what the guard depends on", () => {
  // The whole containment story rests on this round-trip existing. It is worth
  // asserting against a real transcript and not only against our own fixture.
  let found = false;
  for (const path of captures) {
    for (const f of framesOf(path)) {
      if (f.dir !== "in" || f.payload?.method !== "session/request_permission") continue;
      const call = f.payload.params?.toolCall ?? {};
      if (call.kind !== "execute") continue;
      found = true;
      // The fields the guard reads must actually be present.
      assert.ok(call.rawInput?.command, "a real permission request carried no command for the guard to inspect");
      assert.ok(Array.isArray(f.payload.params.options) && f.payload.params.options.length > 0,
        "a real permission request offered no options to select");
      assert.ok(f.payload.params.options.some((o) => o.kind === "reject_once" || o.kind === "reject_always"),
        "a real permission request offered no way to REFUSE");
    }
  }
  assert.ok(found, "no captured bash permission request at all");
});

test("real OpenCode sends fs/write_text_file despite our fs:false — the case the fixture never showed", () => {
  const writes = [];
  for (const path of captures) {
    for (const f of framesOf(path)) {
      if (f.dir === "in" && f.payload?.method === "fs/write_text_file") writes.push(f.payload);
    }
  }
  assert.ok(writes.length > 0, "the captures no longer contain the fs/write_text_file case");
  for (const w of writes) {
    assert.ok(w.id !== undefined, "fs/write_text_file arrived as a notification, not a request");
    assert.ok(w.params?.path, "fs/write_text_file carried no path");
  }
});

test("the write is delegated AFTER the permission round-trip, not instead of it", () => {
  // This is the detail that decides whether refusing the write is safe. If the
  // agent asked us to write WITHOUT asking permission first, refusing would be
  // the only thing standing between it and an unguarded edit. It does ask, so
  // refusing merely pushes it back onto its own tooling — which is guarded.
  for (const path of captures) {
    const frames = framesOf(path);
    const writeAt = frames.findIndex((f) => f.dir === "in" && f.payload?.method === "fs/write_text_file");
    if (writeAt === -1) continue;
    const permBefore = frames
      .slice(0, writeAt)
      .some((f) => f.dir === "in" && f.payload?.method === "session/request_permission"
        && f.payload.params?.toolCall?.kind === "edit");
    assert.ok(permBefore, `${path}: a client-side write arrived with no edit permission request before it`);
  }
});

// ---------------------------------------------------------------------------
// The adapter's answer
// ---------------------------------------------------------------------------

test("the adapter refuses a capability it declined, rather than falsely reporting success", () => {
  const src = readFileSync(resolve(root, "src/adapters/acp.ts"), "utf8");

  // It must not silently succeed.
  assert.match(src, /AcpClientCapabilityError/, "there is no distinct capability-refusal error");
  assert.match(src, /if \(method === "fs\/write_text_file"\)[\s\S]{0,600}throw new AcpClientCapabilityError/,
    "fs/write_text_file no longer refuses");
  assert.match(src, /if \(method === "fs\/read_text_file"\)[\s\S]{0,200}throw new AcpClientCapabilityError/,
    "fs/read_text_file no longer refuses");

  // And a throw must become a JSON-RPC error, not an empty result — otherwise
  // the refusal is swallowed back into the same lie.
  const dispatch = src.slice(src.indexOf("result = await this.onRequest"));
  assert.match(dispatch.slice(0, 1200), /error: \{/, "a handler throw no longer produces a JSON-RPC error");
  assert.match(dispatch.slice(0, 1200), /-32601/, "a declined capability is not reported as method-not-found");
});

test("the old blanket 'return {}' on error is gone", () => {
  const src = readFileSync(resolve(root, "src/adapters/acp.ts"), "utf8");
  assert.doesNotMatch(src, /\} catch \{\s*result = \{\};\s*\}/,
    "handler failures are still collapsed into a successful empty result");
});

// ---------------------------------------------------------------------------
// End to end: the real adapter against a real transcript
// ---------------------------------------------------------------------------

/** A capture that contains the delegated-write case. */
const withWrite = captures.find((p) =>
  framesOf(p).some((f) => f.dir === "in" && f.payload?.method === "fs/write_text_file"));

test("the adapter completes a turn driven by a real captured session", async () => {
  assert.ok(withWrite, "no capture contains the fs/write_text_file case");
  const r = await runWorkerAcp({
    agent: replayAgent(withWrite),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 25,
    acpGuard: async () => ({ allow: true }),
  });
  // The point is that it survives the real frame sequence without hanging or
  // throwing. What the captured agent "said" is not interesting; that it drove
  // the adapter through initialize, authenticate, session/new and
  // session/prompt without the adapter losing the plot, is.
  assert.ok(r, "the adapter returned nothing for a real captured session");
  assert.equal(typeof r.finalMessage, "string");
});

test("the guard is consulted for the real permission requests, with a usable command", async () => {
  const seen = [];
  await runWorkerAcp({
    agent: replayAgent(withWrite),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 25,
    acpGuard: async (call) => { seen.push(call); return { allow: true }; },
  });
  assert.ok(seen.length > 0, "the guard was never consulted on a real session");
  // The guard reads `rawInput.command` for bash. If the real frames did not
  // populate it, every bash decision would be made on undefined.
  const exec = seen.find((c) => c.kind === "execute");
  assert.ok(exec, "no execute permission reached the guard");
  assert.ok(exec.rawInput?.command, "the guard received an execute call with no command");
});

test("a denial on a real session is honoured and recorded", async () => {
  const r = await runWorkerAcp({
    agent: replayAgent(withWrite),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 25,
    acpGuard: async () => ({ allow: false, reason: "denied by test" }),
  });
  assert.ok(r.deniedToolCalls.length > 0, "a blanket denial produced no recorded denials");
  assert.match(r.deniedToolCalls[0].reason, /denied by test/);
});

test("the agent is told the delegated write FAILED, not that it succeeded", async () => {
  // The only place this difference is visible is on the agent's side, so the
  // replay agent records what the client answered. Asserting on the adapter's
  // source would pass just as happily against a `return {}`.
  const reportPath = resolve(scratch(), "report.json");
  await runWorkerAcp({
    agent: replayAgent(withWrite, { env: { NO_COLOR: "1", ACP_REPLAY_REPORT: reportPath } }),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 25,
    acpGuard: async () => ({ allow: true }),
  });

  const observed = JSON.parse(readFileSync(reportPath, "utf8"));
  const write = observed.find((o) => o.method === "fs/write_text_file");
  assert.ok(write, "the agent never received an answer to fs/write_text_file");
  assert.equal(write.ok, false,
    "the agent was told its delegated write SUCCEEDED; it never happened, and the worker's edits are gone");
  assert.equal(write.errorCode, -32601,
    "a declined capability was not reported as method-not-found, so the agent may retry rather than fall back");
});

test("permission requests are still answered successfully, so the refusal is targeted", () => {
  // A blanket "error everything" would also kill the mutation but break the
  // guard. This pins that only the declined capabilities are refused.
  const src = readFileSync(resolve(root, "src/adapters/acp.ts"), "utf8");
  assert.match(src, /return \{ outcome: \{ outcome: "selected"/,
    "permission requests no longer return a selected outcome");
});

test("the delegated write is refused without wedging the turn", async () => {
  // The failure this guards: refusing a request the agent is BLOCKED on, in a
  // way that never answers, hangs the session until the timeout. The refusal
  // has to be a reply, not silence.
  const started = Date.now();
  const r = await runWorkerAcp({
    agent: replayAgent(withWrite),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 25,
    acpGuard: async () => ({ allow: true }),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20_000, `the turn took ${elapsed}ms; the refusal probably wedged it`);
  assert.ok(r, "the turn produced no result");
});

// ---------------------------------------------------------------------------
// The version policy
// ---------------------------------------------------------------------------

test("an exact version match does not warn", () => {
  const a = assessOpenCodeVersion(PINNED_OPENCODE_VERSION);
  assert.equal(a.relation, "exact");
  assert.equal(a.warn, false);
});

test("a mismatch warns and says the probe is what actually gates safety", () => {
  for (const [v, rel] of [["1.18.22", "patch"], ["1.19.0", "minor"], ["2.0.0", "major"]]) {
    const a = assessOpenCodeVersion(v);
    assert.equal(a.relation, rel, `${v} classified as ${a.relation}`);
    assert.equal(a.warn, true);
    assert.match(a.message, /probe/, `${v}: the warning does not point at the real gate`);
  }
});

test("an agent that reports no version warns rather than passing", () => {
  // An agent that will not say what it is, is exactly when a recorded
  // diagnostic is worth having.
  for (const v of [undefined, "", "   "]) {
    const a = assessOpenCodeVersion(v);
    assert.equal(a.relation, "unknown");
    assert.equal(a.warn, true);
  }
  const junk = assessOpenCodeVersion("not-a-version");
  assert.equal(junk.relation, "unknown");
  assert.equal(junk.warn, true);
});

test("the captured build is classified against the pin without throwing", () => {
  // The captures are older than the pin. That must read as a normal mismatch,
  // not as a parse failure.
  for (const v of CAPTURED_OPENCODE_VERSIONS) {
    const a = assessOpenCodeVersion(v);
    assert.equal(a.warn, true);
    assert.notEqual(a.relation, "unknown", `${v} did not parse`);
  }
});

test("the adapter reads agentInfo.version and reports a mismatch to the caller", () => {
  const src = readFileSync(resolve(root, "src/adapters/acp.ts"), "utf8");
  assert.match(src, /agentInfo\?\.version/, "the initialize result's version is still discarded");
  assert.match(src, /onVersionMismatch\?\./, "a version mismatch is not reported to the caller");
  // Warn, not refuse: a hard pin would break an operator on a working setup
  // for a patch release, and the probe is the actual safety gate.
  assert.doesNotMatch(src, /throw new Error\(`?opencode version/i, "a version mismatch became fatal");
});

test("the pinned version is a single source of truth", () => {
  const ver = readFileSync(resolve(root, "src/adapters/opencode-version.ts"), "utf8");
  assert.match(ver, /PINNED_OPENCODE_PACKAGE = `opencode-ai@\$\{PINNED_OPENCODE_VERSION\}`/,
    "the package spec is not derived from the pinned version");

  // The pin lived in the Dockerfile until the packaging fix, which was the
  // whole defect: OpenClaw installs a plugin with `npm install --omit=dev` and
  // never builds our Dockerfile, so the pin governed the one environment that
  // did not need it and nothing about the one that did. `package.json` is what
  // actually decides which OpenCode an installed plugin gets, so that is what
  // has to agree with the constant.
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.dependencies?.["opencode-ai"], PINNED_OPENCODE_VERSION,
    `package.json must declare opencode-ai as a PRODUCTION dependency at exactly ${PINNED_OPENCODE_VERSION}`);

  // Exact, not a range. A caret would let `npm install` pick a version the
  // permission-key list has never been reconciled against, and that list is
  // version-coupled: OpenCode merges permission rules last-match-wins, so a key
  // added by a newer release and allowed by a repo's own opencode.json sorts
  // after our injected wildcard and wins.
  assert.doesNotMatch(pkg.dependencies["opencode-ai"], /[\^~*x]|\s-\s/,
    "the opencode-ai dependency must be an exact version, not a range");
});
