/**
 * rc.10 / F2 -- a file is only evidence about where ITS OWN kind of artifact
 * lives.
 *
 * Client Offboarding smoke test, 15 September 2026, session
 * aad3fc57-662d-401e-9386-79e858ff7183. Audit 5591, verbatim:
 *
 *   src/__tests__/lib/it/client-offboarding-orchestrator.test.ts
 *     -> src/lib/it/client-offboarding-orchestrator.test.ts
 *   via: from=src/__tests__, to=src, tail=lib/it
 *
 * Audit 5592 wrote that into the stored plan. The original file EXISTS; the
 * replacement does not, and the repository's Jest config discovers tests under
 * `__tests__`, so the rewritten path could never have run.
 *
 * The entire evidence was ONE production file committed by sub-task 2:
 * `src/lib/it/client-offboarding-errors.ts`. It shares the two-segment tail
 * `lib/it`, which cleared the rc1 tail-width guard, and the rewritten name
 * still ended in `.test.ts`, which is why the rc.9 kind guard -- written only
 * for non-test -> test -- did not fire.
 *
 * Two independent layers now refuse it, and the tests below pin both:
 *
 *   1. EVIDENCE KIND. Where a repo keeps `errors.ts` says nothing about where
 *      its test runner discovers `*.test.ts`. Cross-kind evidence can suggest,
 *      never rewrite.
 *   2. REPOSITORY INVENTORY. A declared path that exists is authoritative.
 *      beta.93's guard (a) only ever saw what the RUN touched, and the sub-task
 *      that would have touched this file had just been denied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { rederiveContractPath, learnRemapsForDir } from "../dist/orchestrator/contract-rederive.js";
import { applyPathCorrections } from "../dist/orchestrator/plan-path-writeback.js";

/** The incident, exactly as audit 5591 recorded it. */
const TEST_CONTRACT = "src/__tests__/lib/it/client-offboarding-orchestrator.test.ts";
const PRODUCTION_EVIDENCE = ["src/lib/it/client-offboarding-errors.ts"];
const PHANTOM = "src/lib/it/client-offboarding-orchestrator.test.ts";

/* ------------------------------------------------------------------ *
 * 1. The reported case
 * ------------------------------------------------------------------ */

test("rc.10 (5591): a production sibling cannot relocate a test contract", () => {
  const r = rederiveContractPath(TEST_CONTRACT, PRODUCTION_EVIDENCE);
  assert.equal(r.remapped, false, "rc.9 returned remapped=true here");
  assert.equal(r.path, TEST_CONTRACT, "the real, existing test path survives");
  assert.notEqual(r.path, PHANTOM);
});

test("rc.10 (5591): the refusal explains that source layout does not fix test layout", () => {
  const r = rederiveContractPath(TEST_CONTRACT, PRODUCTION_EVIDENCE);
  assert.ok(r.suggestion, "the candidate is reported to a human, not silently dropped");
  assert.equal(r.suggestion.path, PHANTOM);
  assert.deepEqual(r.suggestion.via, { from: "src/__tests__", to: "src", tail: "lib/it" });
  assert.equal(r.suggestion.confidence, "low");
  assert.match(r.suggestion.reason, /PRODUCTION files/);
  assert.match(r.suggestion.reason, /where its test runner discovers tests/);
});

test("rc.10: the mapping is still learnable -- which is why the decision is at application time", () => {
  // Not a fix, a record. learnRemapsForDir is unchanged and still derives it;
  // rederiveContractPath is where the evidence is filtered by kind.
  const remaps = learnRemapsForDir("src/__tests__/lib/it", PRODUCTION_EVIDENCE);
  assert.deepEqual(remaps, [{ from: "src/__tests__", to: "src", tail: "lib/it" }]);
});

/* ------------------------------------------------------------------ *
 * 2. Repository inventory: an existing path is authoritative
 * ------------------------------------------------------------------ */

