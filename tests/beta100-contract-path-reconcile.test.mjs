// beta.100: the b99 smoke died at cycle 1 sub-task 3 holding a correct commit.
//
// Session 4420aa45 (DR/BCP brief, ProjectThanos). The lead authored a co-located
// contract path `src/app/api/grc/continuity-exercises/route.test.ts`. The worker
// committed d7cc9602 with BOTH deliverables, placing the test at the repo's real
// Jest location `src/__tests__/api/grc/continuity-exercises-api.test.ts` -- the
// correct choice, because `jest.config.ts`'s testMatch is
// `**/__tests__/**/*.test.ts` and a co-located file would never run in CI.
//
// THREE layers that each existed to catch this all missed:
//   1. rederiveContractPath (b76/b93) learns a prefix remap only from a SHARED
//      TRAILING dir chain; `.../continuity-exercises` and `src/__tests__/api/grc`
//      share none, so it returned the path unchanged.
//   2. path-match's `test-file-unique` rule (b76) resolves this shape correctly
//      but b84's `strictContract: true` on file_committed early-returns before it.
//   3. The b55 clarification escalation requires NO commit, so a reasoned
//      deviation that DID commit had no recovery at all -> hard fail, no PR.
//
// These tests pin each link so the chain cannot re-form.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { reconcileTestContractPaths, rederiveContractPath, learnRemapsForDir } =
  await import("../dist/orchestrator/contract-rederive.js");
const { resolveContractPath, isTestFilePath } = await import("../dist/orchestrator/path-match.js");

// The exact b99 seq-3 ground truth.
const B99_CONTRACT_ROUTE = "src/app/api/grc/continuity-exercises/route.ts";
const B99_CONTRACT_TEST = "src/app/api/grc/continuity-exercises/route.test.ts";
const B99_COMMITTED = [
  "src/__tests__/api/grc/continuity-exercises-api.test.ts",
  "src/app/api/grc/continuity-exercises/route.ts",
];

// --- 1. the regression itself -------------------------------------------------

test("beta100: the b99 seq-3 test contract reconciles onto the file the worker actually committed", () => {
  const out = reconcileTestContractPaths([B99_CONTRACT_ROUTE, B99_CONTRACT_TEST], B99_COMMITTED);
  assert.equal(out.length, 1);
  assert.equal(out[0].from, B99_CONTRACT_TEST);
  assert.equal(out[0].to, "src/__tests__/api/grc/continuity-exercises-api.test.ts");
});

test("beta100: the RECONCILED contract passes the strict file_committed check that killed b99", () => {
  // Before: the strict resolver (what fileCommittedSince uses) finds nothing.
  assert.equal(resolveContractPath(B99_COMMITTED, B99_CONTRACT_TEST, { strictContract: true }), null);
  // After reconciliation the SAME strict resolver is satisfied -- we cured the
  // contract, we did NOT loosen the verifier.
  const [rc] = reconcileTestContractPaths([B99_CONTRACT_ROUTE, B99_CONTRACT_TEST], B99_COMMITTED);
  const hit = resolveContractPath(B99_COMMITTED, rc.to, { strictContract: true });
  assert.ok(hit);
  assert.equal(hit.rule, "exact");
});

test("beta100: the non-test contract entry is untouched by reconciliation", () => {
  const out = reconcileTestContractPaths([B99_CONTRACT_ROUTE, B99_CONTRACT_TEST], B99_COMMITTED);
  assert.equal(out.some((r) => r.from === B99_CONTRACT_ROUTE), false);
});

// --- 2. pin WHY the two existing layers missed --------------------------------

test("beta100: b76 rederive still cannot fix the b99 shape (no shared trailing dir chain)", () => {
  // Documents the gap b100 fills. If this ever starts remapping, b100's rule
  // becomes redundant -- but it must never REGRESS into a wrong remap either.
  assert.deepEqual(learnRemapsForDir("src/app/api/grc/continuity-exercises", B99_COMMITTED), []);
  const rd = rederiveContractPath(B99_CONTRACT_TEST, B99_COMMITTED);
  assert.equal(rd.remapped, false);
  assert.equal(rd.path, B99_CONTRACT_TEST);
});

