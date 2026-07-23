// beta.63 (Part B) — durable, structured, append-only INTERACTION LOG written
// OUTSIDE the git worktree. Fixes the b60 "silently stalled ~2 days,
// undiagnosable" failure class: the state.db lives inside the ephemeral
// worktree (released at teardown), the piped stdout freezes on restart, and
// the SDK/LLM calls are captured nowhere durable.
//
// Asserts:
//   - written OUTSIDE the worktree + survives a simulated worktree release
//   - JSONL parses
//   - MANDATORY secret redaction on a planted token (not disableable)
//   - full_prompts gate (off = sizes + tails only)
//   - retention prune of old files
//   - sdk_request-without-sdk_response is detectable (the stall signature)
//   - config + manifest wiring
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let InteractionLog, redactValue, redactTokenShapes, summarisePrompt, resolveInteractionLogConfig, PROMPT_TAIL_CHARS;
try {
  ({ InteractionLog, redactValue, redactTokenShapes, summarisePrompt, resolveInteractionLogConfig, PROMPT_TAIL_CHARS } =
    await import("../dist/state/interaction-log.js"));
} catch {
  InteractionLog = null;
}

function mkdir() {
  const d = resolve(tmpdir(), `harness-ilog-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cfg(dir, overrides = {}) {
  return { enabled: true, dir, fullPrompts: false, retentionDays: 14, ...overrides };
}

// ---- OUTSIDE the worktree + survives a simulated release ----
test("beta63: interaction log is written OUTSIDE the worktree and survives a release",
  { skip: InteractionLog === null }, () => {
    const dataDir = mkdir();
    const logDir = join(dataDir, "logs");
    const worktree = join(dataDir, "worktree"); // simulate the ephemeral worktree
    mkdirSync(worktree, { recursive: true });

    const ilog = new InteractionLog({ config: cfg(logDir) });
    ilog.log("S1", { event: "state_transition", phase: "worker", status: "executing" });

    const sessionFile = join(logDir, "session-S1.jsonl");
    assert.ok(existsSync(sessionFile), "session file must exist in the log dir");
    // The log dir must NOT be inside the worktree.
    assert.ok(!sessionFile.startsWith(worktree), "log must be OUTSIDE the worktree");

    // Simulate a worktree release: blow the worktree away.
    rmSync(worktree, { recursive: true, force: true });
    assert.ok(existsSync(sessionFile), "log survives the worktree release");
    const tail = ilog.readSessionTail("S1");
    assert.equal(tail.found, true);
    assert.equal(tail.events.length, 1);
    assert.equal(tail.events[0].event, "state_transition");
    rmSync(dataDir, { recursive: true, force: true });
  });

// ---- JSONL parses ----
test("beta63: each line is valid JSON (JSONL parses)", { skip: InteractionLog === null }, () => {
  const dir = mkdir();
  const ilog = new InteractionLog({ config: cfg(join(dir, "logs")) });
  ilog.log("S2", { event: "a" });
  ilog.log("S2", { event: "b" });
  ilog.log("S2", { event: "c" });
  const raw = readFileSync(join(dir, "logs", "session-S2.jsonl"), "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 3);
  for (const l of lines) JSON.parse(l); // must not throw
  // Global tail is also written.
  assert.ok(existsSync(join(dir, "logs", "harness-interactions.jsonl")));
  rmSync(dir, { recursive: true, force: true });
});

// ---- MANDATORY secret redaction on a planted token ----
test("beta63: redaction scrubs a planted token on write (not disableable)",
  { skip: InteractionLog === null }, () => {
    const dir = mkdir();
    const ilog = new InteractionLog({ config: cfg(join(dir, "logs"), { fullPrompts: true }) });
    const token = "sk-ant-abcdef0123456789ABCDEF";
    ilog.logSdkRequest("S3", {
      role: "worker", model: "claude-sonnet-5",
      prompt: `here is a secret ${token} and a url https://x-access-token:${token}@github.com/o/r.git`,
    });
    const raw = readFileSync(join(dir, "logs", "session-S3.jsonl"), "utf8");
    assert.ok(!raw.includes(token), "raw token must NOT appear in the log");
    assert.match(raw, /sk-ant-\*\*\*/, "token shape must be redacted");
    rmSync(dir, { recursive: true, force: true });
  });

