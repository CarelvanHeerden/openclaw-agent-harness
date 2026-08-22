/**
 * beta.89 [F3] — audit visibility on WHICH target source drove a cycle-2
 * sub-task's strict/relaxed decision.
 *
 * The revise-spec-applied path uses deterministic full-path workerContext
 * (clean targeting); the raw-findings fallback uses LLM `finding.file`
 * (partial-path shorthand -> likely `revise_contract_targets_unresolved` ->
 * strict-everywhere -> a possible false-FAIL of correct work). That asymmetry
 * is the one remaining named risk. beta.89 emits `loop.revise_target_source`
 * naming `revise_spec_worker_context` vs `raw_findings` so a post-mortem can
 * tell from a single query which path a sub-task ran under. Observability only,
 * no behaviour change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const readSrc = (rel) => readFileSync(join(ROOT, rel), "utf8");

test("beta.89: version >= beta.89", () => {
  const betaNum = betaOrdinal;
  assert.ok(betaNum(JSON.parse(readSrc("package.json")).version) >= 89);
});

test("beta.89 [F3]: loop audits loop.revise_target_source naming the source", () => {
  const src = readSrc("src/orchestrator/loop.ts");
  assert.ok(src.includes('"loop.revise_target_source"'), "emits loop.revise_target_source");
  assert.ok(
    /source: perSubTaskFiles\.length > 0 \? "revise_spec_worker_context" : "raw_findings"/.test(src),
    "source names revise_spec_worker_context vs raw_findings",
  );
  // must be emitted right after targetedFiles is chosen and BEFORE the
  // relaxation decision, so it fires on every revise cycle regardless of branch.
  const tIdx = src.indexOf("const targetedFiles = perSubTaskFiles.length > 0");
  const aIdx = src.indexOf('"loop.revise_target_source"');
  const gIdx = src.indexOf("const anyTargetResolvable");
  assert.ok(tIdx > 0 && aIdx > tIdx && gIdx > aIdx, "audit fires after target selection, before the relax gate");
});
