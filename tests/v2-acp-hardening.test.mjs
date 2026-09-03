// v2.0.0 M5 — what had to change in the ACP adapter before it could ship.
//
// The adapter arrived on its own branch, written against b132, and it was good
// work. What it did not have was the accumulated scar tissue of the SDK path,
// because it had never been through a smoke run. Four things followed from
// that, and each is a test below:
//
//   1. It spawned the agent with the harness's entire environment. The SDK path
//      has filtered its child since beta.57, and withheld the vault key
//      specifically since beta.110 — but that filter lived inside the SDK
//      adapter, so a second spawn path simply did not inherit it. This is the
//      drift M3 moved the filter to shared/ to prevent, and it is a P0.
//
//   2. It killed the direct child only. `opencode` is a wrapper that spawns its
//      own children, so a timeout left the real worker running: still holding
//      the worktree, still talking to the model, still spending.
//
//   3. It reported tokensIn/tokensOut as 0, on the documented grounds that "ACP
//      carries no in/out split". That was measured from the usage_update
//      notification. The split is on the session/prompt RESULT, and it is
//      sitting in the captured probe sessions.
//
//   4. It implemented the worker and nothing else. Six of the eight roles are
//      tool-less structured-JSON calls and had no ACP path at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const S = (p) => readFileSync(resolve(root, p), "utf8");
const FIXTURE = resolve(root, "tests/fixtures/fake-acp-agent.mjs");

const { runWorkerAcp, runStructuredAcp, acpUsageSource, ACP_CAPABILITIES } =
  await import("../dist/adapters/acp.js");
const { buildAcpGuard } = await import("../dist/safety/bash-guard.js");

const allowAll = async () => ({ allow: true });
const agent = (scenario, env) => ({
  command: process.execPath,
  args: [FIXTURE],
  env: { FAKE_ACP_SCENARIO: scenario, ...(env ?? {}) },
});
const scratch = () => mkdtempSync(resolve(tmpdir(), "acp-v2-"));

// ---------------------------------------------------------------------------
// 1. The P0: the child's environment
// ---------------------------------------------------------------------------