test("beta100: b84 strictContract still disables the b76 test-file-unique fallback", () => {
  // We deliberately did NOT re-open the fuzzy fallbacks; this pins that choice.
  assert.equal(resolveContractPath(B99_COMMITTED, B99_CONTRACT_TEST, { strictContract: true }), null);
  const fuzzy = resolveContractPath(B99_COMMITTED, B99_CONTRACT_TEST, { allowTestFileFallback: true });
  assert.equal(fuzzy.rule, "test-file-unique");
});

// --- 3. NEGATIVES: the b84 sibling false-positive must stay closed ------------

test("beta100: a NON-test contract path never reconciles (b84 sibling false-positive stays closed)", () => {
  // b84's actual bug: contract `.../poi-inventory/route.ts` basename-unique
  // matched its `.../poi-inventory/download/route.ts` sibling and reported PASS.
  const contract = "src/app/api/grc/poi-inventory/route.ts";
  const committed = ["src/app/api/grc/poi-inventory/download/route.ts"];
  assert.equal(isTestFilePath(contract), false);
  assert.deepEqual(reconcileTestContractPaths([contract], committed), []);
});

test("beta100: an unmatched non-test contract is never reconciled even alongside a free test file", () => {
  const out = reconcileTestContractPaths(
    ["src/app/api/grc/thing/route.ts"],
    ["src/__tests__/api/grc/thing-api.test.ts"],
  );
  assert.deepEqual(out, []);
});

// --- 4. NEGATIVES: ambiguity must fall through to a real failure --------------

test("beta100: TWO unmatched test contracts -> no reconciliation (ambiguous pairing)", () => {
  const out = reconcileTestContractPaths(
    ["src/app/a/route.test.ts", "src/app/b/route.test.ts"],
    ["src/__tests__/api/a-api.test.ts", "src/__tests__/api/b-api.test.ts"],
  );
  assert.deepEqual(out, []);
});

test("beta100: TWO unclaimed committed test files -> no reconciliation (ambiguous pairing)", () => {
  const out = reconcileTestContractPaths(
    ["src/app/a/route.test.ts"],
    ["src/__tests__/api/a-api.test.ts", "src/__tests__/api/b-api.test.ts"],
  );
  assert.deepEqual(out, []);
});

test("beta100: a committed test file already CLAIMED by another contract entry is not reused", () => {
  // The only committed test file exactly satisfies contract entry #1, so it is
  // claimed and entry #2 has no free counterpart -> no guess.
  const committed = ["src/__tests__/api/a-api.test.ts"];
  const out = reconcileTestContractPaths(
    ["src/__tests__/api/a-api.test.ts", "src/app/b/route.test.ts"],
    committed,
  );
  assert.deepEqual(out, []);
});

test("beta100: a test contract the worker satisfied EXACTLY is left alone", () => {
  const p = "src/__tests__/api/grc/thing-api.test.ts";
  assert.deepEqual(reconcileTestContractPaths([p], [p]), []);
});

test("beta100: a test contract satisfied via a STRUCTURAL rule is left alone", () => {
  // suffix match: committed carries a monorepo prefix the contract omitted.
  const contract = "src/__tests__/api/thing.test.ts";
  const committed = ["packages/web/src/__tests__/api/thing.test.ts"];
  assert.ok(resolveContractPath(committed, contract, { strictContract: true }));
  assert.deepEqual(reconcileTestContractPaths([contract], committed), []);
});

test("beta100: no committed files, or no contract paths, reconciles nothing", () => {
  assert.deepEqual(reconcileTestContractPaths([B99_CONTRACT_TEST], []), []);
  assert.deepEqual(reconcileTestContractPaths([], B99_COMMITTED), []);
  assert.deepEqual(reconcileTestContractPaths([B99_CONTRACT_TEST], ["   ", ""]), []);
});