test("rc.10: a contract path that EXISTS is never re-derived, touched or not", () => {
  // The decisive difference from beta.93 guard (a): the run never touched this
  // file, because the sub-task that would have written it was denied.
  const r = rederiveContractPath(TEST_CONTRACT, PRODUCTION_EVIDENCE, {
    repoFiles: ["src/lib/it/client-offboarding-errors.ts", TEST_CONTRACT, "package.json"],
  });
  assert.equal(r.remapped, false);
  assert.equal(r.path, TEST_CONTRACT);
  assert.equal(r.suggestion, undefined, "an existing path raises no question to put to a human");
});

test("rc.10: the inventory protects a path the kind rule would have allowed", () => {
  // Same-kind evidence, so the kind rule permits the rewrite -- but the
  // declared path is a real file, so the inventory refuses it anyway. This is
  // the layer working on its own.
  const contract = "tests/api/grc/policy.test.ts";
  const evidence = ["src/__tests__/api/grc/evidence-export.test.ts"];
  const without = rederiveContractPath(contract, evidence);
  assert.equal(without.remapped, true, "precondition: the kind rule allows this one");

  const withInventory = rederiveContractPath(contract, evidence, { repoFiles: [contract] });
  assert.equal(withInventory.remapped, false);
  assert.equal(withInventory.path, contract);
});

test("rc.10: an inventory that does NOT contain the path changes nothing", () => {
  const r = rederiveContractPath("tests/api/grc/policy.test.ts", ["src/__tests__/api/grc/evidence-export.test.ts"], {
    repoFiles: ["package.json", "src/index.ts"],
  });
  assert.equal(r.remapped, true, "a genuinely absent declared path still gets corrected");
  assert.equal(r.path, "src/__tests__/api/grc/policy.test.ts");
});

test("rc.10: a missing or empty inventory is not treated as 'nothing exists'", () => {
  // listRepoFiles is best-effort at the call site; a failed listing must not
  // silently turn into evidence that the declared path is fictional.
  for (const opts of [{}, { repoFiles: [] }, { repoFiles: undefined }]) {
    const r = rederiveContractPath(TEST_CONTRACT, PRODUCTION_EVIDENCE, opts);
    assert.equal(r.remapped, false, "the kind rule still stands with no inventory");
  }
});

/* ------------------------------------------------------------------ *
 * 3. Legitimate corrections must still work
 * ------------------------------------------------------------------ */

test("rc.10: test-to-test relocation still applies (beta.76)", () => {
  const r = rederiveContractPath("tests/api/grc/policy.test.ts", [
    "src/__tests__/api/grc/evidence-export.test.ts",
  ]);
  assert.equal(r.remapped, true);
  assert.equal(r.path, "src/__tests__/api/grc/policy.test.ts");
  assert.equal(r.suggestion, undefined);
});

test("rc.10: source-to-source relocation still applies (beta.93)", () => {
  const r = rederiveContractPath("components/layout/sidebar.tsx", ["src/components/layout/header.tsx"]);
  assert.equal(r.remapped, true);
  assert.equal(r.path, "src/components/layout/sidebar.tsx");
  assert.equal(r.suggestion, undefined);
});

test("rc.10: a co-located test convention is same-kind and still correctable", () => {
  // Repos that put tests beside sources are a legitimate layout. The evidence
  // is a test file, so the kind rule permits it; only the SOURCE-file evidence
  // of audit 5591 is refused.
  const r = rederiveContractPath("src/__tests__/lib/it/orchestrator.test.ts", [
    "src/lib/it/errors.test.ts",
  ]);
  assert.equal(r.remapped, true, "a test file IS evidence about where tests live");
  assert.equal(r.path, "src/lib/it/orchestrator.test.ts");
});

test("rc.10: documentation-to-tests protection is intact (rc.9, audit 5408)", () => {
  const r = rederiveContractPath("okf/api/webhooks/client-offboarding-slack.md", [
    "src/__tests__/api/webhooks/linear-webhook-status-sync.test.ts",
    "src/app/api/webhooks/linear/route.ts",
  ]);
  assert.equal(r.remapped, false);
  assert.equal(r.path, "okf/api/webhooks/client-offboarding-slack.md");
  assert.ok(r.suggestion);
  assert.match(r.suggestion.reason, /test tree/);
});

/* ------------------------------------------------------------------ *
 * 4. Ambiguity and weak evidence
 * ------------------------------------------------------------------ */

