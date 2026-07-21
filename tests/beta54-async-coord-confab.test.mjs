// beta.54: broaden the async-coordination-confabulation detector beyond the
// env-wait subset.
//
// From the beta.53 #858 revise (session 88066667): seqs 1-2 landed (probe +
// taxonomy-page refactor commit dc1856ea), then seq-3 (a plain TypeScript
// mutate: "harden shared module + add unit tests" -- NO install path) ended
// its turn with:
//   "I'll wait for the completion notification from the background watcher
//    before running the test suite."
// -> confabulated a "background watcher" and yielded, wrote the 5KB module to
// disk but never committed. beta.53's matchesEnvWaitHallucination MISSED it
// twice:
//   (1) PART_RE: the phrase used "wait for" (infinitive) not "waiting for"
//       (gerund), and "background watcher before running" has no event-noun
//       after "watcher".
//   (2) ENV_RE: the sentence has NO install/build/lint word ("test suite" is
//       not in ENV_RE), and detection AND-gated on that.
//
// beta.54:
//   P1  matchesAsyncCoordConfabulation -- detects the CLASS (confabulated
//       watcher/monitor/notification/callback + wait/await verb, OR a wait
//       verb aimed at an arriving event/signal/notification), decoupled from
//       any env word. Wired into the retry gate AND the tagging path.
//   P2  worker-prompt hardening: explicit "run tests/build/lint inline" clause
//       + a HARD STOP rule on wait/notification/watcher phrasing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const loop = await import("../dist/orchestrator/loop.js");
const { matchesAsyncCoordConfabulation, matchesEnvWaitHallucination } = loop;

test("beta.54: predicate is exported", () => {
  assert.equal(typeof matchesAsyncCoordConfabulation, "function");
});

test("beta.54: catches the exact b53 seq-3 'background watcher' phrasing", () => {
  assert.equal(
    matchesAsyncCoordConfabulation(
      "I'll wait for the completion notification from the background watcher before running the test suite.",
    ),
    true,
  );
});

test("beta.54: still catches the b51/b52/b53 env-wait phrasings (superset)", () => {
  // b52 seq-5 (split-sentence Monitor):
  assert.equal(
    matchesAsyncCoordConfabulation(
      "npm ci is still running. The Monitor will notify me when eslint is installed. Waiting for that event.",
    ),
    true,
  );
  // b51 seq-3 (single-clause Monitor):
  assert.equal(
    matchesAsyncCoordConfabulation(
      "The install is still completing. I'll await the Monitor event signaling tsc is ready rather than polling further.",
    ),
    true,
  );
});

test("beta.54: catches synonym coordination nouns (observer/sentinel/daemon/callback/webhook)", () => {
  assert.equal(matchesAsyncCoordConfabulation("I'll wait for the observer to signal that the build is ready."), true);
  assert.equal(matchesAsyncCoordConfabulation("Awaiting the sentinel notification before continuing."), true);
  assert.equal(matchesAsyncCoordConfabulation("The background process will notify me on completion; waiting for that."), true);
  assert.equal(matchesAsyncCoordConfabulation("I'll wait for the callback once the tests finish."), true);
  assert.equal(matchesAsyncCoordConfabulation("Waiting for the completion event from the async runner."), true);
});

test("beta.54: catches 'wait for X to complete/be ready/be installed' arrival shape", () => {
  assert.equal(matchesAsyncCoordConfabulation("I'll wait for the test suite to complete."), true);
  assert.equal(matchesAsyncCoordConfabulation("Waiting for the build to finish before committing."), true);
});

test("beta.54: does NOT fire on legitimate reasoned refusals / normal completions", () => {
  // b48 grc-dir refusal:
  assert.equal(
    matchesAsyncCoordConfabulation(
      "These directories contain ~90 lib files. Deleting them would destroy unrelated code, so I left them in place.",
    ),
    false,
  );
  // finding-premise refusal:
  assert.equal(
    matchesAsyncCoordConfabulation(
      "I verified the finding-10 premise: the route uses governance-risk. The premise holds, so the move is correct.",
    ),
    false,
  );
  // normal completion:
  assert.equal(
    matchesAsyncCoordConfabulation("Refactored the page to consume the shared module and committed locally."),
    false,
  );
  // worker that ACTUALLY ran tests inline (past tense, no wait):
  assert.equal(
    matchesAsyncCoordConfabulation("Ran the test suite with `npm test`; all 42 tests pass. Committed the change."),
    false,
  );
  // unrelated DOM "event":
  assert.equal(
    matchesAsyncCoordConfabulation("I added an onClick event handler to the button and committed."),
    false,
  );
  assert.equal(matchesAsyncCoordConfabulation(""), false);
});

test("beta.54: env-wait shape is a strict subset of the broadened predicate", () => {
  const envWaitPhrases = [
    "npm ci is still running. The Monitor will notify me when eslint is installed. Waiting for that event.",
    "The install is still completing. I'll await the Monitor event signaling tsc is ready rather than polling further.",
  ];
  for (const p of envWaitPhrases) {
    if (matchesEnvWaitHallucination(p)) {
      assert.equal(matchesAsyncCoordConfabulation(p), true, `broad predicate must accept env-wait subset: ${p}`);
    }
  }
});

// ---- source-assertion wiring: broadened predicate is actually used ----
test("beta.54: loop.ts wires matchesAsyncCoordConfabulation into retry gate AND tag path", () => {
  const src = readFileSync(join(root, "src/orchestrator/loop.ts"), "utf8");
  // retry gate uses the broadened predicate:
  assert.match(
    src,
    /failedNow\.every[\s\S]{0,600}matchesAsyncCoordConfabulation\(result\.finalMessage/,
    "retry gate must call matchesAsyncCoordConfabulation on finalMessage",
  );
  // tag path uses the broadened predicate:
  assert.match(
    src,
    /looksLikeRefusal && matchesAsyncCoordConfabulation\(refusalText\)/,
    "tag path must call matchesAsyncCoordConfabulation on refusalText",
  );
  // the old env-only predicate is no longer the gate at those two sites:
  assert.doesNotMatch(
    src,
    /failedNow\.every[\s\S]{0,600}matchesEnvWaitHallucination\(result\.finalMessage/,
    "retry gate should no longer AND-gate on the env-only predicate",
  );
});

test("beta.54: worker prompt has inline-test clause + hard-stop rule", () => {
  const src = readFileSync(join(root, "src/orchestrator/sonnet-worker.ts"), "utf8");
  assert.match(src, /To RUN TESTS, a BUILD, or LINT: execute the command yourself/i, "inline-run clause present");
  assert.match(src, /HARD STOP RULE/, "hard-stop rule present");
  assert.match(src, /No async|NO async test runner/i, "denies async test runner");
});