test("P0: the ACP child never inherits the vault key or the PAT", async () => {
  const prev = { ...process.env };
  try {
    process.env.OAH_VAULT_KEY = "vault-key-must-not-leak";
    process.env.GH_TOKEN = "ghp_must_not_leak";
    process.env.SLACK_BOT_TOKEN = "xoxb-must-not-leak";
    process.env.HARMLESS_VAR = "fine";

    const r = await runWorkerAcp({
      agent: agent("echo-env"),
      worktreePath: scratch(),
      systemPrompt: "s",
      userMessage: "u",
      model: "",
      timeoutSeconds: 20,
      acpGuard: allowAll,
    });

    const childEnv = JSON.parse(r.finalMessage);
    assert.equal(childEnv.OAH_VAULT_KEY, undefined, "the vault key reached the agent");
    assert.equal(childEnv.GH_TOKEN, undefined, "the GitHub PAT reached the agent");
    assert.equal(childEnv.SLACK_BOT_TOKEN, undefined, "a Slack token reached the agent");
    // The filter must not be so blunt that the child cannot run.
    assert.equal(childEnv.HARMLESS_VAR, "fine");
    assert.ok(childEnv.PATH, "the child still needs a PATH");
    // Named by the caller, so it is applied after the filter.
    assert.equal(childEnv.NO_COLOR, "1");
    assert.equal(childEnv.FAKE_ACP_SCENARIO, "echo-env");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test("P0: the ACP spawn goes through the SHARED filter, not a copy of it", () => {
  // The point of M3 was one filter for both backends. A local re-implementation
  // here would pass the test above today and drift the moment the deny-list is
  // widened for the SDK path only -- which is exactly how this bug happened.
  const src = S("src/adapters/acp.ts");
  assert.match(src, /import \{ buildAgentEnv \} from "\.\/shared\/env\.js"/);
  assert.match(src, /env: buildAgentEnv\(/);
  assert.doesNotMatch(src, /env: \{ \.\.\.process\.env/, "the original P0 must not come back");
});

test("the OpenCode config env var is redacted from the interaction log", async () => {
  // It arrives as one JSON document in one variable and carries the provider
  // API keys. No shape pattern matches a JSON blob, and the key is named for
  // what it contains rather than what it is, so only key-based redaction
  // catches it.
  const { redactValue } = await import("../dist/state/interaction-log.js");
  const out = redactValue({
    OPENCODE_CONFIG_CONTENT: '{"provider":{"anthropic":{"options":{"apiKey":"sk-ant-real"}}}}',
    tokensIn: 1234,
  });
  assert.doesNotMatch(JSON.stringify(out), /sk-ant-real/, "the provider key leaked into the log");
  assert.equal(out.tokensIn, 1234, "a diagnostic number must survive redaction");
  // Matched on the normalised key, so the underscored spelling is caught too.
  assert.doesNotMatch(
    JSON.stringify(redactValue({ opencode_config_content: "sk-ant-real" })),
    /sk-ant-real/,
  );
});

// ---------------------------------------------------------------------------
// 2. Reaping the process group
// ---------------------------------------------------------------------------

test("a timeout reaps the whole process GROUP, not just the wrapper", async () => {
  const r = await runWorkerAcp({
    agent: agent("spawns-grandchild"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 2,
    acpGuard: allowAll,
  });
  assert.equal(r.stopReason, "timeout");

  const m = /grandchild:(\d+)/.exec(r.finalMessage);
  assert.ok(m, `the fixture must report its grandchild pid; got ${JSON.stringify(r.finalMessage)}`);
  const pid = Number(m[1]);

  // SIGTERM to the group, then SIGKILL 5s later. Give both room.
  const alive = async () => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && (await alive())) {
    await new Promise((r2) => setTimeout(r2, 200));
  }
  assert.equal(await alive(), false,
    `pid ${pid} survived the reap: killing the wrapper alone orphans the process that is still spending`);
});

test("the reap signals a negative pid and the child is a group leader", () => {
  const src = S("src/adapters/acp.ts");
  assert.match(src, /detached: true/, "without this there is no group to signal");
  assert.match(src, /process\.kill\(-pid, sig\)/);
  // And it must still fall back, or a spawn failure throws inside cleanup.
  assert.match(src, /catch \{[\s\S]{0,220}child\.kill\(sig\)/);
});

// ---------------------------------------------------------------------------
// 3. The token split
// ---------------------------------------------------------------------------

test("the token split is read off the session/prompt result", async () => {
  const r = await runWorkerAcp({
    agent: agent("token-split"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    acpGuard: allowAll,
  });
  assert.equal(r.tokensIn, 10);
  assert.equal(r.tokensOut, 132);
  assert.equal(r.tokensCached, 1995, "cache tokens are priced separately, so they are kept separate");
  assert.equal(r.usageSource, "acp-delta");
  assert.equal(r.contextUsed, 10, "the notification's context occupancy still works too");
});

test("tokens without cost is a THIRD state, not zero spend", async () => {
  // What a local or self-hosted provider looks like. `costUsd: 0` is true here,
  // and it must be distinguishable from "the agent told us nothing".
  const r = await runWorkerAcp({
    agent: agent("tokens-no-cost"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    acpGuard: allowAll,
  });
  assert.equal(r.tokensIn, 40);
  assert.equal(r.tokensOut, 7);
  assert.equal(r.costUsd, 0);
  assert.equal(r.usageSource, "tokens-only");
});

test("a denial records WHAT was refused, not just how many", async () => {
  // A StitchGuard run reported `denied: 2` on a worker turn that committed
  // nothing, and there was no way afterwards to say which two calls those were:
  // the count went to the log, the detail went to a truncated excerpt, and
  // neither reached a durable store. A zero-side-effect turn has two opposite
  // causes -- the model declined to act, or the guard would not let it -- so
  // the count alone cannot tell an operator which failure they are looking at.
  const warned = [];
  const denyExec = async (call) =>
    call.kind === "execute" ? { allow: false, reason: "not on the bash whitelist" } : { allow: true };

  const r = await runWorkerAcp({
    agent: agent("denied-command"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    acpGuard: denyExec,
    logger: { info: () => {}, warn: (m, meta) => warned.push({ m, meta }) },
  });

  assert.equal(r.deniedToolCalls.length, 1);
  const [d] = r.deniedToolCalls;
  assert.equal(d.kind, "execute");
  assert.equal(d.reason, "not on the bash whitelist");
  assert.ok(d.title && d.title.length > 0, "the refused command must be recorded, not just its kind");

  // And it must be said out loud at the moment it happens, so a run that is
  // being watched shows the denial rather than only its consequence.
  const line = warned.find((w) => String(w.m).includes("denied a tool call"));
  assert.ok(line, "a denial must warn when it happens");
  assert.equal(line.meta.kind, "execute");
  assert.match(line.meta.reason, /bash whitelist/);
});

test("a pathless OpenCode read is allowed, counted, and announced once", async () => {
  // The measured 1.18.23 shape. Failing closed here is what made the worker
  // unable to read a file; allowing silently is what would make path_denylist
  // look enabled while doing nothing. Both are worse than allow-and-count.
  const warned = [];
  const r = await runWorkerAcp({
    agent: agent("pathless-read"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    acpGuard: buildAcpGuard({
      bash_whitelist: ["git", "echo"],
      bash_denylist_tokens: ["rm"],
      path_denylist: [".env", "vault.key"],
      allow_git_push: false,
      allow_network_commands: false,
    }),
    logger: { info: () => {}, warn: (m, meta) => warned.push({ m, meta }) },
  });

  assert.equal(r.deniedToolCalls.length, 0, "a pathless read must not be refused");
  assert.equal(r.unguardedReads, 1);
  const line = warned.find((w) => String(w.m).includes("path_denylist NOT enforced on read"));
  assert.ok(line, "the first unchecked read must warn");
});

test("the LOGGED usage source is the one that was actually returned", async () => {
  // Found by running, not by reading. The return value above has been asserted
  // since M5 and was always right; the log line beside it computed the same
  // idea a second time and forgot `sawTokenSplit`, so a real OpenCode turn --
  // which reports tokens but no cost against a custom provider -- was priced
  // correctly off the catalogue while announcing `unavailable`.
  //
  // Nobody was misled about money. They were misled about whether the money was
  // being measured, which sent a smoke run looking for a costing bug that did
  // not exist. The two values are one variable now, and this test is what keeps
  // them one.
  const logged = [];
  const r = await runWorkerAcp({
    agent: agent("tokens-no-cost"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    acpGuard: allowAll,
    logger: { info: (m, meta) => logged.push({ m, meta }), warn: () => {} },
  });

  const finished = logged.find((l) => String(l.m).includes("worker turn finished"));
  assert.ok(finished, "the adapter must announce the end of a turn");
  assert.equal(finished.meta.usageSource, r.usageSource);
  assert.equal(finished.meta.usageSource, "tokens-only");
});

test("an agent that reports nothing still reports a GAP, never a measured zero", async () => {
  const r = await runWorkerAcp({
    agent: agent("no-cost"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    acpGuard: allowAll,
  });
  assert.equal(r.usageSource, "unavailable");
  assert.equal(r.tokensCached, undefined, "no split means no cache figure to report");
});

test("a usage object with no counts in it is still a gap", async () => {
  // An agent that implements the shape and not the substance. Accepting this
  // as a measured zero is the b125 failure in a different guise: the run looks
  // free, and nothing in the ledger says otherwise.
  const r = await runWorkerAcp({
    agent: agent("empty-usage"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    acpGuard: allowAll,
  });
  assert.equal(r.usageSource, "unavailable",
    "a usage object carrying neither inputTokens nor outputTokens measured nothing");
  assert.equal(r.tokensCached, undefined);
});

test("usageSource covers all four combinations", () => {
  assert.equal(acpUsageSource(true, true), "acp-delta");
  assert.equal(acpUsageSource(false, true), "tokens-only");
  assert.equal(acpUsageSource(true, false), "acp-delta");
  assert.equal(acpUsageSource(false, false), "unavailable");
});

test("the capability matrix no longer claims the protocol has no token split", () => {
  const doc = S("docs/acp-capability-matrix.md");
  assert.doesNotMatch(doc, /ACP carries no\s*\n?\s*input\/output split/,
    "the corrected claim must not survive anywhere in the document");
  assert.match(doc, /Correction \(v2\.0\.0-beta\.1\)/);
  assert.match(doc, /session\/prompt` result/);
  // The correction must show the evidence, not merely assert the opposite.
  assert.match(doc, /cachedWriteTokens/);
  assert.match(doc, /probe\/runs\/opencode-/);
});

// ---------------------------------------------------------------------------
// 4. The structured path for the six tool-less roles
// ---------------------------------------------------------------------------

const REVIEW = { requiredKeys: ["verdict", "findings", "summary"], label: "adversary" };

test("a structured role gets a validated document over ACP", async () => {
  const r = await runStructuredAcp({
    agent: agent("structured-ok"),
    role: "adversary",
    cwd: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    validation: REVIEW,
  });
  assert.equal(r.parsed.verdict, "revise");
  assert.equal(r.tokensIn, 5);
  assert.equal(r.tokensOut, 9);
  assert.equal(r.usageSource, "tokens-only");
});

test("the structured path climbs the SAME ladder as the SDK path", async () => {
  // Prose on the first turn, JSON once corrected. The correction has to reach
  // the agent, or the retry is just a second roll of the same dice.
  const r = await runStructuredAcp({
    agent: agent("structured-prose-then-json"),
    role: "adversary",
    cwd: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    validation: REVIEW,
  });
  assert.equal(r.parsed.verdict, "pass");
});

test("a structured role that asks for a tool is REFUSED", async () => {
  // These roles have no tools by configuration (M6). The deny-all guard is the
  // second layer, and it exists because preflightAcpBackend's whole premise is
  // that a backend ignoring its own permission config is a thing that happens.
  const r = await runStructuredAcp({
    agent: agent("structured-asks-for-tool"),
    role: "classifier",
    cwd: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "",
    timeoutSeconds: 20,
    validation: REVIEW,
  });
  // The fixture echoes `outcome:optionId`. Asserting on the outcome alone
  // would prove nothing: an allow and a deny are both "selected", and differ
  // only in which option was picked.
  assert.equal(r.parsed.summary, "selected:reject-once",
    "the adapter must pick the REJECT option, not merely answer the request");
});

test("a structured role that never produces JSON fails toward review", async () => {
  // The M4 property, over ACP. Exhaustion throws; there is no pass-shaped
  // default for a reviewer that could not be reached.
  await assert.rejects(
    () => runStructuredAcp({
      agent: agent("refusal"),
      role: "adversary",
      cwd: scratch(),
      systemPrompt: "s",
      userMessage: "u",
      model: "",
      timeoutSeconds: 20,
      validation: REVIEW,
      maxAttempts: 2,
    }),
    (err) => {
      assert.equal(err.role, "adversary");
      assert.equal(err.attempts.length, 2);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The backend declaration
// ---------------------------------------------------------------------------

test("ACP declares capabilities and satisfies every role", async () => {
  const backend = await import("../dist/adapters/backend.js");
  assert.equal(ACP_CAPABILITIES.id, "acp");
  for (const role of backend.ROLE_NAMES) {
    assert.equal(backend.checkCapabilityFloor(role, ACP_CAPABILITIES, "strong"), null,
      `ACP should be able to run ${role}`);
  }
});

test("the declaration is not the same thing as the guarantee", () => {
  // toolPermissionCallback is declared true, but the M2 probe measured OpenCode
  // on default config running four shell commands and two edits with zero
  // permission requests. The declaration says the backend CAN ask; only M6's
  // live probe establishes that this installation DOES.
  const src = S("src/adapters/acp.ts");
  assert.match(src, /M6 does not take that on\s*\n \* trust/);
  assert.match(src, /preflightAcpBackend/);
});

// ---------------------------------------------------------------------------
// A request issued after the connection closed
// ---------------------------------------------------------------------------

test("a child that dies mid-resume fails the turn FAST, rather than hanging to the deadline", async () => {
  // `request()` used to register a pending promise and call `write()`, which is
  // a silent no-op once closed. The child's `error`/`exit` handlers fire ONCE
  // and drain whatever was pending at that instant, so anything sent afterwards
  // sat in the map forever. The turn then hung until subtask_deadline_seconds
  // force-failed the whole sub-task -- minutes later, blaming a timeout.
  //
  // The reachable window is the resume path: `session/load` is awaited, the
  // dying child rejects it, and the catch below it treats that as "this agent
  // does not support resume" and falls through to `session/new` -- on a
  // connection that has already closed. Resume plus a crash is an ordinary
  // combination, not a contrived one.
  const started = Date.now();
  const turn = runWorkerAcp({
    agent: agent("exit-on-session-load"),
    worktreePath: scratch(),
    systemPrompt: "s",
    userMessage: "u",
    model: "m",
    // The resume path is what makes this reachable. session/load is awaited,
    // the dying child rejects it, and the catch treats that as "no resume
    // support" and falls through to session/new -- which is then issued on a
    // connection that has already closed.
    resumeSessionId: "prior-session",
    // Generous on purpose: if the fix regresses, this test should FAIL on the
    // assertion below rather than pass slowly because the timeout rescued it.
    timeoutSeconds: 30,
    acpGuard: allowAll,
  }).catch((err) => ({ threw: err }));

  // Raced against a short timer, because the un-fixed failure is an UNBOUNDED
  // hang, not a slow return: nothing ever settles the promise, so the turn's
  // own timeout cannot rescue it either. Without this the regression presents
  // as the whole test file wedging, which is a true signal delivered in the
  // least useful possible form.
  const HANG_MS = 8_000;
  const r = await Promise.race([
    turn,
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), HANG_MS).unref?.()),
  ]);

  assert.equal(
    r.hung,
    undefined,
    `the turn never settled within ${HANG_MS}ms: a request issued after the connection closed is waiting ` +
      `for a reply that cannot arrive`,
  );

  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < HANG_MS, `the turn should fail promptly, took ${elapsedMs}ms`);

  const message = r.threw ? String(r.threw.message ?? r.threw) : String(r.logsExcerpt ?? "");
  assert.match(
    message,
    /exited|could not be started|connection is closed/,
    "the failure must name the dead child, not a generic timeout",
  );
});
