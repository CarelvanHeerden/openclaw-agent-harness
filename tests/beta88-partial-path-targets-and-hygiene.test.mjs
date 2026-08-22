/**
 * beta.88 — close [E1] from Staging's 2nd deep-dive + the small hygiene nits.
 *
 * [E1] (blocking, introduced by beta.87 tightening): a NON-EMPTY targeted set
 * that structurally resolves to ZERO contract paths (adversary wrote a PARTIAL
 * path like `download/route.ts`, shorter than the full contract path, so no
 * structural rule matches) is functionally identical to an empty set -> every
 * entry would relax -> the same false-pass the beta.86 empty-targets fix closed.
 * Fix: only enter the relaxation path when at least ONE target actually resolves
 * to a contract path in this sub-task; else keep strict + audit
 * `loop.revise_contract_targets_unresolved`.
 *
 * [E3] doc: strictContract wins over the fuzzy flags. [E4]: de-dup map evicts on
 * terminal transition.
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

let resolveContractPath;
try {
  ({ resolveContractPath } = await import("../dist/orchestrator/path-match.js"));
} catch {
  resolveContractPath = null;
}
const skip = { skip: resolveContractPath === null };

const FULL = "src/app/api/grc/continuity-exercises/[id]/files/[fileId]/download/route.ts";

test("beta.88: version >= beta.88", () => {
  const betaNum = betaOrdinal;
  assert.ok(betaNum(JSON.parse(readSrc("package.json")).version) >= 88);
});

// [E1] — the exact partial-path shapes Staging traced must NOT structurally
// resolve to the full contract path (this is WHY the guard is needed).
test("beta.88 [E1]: partial-path adversary shorthand does NOT structurally resolve to the full contract", skip, () => {
  for (const partial of ["download/route.ts", "files/[fileId]/route.ts", "api/grc/route.ts"]) {
    assert.equal(
      resolveContractPath([partial], FULL, { strictContract: true }),
      null,
      `${partial} must NOT structurally match the full contract path (that's the [E1] hole)`,
    );
  }
  // sanity: the full path still resolves exactly.
  assert.ok(resolveContractPath([FULL], FULL, { strictContract: true }));
});

// [E1] wiring — the loop must gate relaxation on anyTargetResolvable, and audit
// the unresolved case distinctly so it can't silently relax everything.
test("beta.88 [E1]: loop gates relaxation on anyTargetResolvable + audits unresolved case", () => {
  const src = readSrc("src/orchestrator/loop.ts");
  assert.ok(/const anyTargetResolvable\s*=/.test(src), "computes anyTargetResolvable");
  assert.ok(/if \(anyTargetResolvable\) \{/.test(src), "relaxation gated on anyTargetResolvable, not just length");
  assert.ok(
    src.includes("loop.revise_contract_targets_unresolved"),
    "non-empty-but-unresolvable targets must audit revise_contract_targets_unresolved (keep strict)",
  );
  // the resolvability check itself uses strictContract against contract paths
  assert.ok(
    /anyTargetResolvable[\s\S]{0,260}resolveContractPath\(targetedFiles, v\.path, \{ strictContract: true \}\)/.test(src),
    "resolvability tested via strictContract against each contract path",
  );
});

// [E4] — de-dup map eviction on terminal
test("beta.88 [E4]: deliverProgress evicts the de-dup entry on a terminal transition", () => {
  const src = readSrc("src/index.ts");
  assert.ok(
    /status === "done" \|\| status === "failed" \|\| status === "aborted"[\s\S]{0,120}lastProgressHeadline\?\.delete\(sessionId\)/.test(src),
    "must delete the session's dedup entry on done/failed/aborted",
  );
});

// [E3] — documented precedence
test("beta.88 [E3]: path-match documents strictContract-wins precedence", () => {
  const src = readSrc("src/orchestrator/path-match.ts");
  assert.ok(/strictContract.{0,40}WINS|WINS over both fuzzy/.test(src), "strictContract precedence documented");
});