test("beta63: redactValue deep-redacts nested strings + redactTokenShapes catches bare tokens",
  { skip: InteractionLog === null }, () => {
    const out = redactValue({ a: "ghp_0123456789abcdef0123456789abcdef", b: ["glpat-abcdef0123456789xyz", 5], n: 1 });
    assert.equal(out.n, 1);
    assert.ok(!JSON.stringify(out).includes("ghp_0123456789abcdef"), "github token redacted");
    assert.ok(!JSON.stringify(out).includes("glpat-abcdef0123456789xyz"), "gitlab token redacted");
    assert.match(redactTokenShapes("Bearer abcdefghij123456"), /Bearer \*\*\*/);
  });

// ---- full_prompts gate ----
test("beta63: full_prompts=false keeps only size + tail (no full body)",
  { skip: InteractionLog === null }, () => {
    const big = "X".repeat(PROMPT_TAIL_CHARS + 5000);
    const off = summarisePrompt(big, false);
    assert.equal(off.promptChars, big.length);
    assert.equal(off.promptTail.length, PROMPT_TAIL_CHARS);
    assert.equal(off.promptFull, undefined, "full body must be absent when full_prompts=false");
    const on = summarisePrompt(big, true);
    assert.equal(on.promptFull, big, "full body present when full_prompts=true");
  });

test("beta63: full_prompts gate holds through a real logSdkRequest write",
  { skip: InteractionLog === null }, () => {
    const dir = mkdir();
    const ilog = new InteractionLog({ config: cfg(join(dir, "logs"), { fullPrompts: false }) });
    const big = "P".repeat(PROMPT_TAIL_CHARS + 3000);
    ilog.logSdkRequest("S4", { role: "lead", model: "m", prompt: big });
    const ev = JSON.parse(readFileSync(join(dir, "logs", "session-S4.jsonl"), "utf8").trim());
    assert.equal(ev.promptChars, big.length);
    assert.equal(ev.promptFull, undefined);
    assert.ok(ev.promptTail.length <= PROMPT_TAIL_CHARS);
    rmSync(dir, { recursive: true, force: true });
  });

// ---- retention prune ----
test("beta63: prune removes session files older than retention_days",
  { skip: InteractionLog === null }, () => {
    const dir = mkdir();
    const logDir = join(dir, "logs");
    const ilog = new InteractionLog({ config: cfg(logDir, { retentionDays: 14 }) });
    ilog.log("OLD", { event: "x" });
    ilog.log("NEW", { event: "y" });
    // Backdate OLD's mtime to 30 days ago.
    const old = join(logDir, "session-OLD.jsonl");
    const ancient = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;
    utimesSync(old, ancient, ancient);
    const res = ilog.prune();
    assert.equal(res.removed, 1, "one old file pruned");
    assert.ok(!existsSync(old), "OLD file removed");
    assert.ok(existsSync(join(logDir, "session-NEW.jsonl")), "NEW file kept");
    rmSync(dir, { recursive: true, force: true });
  });

