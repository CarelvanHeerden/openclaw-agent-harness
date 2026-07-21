// beta.52: fix the worker "await a non-existent Monitor event" hallucination
// that blocked #858 at sub-task 3 (session fc64d8ea).
//
// The beta.51 revise got 2 sub-tasks deep, then sub-task 3's worker ended its
// turn with 24 words -- "The install is still completing. I'll await the
// Monitor event signaling tsc is ready rather than polling further." -- and
// ZERO side-effects. There is no mid-turn event stream in the one-shot harness
// protocol, so it exited waiting for a signal that never comes. It also went
// OFF-PLAN (its success criteria did not require typecheck).
//
// Two-part fix:
//   1. Worker system-prompt hardening: one turn, no event stream, run long
//      processes inline+blocking, don't self-verify off-plan.
//   2. Diagnostic tag: WORKER_PROTOCOL_ASSUMPTION_RE distinguishes this from a
//      reasoned refusal so it's greppable in metrics (loop.worker_incorrect_
//      protocol_assumption). Does NOT change pass/fail.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(here, "..", p), "utf8");

const { buildWorkerSystemPrompt } = await import("../dist/orchestrator/sonnet-worker.js");

// ---------------------------------------------------------------------------
// Part 1: worker system-prompt hardening
// ---------------------------------------------------------------------------
const brief = { title: "Fix taxonomy", motivation: "m", acceptanceCriteria: ["a"] };
const subTask = {
  seq: 3, title: "Refactor page", intent: "consume shared module", taskMode: "mutate",
  filesLikelyTouched: ["app/governance-risk/taxonomy/page.tsx"], successCriteria: ["import from shared module", "commit locally"],
  contractScope: "local", dependsOn: [2],
};

test("beta52: worker prompt states there is ONE turn and no mid-turn event stream", () => {
  const p = buildWorkerSystemPrompt(brief, subTask);
  assert.match(p, /EXACTLY ONE turn/);
  assert.match(p, /NO event stream/i);
  assert.match(p, /Monitor event/);
});

test("beta52: worker prompt forbids awaiting/waiting/polling for harness events", () => {
  const p = buildWorkerSystemPrompt(brief, subTask);
  assert.match(p, /NEVER 'await', 'wait for', or 'poll for'/);
});

test("beta52: worker prompt tells it to run long processes inline + blocking", () => {
  const p = buildWorkerSystemPrompt(brief, subTask);
  assert.match(p, /INLINE in a single Bash tool call that BLOCKS/);
  assert.match(p, /npm ci/);
  assert.match(p, /Do not background it and wait/);
});

test("beta52: worker prompt discourages off-plan self-verification", () => {
  const p = buildWorkerSystemPrompt(brief, subTask);
  assert.match(p, /Only run verification .* if THIS sub-task's success criteria/);
  assert.match(p, /Do not go off-plan to self-verify/);
});

// ---------------------------------------------------------------------------
// Part 2: the diagnostic predicate. beta.52 shipped a module-scope regex; beta.53
// replaced it with the EXPORTED `matchesEnvWaitHallucination` (sentence-spanning
// + env-word gate). We test the live exported predicate now (the beta.52 single-
// clause regex is kept only as a @deprecated constant; its exhaustive behavior
// is covered in tests/beta53-env-wait-retry.test.mjs).
// ---------------------------------------------------------------------------
const { matchesEnvWaitHallucination } = await import("../dist/orchestrator/loop.js");

test("beta52: predicate MATCHES the exact fc64d8ea hallucination", () => {
  assert.equal(matchesEnvWaitHallucination("The install is still completing. I'll await the Monitor event signaling tsc is ready rather than polling further."), true);
});

test("beta52: predicate does NOT match genuine reasoned refusals (no false positives)", () => {
  // the beta.48 grc-dir refusal
  assert.equal(matchesEnvWaitHallucination("These directories are NOT empty — they contain ~90 lib files. Deleting them would destroy unrelated code, so I correctly left them in place."), false);
  // the finding-premise refusal
  assert.equal(matchesEnvWaitHallucination("I verified the finding-10 premise against the repo: the route uses governance-risk. The premise holds, so the move is correct."), false);
  // a plain completion message
  assert.equal(matchesEnvWaitHallucination("Refactored the page to consume the shared module and committed locally."), false);
});

// ---------------------------------------------------------------------------
// Part 2 wiring: loop.ts tags + audits the protocol-assumption case distinctly
// ---------------------------------------------------------------------------
test("beta52/53: loop.ts emits the env-wait hallucination tag distinct from worker_refusal", () => {
  const src = S("src/orchestrator/loop.ts");
  // beta.53 renamed detection to the exported predicate + renamed the event
  // from loop.worker_incorrect_protocol_assumption -> loop.worker_env_wait_hallucination.
  assert.match(src, /looksLikeProtocolAssumption\s*=\s*\n?\s*looksLikeRefusal && matchesEnvWaitHallucination\(refusalText\)/);
  assert.match(src, /"loop\.worker_env_wait_hallucination"/);
  // headline/summary distinguishes the env-wait case
  assert.match(src, /worker awaited a non-existent mid-turn event and did no work/);
});
