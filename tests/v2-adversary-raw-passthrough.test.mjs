/**
 * The adversary's reply must survive the trip back from OpenCode.
 *
 * THE BUG. `BackendRouter.executorFor` returned `raw: ""` and `stopReason:
 * null` unconditionally, and ignored `skipParse`. Seven of the eight roles
 * never noticed, because they read `parsed`. The adversary is the exception:
 * `reviewOnce` drives its OWN `runStructuredLadder` and passes `skipParse:
 * true` precisely so the ladder — not the call — owns extraction, repair and
 * the "you returned prose" correction. It therefore reads `raw`.
 *
 * So on OpenCode the model produced a perfectly good verdict, the executor's
 * inner ladder parsed it, and then the return statement threw it away. The
 * outer ladder was handed an empty string, reported `no JSON in output` with
 * nothing after `--- raw ---`, retried three times, ran the format nudge three
 * more, and crashed the review. Every one of those six turns was billed, and
 * the harness — correctly — refused to push code no adversary had reviewed.
 *
 * Two live smokes (sessions 8353c267 with tools denied, 730b7423 with tools
 * allowed) failed identically, which is what ruled out the guard and the
 * prompt: the reply never depended on either.
 *
 * These tests use the fake ACP agent, so they cost nothing and run in CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "fake-acp-agent.mjs");

const { buildBackendRouter } = await import("../dist/adapters/backend-router.js");
const { runAdversarySdk } = await import("../dist/adapters/claude-code.js");

const scratch = () => mkdtempSync(resolve(tmpdir(), "acp-adversary-"));

function routerFor(scenario) {
  // The fake agent selects its behaviour from the environment, and
  // `buildAgentEnv` passes non-secret variables through to the child.
  process.env.FAKE_ACP_SCENARIO = scenario;
  return buildBackendRouter({
    resolveKey: () => undefined,
    scratchDir: scratch(),
    logger: { info: () => {}, warn: () => {} },
    audit: () => {},
    backends: { adversary: { backend: "opencode", model: "fake/model", tier: "strong" } },
    openCodeCommand: { command: process.execPath, args: [FIXTURE] },
  });
}

test("a skipParse call hands back the model's text, not a placeholder", async () => {
  const router = routerFor("structured-ok");
  const execute = router.executorFor("adversary");

  const r = await execute({
    model: "fake/model",
    systemPrompt: "sys",
    userMessage: "review this",
    timeoutSeconds: 30,
    skipParse: true,
  });

  // The precise regression: this was "".
  assert.notEqual(r.raw, "", "the executor discarded the agent's reply");
  assert.deepEqual(JSON.parse(r.raw), { verdict: "revise", findings: [], summary: "ok" });
  // The adversary ladder reads this to decide whether a reply was cut off
  // rather than malformed; a hardcoded null makes every truncation look like a
  // contract violation and re-asks in the way that reproduces it.
  assert.equal(r.stopReason, "end_turn");
});

test("the adversary reaches a verdict on OpenCode instead of crashing the review", async () => {
  const router = routerFor("structured-ok");

  const out = await runAdversarySdk({
    execute: router.executorFor("adversary"),
    model: "fake/model",
    systemPrompt: "you are the adversary",
    diffText: "diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md\n+hello\n",
    timeoutSeconds: 30,
  });

  assert.equal(out.parsed.verdict, "revise");
  assert.equal(out.parsed.summary, "ok");
});

test("the adversary's own ladder does the retrying, and is not doubled up", async () => {
  // `structured-prose-then-json` answers with prose until it sees the
  // correction, so a working ladder needs exactly two turns. If the executor
  // climbs its own ladder underneath, the inner one absorbs the correction and
  // the outer one never sees the reply that earned it -- three attempts times
  // three, and a crash at the end of it.
  const router = routerFor("structured-prose-then-json");

  const out = await runAdversarySdk({
    execute: router.executorFor("adversary"),
    model: "fake/model",
    systemPrompt: "you are the adversary",
    diffText: "diff --git a/x b/x\n+x\n",
    timeoutSeconds: 30,
  });

  assert.equal(out.parsed.verdict, "pass");
});

test("a structured role still runs with no tools, and the reply still comes back", async () => {
  // The fix must not have loosened the deny-all guard: this scenario asks for
  // `cat /etc/passwd` and reports which option the client picked.
  const router = routerFor("structured-asks-for-tool");

  const r = await router.executorFor("adversary")({
    model: "fake/model",
    systemPrompt: "sys",
    userMessage: "review",
    timeoutSeconds: 30,
    skipParse: true,
  });

  const doc = JSON.parse(r.raw);
  assert.match(doc.summary, /reject/, "the deny-all guard let a structured role run a tool");
});
