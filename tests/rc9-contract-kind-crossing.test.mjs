/**
 * rc.9 -- a shared directory suffix does not authorise changing what KIND of
 * artifact a requirement is.
 *
 * StitchGuard, audit 5408, verbatim:
 *
 *   {"seq":11,"kind":"file_committed",
 *    "from":"okf/api/webhooks/client-offboarding-slack.md",
 *    "to":"src/__tests__/api/webhooks/client-offboarding-slack.md",
 *    "via":{"from":"okf","to":"src/__tests__","tail":"api/webhooks"}}
 *
 * The entire evidence for that rewrite was ONE file an earlier sub-task had
 * touched, `src/__tests__/api/webhooks/linear-webhook-status-sync.test.ts`,
 * whose directory happens to end in the same two segments. No shared basename,
 * no shared extension, not the same kind of thing. Audit 5409 then wrote the
 * change back into the plan, so the OKF path was gone -- and the worker's next
 * turn announced it would create "the harness-required help companion path
 * src/__tests__/api/webhooks/client-offboar...".
 *
 * The rc1 guard that already existed draws its line at the WIDTH of the
 * evidence (a tail must be >= 2 segments). `api/webhooks` is exactly two, so it
 * passed. This draws the line at the KIND, which no amount of extra tail can
 * establish.
 *
 * The negative controls matter as much as the fix: beta.76, beta.93 and
 * beta.100 exist because real prefix drift is real, and correcting a test path
 * onto the repo's actual test directory must still work.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { rederiveContractPath, learnRemapsForDir } from "../dist/orchestrator/contract-rederive.js";
import { isTestFilePath } from "../dist/orchestrator/path-match.js";

/** The incident, exactly as the audit recorded it. */
const OKF_CONTRACT = "okf/api/webhooks/client-offboarding-slack.md";
const TOUCHED = [
  "src/__tests__/api/webhooks/linear-webhook-status-sync.test.ts",
  "src/app/api/webhooks/linear/route.ts",
];

test("rc.9: the OKF documentation contract is NOT rewritten into the test tree", () => {
  const r = rederiveContractPath(OKF_CONTRACT, TOUCHED);
  assert.equal(r.remapped, false, "rc.8 rewrote this");
  assert.equal(r.path, OKF_CONTRACT, "the contract the brief asked for survives");
});

test("rc.9: the declined correction is retained with its provenance and confidence", () => {
  const r = rederiveContractPath(OKF_CONTRACT, TOUCHED);
  assert.ok(r.suggestion, "a candidate was found; it must be reported, not discarded");
  assert.equal(r.suggestion.path, "src/__tests__/api/webhooks/client-offboarding-slack.md");
  assert.deepEqual(r.suggestion.via, { from: "okf", to: "src/__tests__", tail: "api/webhooks" });
  assert.equal(r.suggestion.confidence, "low");
  assert.match(r.suggestion.reason, /shared 'api\/webhooks' directory suffix/);
  assert.match(r.suggestion.reason, /test tree/);
});

test("rc.9: one shared suffix is still all the evidence there ever was", () => {
  // Not a fix, a record: the mapping IS learnable from a single file, and that
  // is why the decision has to be made at application time.
  const remaps = learnRemapsForDir("okf/api/webhooks", TOUCHED);
  assert.deepEqual(remaps, [{ from: "okf", to: "src/__tests__", tail: "api/webhooks" }]);
});

test("rc.9: the crossing is detected by artifact kind, not by repository knowledge", () => {
  // Nothing here is StitchGuard-specific: a `.md` under `__tests__` is a test
  // path by the harness's own rule, and an OKF document is not.
  assert.equal(isTestFilePath(OKF_CONTRACT), false);
  assert.equal(isTestFilePath("src/__tests__/api/webhooks/client-offboarding-slack.md"), true);
});

/* ------------------------------------------------------------------ *
 * Negative controls: the legitimate corrections must survive
 * ------------------------------------------------------------------ */

test("rc.9: a genuine TEST-to-TEST directory correction still applies", () => {
  // beta.76's original case. Both sides are test paths, so no kind is crossed.
  const r = rederiveContractPath("tests/api/grc/policy.test.ts", [
    "src/__tests__/api/grc/evidence-export.test.ts",
  ]);
  assert.equal(r.remapped, true);
  assert.equal(r.path, "src/__tests__/api/grc/policy.test.ts");
  assert.equal(r.suggestion, undefined);
});

test("rc.9: a genuine SOURCE-to-SOURCE prefix correction still applies", () => {
  const r = rederiveContractPath("components/layout/sidebar.tsx", [
    "src/components/layout/header.tsx",
  ]);
  assert.equal(r.remapped, true);
  assert.equal(r.path, "src/components/layout/sidebar.tsx");
});

test("rc.9: this direction was left open, and rc.10 closed it -- see audit 5591", () => {
  // As shipped, rc.9 refused only non-test -> test, on the reasoning that "a
  // stale test-tree guess corrected onto real source is not the failure mode
  // being fixed". Audit 5591 was exactly that direction: a real test contract
  // rewritten into a phantom production path on the evidence of one production
  // file. The asymmetry was the defect, not a deliberate allowance.
  //
  // This case yields nothing either way (the dirs share no trailing segment),
  // so it never demonstrated the direction it claimed to. It is kept as the
  // record of an assumption that did not survive contact with a live run; the
  // direction it was meant to cover is asserted properly in
  // tests/rc10-contract-evidence-kind.test.mjs.
  const r = rederiveContractPath("src/__tests__/api/webhooks/handler.ts", [
    "src/app/api/webhooks/linear/route.ts",
  ]);
  assert.equal(r.remapped, false);
  assert.equal(r.suggestion, undefined, "no shared trailing directory, so there was never a candidate");
});

test("rc.9: the existing guards are untouched", () => {
  // Exact match short-circuits (beta.93).
  const exact = rederiveContractPath(OKF_CONTRACT, [OKF_CONTRACT, ...TOUCHED]);
  assert.equal(exact.remapped, false);
  assert.equal(exact.suggestion, undefined, "nothing to suggest when the path is already right");

  // A one-segment tail is still too weak to apply OR to suggest.
  const weak = rederiveContractPath("okf/webhooks/doc.md", [
    "src/__tests__/webhooks/thing.test.ts",
  ]);
  assert.equal(weak.remapped, false);
  assert.equal(weak.suggestion, undefined, "a 1-segment tail is rejected before the kind check");

  // No evidence, no change.
  assert.equal(rederiveContractPath(OKF_CONTRACT, []).remapped, false);
});

test("rc.9: the declined candidate is audited and never written back to the plan", async () => {
  const { readFileSync } = await import("node:fs");
  const loop = readFileSync(new URL("../src/orchestrator/legacy-loop.ts", import.meta.url), "utf8");
  assert.match(loop, /loop\.contract_path_correction_suggested/);

  // The suggestion branch must not reach `pathCorrections`, or the plan
  // writeback would apply the very rewrite this refuses.
  const start = loop.indexOf("if (rd.suggestion) {");
  const end = loop.indexOf("if (!rd.remapped) return v;", start);
  assert.ok(start >= 0 && end > start, "the suggestion branch must exist above the early return");
  assert.doesNotMatch(loop.slice(start, end), /pathCorrections\.push/);
});