test("rc.10: unrelated source-only evidence cannot relocate a test at all", () => {
  const r = rederiveContractPath(TEST_CONTRACT, [
    "src/server/queue/worker.ts",
    "package.json",
    "src/lib/util/format.ts",
  ]);
  assert.equal(r.remapped, false);
  assert.equal(r.suggestion, undefined, "no shared trailing directory, so not even a candidate");
});

test("rc.10: a one-segment tail is still too weak, in either kind direction", () => {
  const r = rederiveContractPath("src/__tests__/it/thing.test.ts", ["src/lib/it/errors.ts"]);
  assert.equal(r.remapped, false);
  assert.equal(r.suggestion, undefined, "rejected on width before kind is consulted");
});

test("rc.10: cross-kind evidence yields at most ONE suggestion, deterministically", () => {
  const r = rederiveContractPath(TEST_CONTRACT, [
    "src/lib/it/client-offboarding-errors.ts",
    "app/lib/it/other.ts",
  ]);
  assert.equal(r.remapped, false);
  assert.ok(r.suggestion, "a candidate is still offered");
  // Both share the `lib/it` tail; the tie is broken by the from=>to string, so
  // the result cannot depend on the order the run happened to touch files in.
  const reversed = rederiveContractPath(TEST_CONTRACT, [
    "app/lib/it/other.ts",
    "src/lib/it/client-offboarding-errors.ts",
  ]);
  assert.deepEqual(reversed.suggestion.via, r.suggestion.via, "order of evidence must not change the answer");
});

test("rc.10: same-kind evidence wins over cross-kind evidence for the same tail", () => {
  const r = rederiveContractPath("tests/api/grc/policy.test.ts", [
    "src/lib/api/grc/helper.ts", // cross-kind, would suggest tests -> src/lib
    "src/__tests__/api/grc/evidence-export.test.ts", // same-kind, should apply
  ]);
  assert.equal(r.remapped, true);
  assert.equal(r.path, "src/__tests__/api/grc/policy.test.ts");
  assert.equal(r.suggestion, undefined, "an applied correction leaves no open question");
});

/* ------------------------------------------------------------------ *
 * 5. The plan must never receive an unvalidated correction
 * ------------------------------------------------------------------ */

test("rc.10 (5592): a refused rewrite never reaches the stored plan", () => {
  // Audit 5592 is the half that made 5591 durable. The writeback is driven by
  // pathCorrections, and a suggestion must not produce one.
  const r = rederiveContractPath(TEST_CONTRACT, PRODUCTION_EVIDENCE);
  const corrections = r.remapped ? [{ from: TEST_CONTRACT, to: r.path }] : [];
  assert.deepEqual(corrections, [], "nothing to write back");

  const wb = applyPathCorrections([TEST_CONTRACT, "src/lib/it/client-offboarding-errors.ts"], corrections);
  assert.deepEqual(wb.applied, []);
  assert.ok(wb.files.includes(TEST_CONTRACT), "the plan keeps the path the brief asked for");
  assert.ok(!wb.files.includes(PHANTOM));
});

test("rc.10: the loop's suggestion branch still cannot push a correction", async () => {
  const { readFileSync } = await import("node:fs");
  const loop = readFileSync(new URL("../src/orchestrator/legacy-loop.ts", import.meta.url), "utf8");
  const start = loop.indexOf("if (rd.suggestion) {");
  const end = loop.indexOf("if (!rd.remapped) return v;", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(loop.slice(start, end), /pathCorrections\.push/);
});

test("rc.10: the loop passes the repository inventory into re-derivation", async () => {
  const { readFileSync } = await import("node:fs");
  const loop = readFileSync(new URL("../src/orchestrator/legacy-loop.ts", import.meta.url), "utf8");
  assert.match(loop, /rederiveContractPath\(v\.path, \[\.\.\.discoveredRealPaths\], \{ repoFiles: repoInventory \}\)/);
  // And it must degrade to empty rather than throwing the sub-task.
  assert.match(loop, /listRepoFiles\(workerWorktree\)\.catch\(\(\) => \[\] as string\[\]\)/);
});