// ---- stall signature: sdk_request with no matching sdk_response ----
test("beta63: an sdk_request with NO matching sdk_response is detectable (stall signature)",
  { skip: InteractionLog === null }, () => {
    const dir = mkdir();
    const ilog = new InteractionLog({ config: cfg(join(dir, "logs")) });
    // A completed call: request + response.
    ilog.logSdkRequest("S5", { role: "worker", model: "m", seq: 1, prompt: "p1" });
    ilog.logSdkResponse("S5", { role: "worker", model: "m", seq: 1, finishReason: "end_turn" });
    // A HUNG call: request, no response (the stall).
    ilog.logSdkRequest("S5", { role: "worker", model: "m", seq: 2, prompt: "p2" });

    const tail = ilog.readSessionTail("S5");
    const reqs = tail.events.filter((e) => e.event === "sdk_request");
    const resps = tail.events.filter((e) => e.event === "sdk_response");
    // Detect the hang: a request whose (role,seq) has no matching response.
    const respKeys = new Set(resps.map((r) => `${r.role}:${r.seq}`));
    const dangling = reqs.filter((r) => !respKeys.has(`${r.role}:${r.seq}`));
    assert.equal(dangling.length, 1, "exactly one dangling sdk_request (the stall point)");
    assert.equal(dangling[0].seq, 2);
    rmSync(dir, { recursive: true, force: true });
  });

// ---- disabled = no writes ----
test("beta63: disabled interaction log writes nothing", { skip: InteractionLog === null }, () => {
  const dir = mkdir();
  const ilog = new InteractionLog({ config: cfg(join(dir, "logs"), { enabled: false }) });
  ilog.log("S6", { event: "x" });
  assert.ok(!existsSync(join(dir, "logs", "session-S6.jsonl")));
  assert.equal(ilog.enabled, false);
  rmSync(dir, { recursive: true, force: true });
});

// ---- resolveInteractionLogConfig default dir ----
test("beta63: resolveInteractionLogConfig defaults to <dataDir>/logs and honours overrides",
  { skip: InteractionLog === null }, () => {
    const def = resolveInteractionLogConfig(undefined, "/data");
    assert.equal(def.enabled, true);
    assert.equal(def.dir, "/data/logs");
    assert.equal(def.fullPrompts, false);
    assert.equal(def.retentionDays, 14);
    const custom = resolveInteractionLogConfig(
      { interaction_log_enabled: false, dir: "/tmp/custlogs", full_prompts: true, retention_days: 3 },
      "/data",
    );
    assert.equal(custom.enabled, false);
    assert.equal(custom.dir, "/tmp/custlogs");
    assert.equal(custom.fullPrompts, true);
    assert.equal(custom.retentionDays, 3);
  });

// ---- config + manifest wiring ----
test("beta63: log.* keys in config.ts DEFAULTS + interface (source)", () => {
  const src = S("src/config.ts");
  assert.match(src, /interaction_log_enabled: boolean/);
  assert.match(src, /full_prompts: boolean/);
  assert.match(src, /retention_days: number/);
  assert.match(src, /log: \{\s*\n\s*interaction_log_enabled: true/);
});

test("beta63: log.* keys declared in manifest configSchema (additionalProperties:false)", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  const log = m.configSchema.properties.log;
  assert.ok(log, "log block must be declared or additionalProperties:false rejects the whole config");
  assert.equal(log.additionalProperties, false);
  assert.equal(log.properties.interaction_log_enabled.default, true);
  assert.equal(log.properties.full_prompts.default, false);
  assert.equal(log.properties.retention_days.default, 14);
});

test("beta63: harness_logs tool declared in manifest contracts.tools + registration + expected lists", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  assert.ok(m.contracts.tools.includes("harness_logs"), "manifest contracts.tools must list harness_logs");
  assert.match(S("src/tools/registration.ts"), /name: "harness_logs"/);
  assert.match(S("tests/sdk-compliance.test.mjs"), /"harness_logs"/);
  assert.match(S("scripts/smoke.mjs"), /"harness_logs"/);
});

test("beta63: loop threads interactionLog into SDK call boundaries (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /interactionLog\?: InteractionLog/);
  assert.match(src, /logSdkRequest\(sessionId, \{\s*\n\s*role: "lead"/);
  assert.match(src, /logSdkResponse\(sessionId, \{\s*\n\s*role: "worker"/);
  assert.match(src, /logSdkRequest\(sessionId, \{\s*\n\s*role: "adversary"/);
  // state_transition mirrored on every setStatus
  assert.match(src, /event: "state_transition"/);
});