test("beta100: a sub-task that committed ONLY non-test files reconciles nothing", () => {
  const out = reconcileTestContractPaths(
    [B99_CONTRACT_TEST],
    ["src/app/api/grc/continuity-exercises/route.ts", "prisma/schema.prisma"],
  );
  assert.deepEqual(out, []);
});

test("beta100: duplicate entries in the touched set do not fake an ambiguity", () => {
  const dup = [...B99_COMMITTED, ...B99_COMMITTED, "  src/app/api/grc/continuity-exercises/route.ts  "];
  const out = reconcileTestContractPaths([B99_CONTRACT_ROUTE, B99_CONTRACT_TEST], dup);
  assert.equal(out.length, 1);
  assert.equal(out[0].to, "src/__tests__/api/grc/continuity-exercises-api.test.ts");
});

test("beta100: reconciliation is repo-agnostic (pytest / Go conventions, not just Jest)", () => {
  const pytest = reconcileTestContractPaths(
    ["app/api/orders.test.py"],
    ["tests/api/test_orders.py", "app/api/orders.py"],
  );
  assert.equal(pytest.length, 1);
  assert.equal(pytest[0].to, "tests/api/test_orders.py");

  const go = reconcileTestContractPaths(
    ["internal/api/orders_test.go"],
    ["internal/api/handlers/orders_test.go", "internal/api/orders.go"],
  );
  assert.equal(go.length, 1);
  assert.equal(go[0].to, "internal/api/handlers/orders_test.go");
});

// --- 5. loop wiring -----------------------------------------------------------

const loopSrc = readFileSync(new URL("../src/orchestrator/loop.ts", import.meta.url), "utf8");

test("beta100: the loop calls reconcileTestContractPaths, gated by its own config key", () => {
  assert.match(loopSrc, /import \{ rederiveContractPath, reconcileTestContractPaths \}/);
  assert.match(loopSrc, /config\.loop\.contract_test_path_reconcile !== false/);
  assert.match(loopSrc, /reconcileTestContractPaths\(pathEntryPaths, subTaskTouched\)/);
});

test("beta100: reconciliation is fed the PER-SUB-TASK file set, never the run-wide one", () => {
  // SAFETY-CRITICAL. The 1:1 uniqueness guard is only sound on a sub-task-scoped
  // list -- the same argument the b59/b76 fallbacks rest on. Passing
  // discoveredRealPaths (run-wide) would let an unrelated earlier sub-task's test
  // file satisfy this sub-task's contract.
  const block = loopSrc.slice(
    loopSrc.indexOf("const subTaskTouched"),
    loopSrc.indexOf("reconcileTestContractPaths(pathEntryPaths, subTaskTouched)"),
  );
  assert.ok(block.length > 0, "reconciliation block not found");
  assert.match(block, /result\.filesChanged/);
  assert.match(block, /result\.uncommittedFiles/);
  assert.equal(/discoveredRealPaths/.test(block), false);
});

test("beta100: reconciliation emits an audit event so a rewrite is never silent", () => {
  assert.match(loopSrc, /loop\.contract_test_path_reconciled/);
});

test("beta100: only file_written / file_committed entries are eligible for reconciliation", () => {
  assert.match(loopSrc, /v\.kind === "file_written" \|\| v\.kind === "file_committed"/);
});

// --- 6. the contract-mismatch pause (link 3) ----------------------------------

test("beta100: a contract-path mismatch on a REAL commit pauses instead of hard-failing", () => {
  assert.match(loopSrc, /loop\.contract_path_mismatch_escalated/);
  assert.match(loopSrc, /contract_mismatch_escalation_enabled !== false/);
  const block = loopSrc.slice(
    loopSrc.indexOf("const PATH_MISMATCH_KINDS"),
    loopSrc.indexOf("loop.contract_path_mismatch_escalated"),
  );
  // It must require a REAL commit -- that is precisely the case b53/b35/b55 miss.
  assert.match(block, /!!result\.commitSha/);
  // And every failing check must be a path-bearing mismatch; any other failure
  // kind (a confabulated push/PR) must still hard-fail.
  assert.match(block, /PATH_MISMATCH_KINDS\.has\(x\.kind\) && !!x\.path/);
});

test("beta100: the pause does NOT accept the sub-task -- it still fails verification", () => {
  // The status write and failed.err assignment must both precede the escalation,
  // so the disposition changes but the verdict does not.
  const failIdx = loopSrc.indexOf("failed_verification', summary = ?");
  const escalateIdx = loopSrc.indexOf("const PATH_MISMATCH_KINDS");
  assert.ok(failIdx > 0 && escalateIdx > failIdx, "escalation must come AFTER the failure is recorded");
});

test("beta100: the mismatch question is built from git ground truth, not the worker's prose", () => {
  const block = loopSrc.slice(
    loopSrc.indexOf("const PATH_MISMATCH_KINDS"),
    loopSrc.indexOf("clarify.subtask = { title: st.title, intent: st.intent };", loopSrc.indexOf("const PATH_MISMATCH_KINDS")),
  );
  // expected paths come from the contract's failed results, actual from git.
  assert.match(block, /failedResults\.map\(\(x\) => x\.path!\)/);
  assert.match(block, /result\.filesChanged/);
  // The worker's message may only ever be passed along as a stated reason.
  // b111 moved the question's prose into contract-clarify.ts, so the loop now
  // hands `statedReason` to the builder rather than interpolating it here --
  // the constraint is the same, the seam moved.
  assert.match(block, /statedReason/);
  assert.match(block, /extractStatedReason\(result\.finalMessage/);
  assert.ok(
    !/\$\{[^}]*finalMessage/.test(block),
    "the raw worker message must never be interpolated into operator-facing text",
  );
});

test("beta100: the pause reuses the b55 resumable machinery (worktree preserved)", () => {
  assert.match(loopSrc, /clarification_escalation_enabled !== false/);
  // b105 inserted the basename rescue between the mismatch test and the
  // escalation, so the window is wider than it was.
  // b105 inserted the basename rescue and b111 the auto-resolution between the
  // mismatch test and the escalation, so the window keeps widening.
  const block = loopSrc.slice(loopSrc.indexOf("const PATH_MISMATCH_KINDS"));
  assert.match(block.slice(0, 12000), /clarify\.question = buildContractClarification/);
  assert.match(block.slice(0, 12000), /clarify\.seq = st\.seq/);
});

// --- 7. config + version ------------------------------------------------------

const MINIMAL_CONFIG = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["example-org/*"], default_base_branch: "main" },
};

test("beta100: both new config keys default to true", async () => {
  const { parseHarnessConfig } = await import("../dist/config.js");
  const cfg = parseHarnessConfig(MINIMAL_CONFIG);
  assert.equal(cfg.loop.contract_test_path_reconcile, true);
  assert.equal(cfg.loop.contract_mismatch_escalation_enabled, true);
});

test("beta100: both new keys are operator-overridable to false", async () => {
  const { parseHarnessConfig } = await import("../dist/config.js");
  const cfg = parseHarnessConfig({
    ...MINIMAL_CONFIG,
    loop: { contract_test_path_reconcile: false, contract_mismatch_escalation_enabled: false },
  });
  assert.equal(cfg.loop.contract_test_path_reconcile, false);
  assert.equal(cfg.loop.contract_mismatch_escalation_enabled, false);
});

test("beta100: both new keys are declared in the plugin manifest schema", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const loop = manifest.configSchema.properties.loop.properties;
  assert.equal(loop.contract_test_path_reconcile.default, true);
  assert.equal(loop.contract_mismatch_escalation_enabled.default, true);
});

test("beta100: pluginVersion and package.json agree at >= beta.100", async () => {
  const { PLUGIN_VERSION } = await import("../dist/version.js");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PLUGIN_VERSION.pluginVersion, pkg.version);
  const n = Number(/beta\.(\d+)$/.exec(pkg.version)?.[1] ?? 0);
  assert.ok(n >= 100, `expected >= beta.100, got ${pkg.version}`);
});
