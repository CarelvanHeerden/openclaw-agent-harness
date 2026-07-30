// beta.93 — the contract-path re-derivation FALSE-POSITIVE cure (session
// de0cba9f, the b92 DR/BCP smoke). beta.76's aggressive prefix-remapper learned
// a `src/components -> src/lib` remap from ONE sub-task's touched file
// (`src/lib/grc/continuity-exercises.ts`) purely on the shared trailing dir
// `grc`, then applied it to a DIFFERENT, already-correct contract
// (`src/components/grc/poi-attachment-upload.tsx`) that the worker had committed
// at EXACTLY its declared path. The strict file_committed check then false-failed
// a correct commit as "confabulation".
//
// FIX = GUARD (a): if the contract path is ALREADY one of the real touched files,
// there is nothing to correct -> return it UNCHANGED. This closes the class
// outright and demotes re-derivation to a genuine last-resort (fires only when
// the declared path is absent from what the run touched). We deliberately did NOT
// add a same-basename guard, because the beta.76 cure legitimately relies on a
// different-basename sibling as prefix-drift evidence (that regression is guarded
// by the retained beta.76 suite).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  rederiveContractPath,
  learnRemapsForDir,
} from "../dist/orchestrator/contract-rederive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(__dirname, "..", "src", p), "utf8");

// ─────────────────────────────────────────────────────────────────────────
// THE ORACLE: the exact de0cba9f cycle-1 sub-task 9 case.
// ─────────────────────────────────────────────────────────────────────────
test("beta.93 ORACLE: a correctly-committed contract path is NOT re-derived (de0cba9f)", () => {
  // sub-task 3 touched src/lib/grc/continuity-exercises.ts (shares tail `grc`).
  // sub-task 9 declared AND committed src/components/grc/poi-attachment-upload.tsx.
  // At re-derive time the run's real-touched set contains BOTH (loop.ts adds the
  // sub-task's own filesChanged before re-deriving its contract).
  const real = [
    "src/lib/grc/continuity-exercises.ts", // unrelated sibling (the false-evidence)
    "src/components/grc/poi-attachment-upload.tsx", // sub-task 9's own correct commit
  ];
  const contract = "src/components/grc/poi-attachment-upload.tsx";
  const rd = rederiveContractPath(contract, real);
  assert.equal(rd.remapped, false, "an exactly-committed path must never be remapped");
  assert.equal(rd.path, contract, "path must be returned verbatim");
});

test("beta.93 GUARD (a): exact-match short-circuit even when a spurious remap is learnable", () => {
  // Prove the short-circuit wins: without guard (a), learnRemapsForDir WOULD
  // produce the src/components -> src/lib remap from the grc-tail sibling.
  const staleDir = "src/components/grc";
  const remaps = learnRemapsForDir(staleDir, ["src/lib/grc/continuity-exercises.ts"]);
  assert.ok(
    remaps.some((r) => r.from === "src/components" && r.to === "src/lib" && r.tail === "grc"),
    `the spurious remap is still learnable (guard (a) is what suppresses it): ${JSON.stringify(remaps)}`,
  );
  // But rederive short-circuits because the contract is itself in realFiles.
  const rd = rederiveContractPath("src/components/grc/poi-attachment-upload.tsx", [
    "src/lib/grc/continuity-exercises.ts",
    "src/components/grc/poi-attachment-upload.tsx",
  ]);
  assert.equal(rd.remapped, false);
});

test("beta.93 GUARD (a): exact match is normalised (leading ./ , duplicate slashes)", () => {
  const rd = rederiveContractPath("src/components/grc/poi-attachment-upload.tsx", [
    "./src/components/grc/poi-attachment-upload.tsx",
  ]);
  assert.equal(rd.remapped, false, "a normalisation-equal touched path counts as an exact match");
});

// ─────────────────────────────────────────────────────────────────────────
// GENUINE drift still gets corrected (guard (a) does not over-suppress).
// ─────────────────────────────────────────────────────────────────────────
test("beta.93: a GENUINELY-drifted path (absent from touched set) is still re-derived", () => {
  // The contract path is NOT among the real touched files -> guard (a) does not
  // fire -> the beta.76 prefix-drift correction still applies.
  const real = ["src/components/grc/widget.tsx"]; // sibling proves src/ was inserted
  const rd = rederiveContractPath("components/grc/other.tsx", real);
  assert.equal(rd.remapped, true, "a real prefix drift must still be corrected");
  assert.equal(rd.path, "src/components/grc/other.tsx");
});

test("beta.93: the beta.76 test-file descriptive-rename cure is preserved", () => {
  const real = ["src/__tests__/api/grc/evidence-fileurl-validation.test.ts"];
  const rd = rederiveContractPath("tests/api/grc/evidence.test.ts", real);
  assert.equal(rd.remapped, true);
  assert.equal(rd.path, "src/__tests__/api/grc/evidence.test.ts");
});

// ─────────────────────────────────────────────────────────────────────────
// Wiring source-assertions.
// ─────────────────────────────────────────────────────────────────────────
test("wiring: rederiveContractPath has the exact-match short-circuit", () => {
  const rr = src("orchestrator/contract-rederive.ts");
  assert.ok(/GUARD \(a\)/.test(rr), "documents guard (a)");
  // The short-circuit loops realFiles and returns unchanged on an exact match.
  assert.ok(
    /for \(const f of realFiles\)[\s\S]*normalisePath\(f\) === c[\s\S]*remapped: false/.test(rr),
    "exact-match short-circuit returns the path unchanged",
  );
  // It must run BEFORE learnRemapsForDir (order matters).
  const idxShort = rr.indexOf("normalisePath(f) === c");
  const idxLearn = rr.indexOf("const remaps = learnRemapsForDir(staleDir");
  assert.ok(idxShort > 0 && idxLearn > 0 && idxShort < idxLearn, "guard (a) precedes the learnRemapsForDir call");
});

test("wiring: loop gates re-derivation on contract_rederive_enabled (kill-switch)", () => {
  const loop = src("orchestrator/loop.ts");
  assert.ok(loop.includes("contract_rederive_enabled"), "loop reads the kill-switch");
  assert.ok(
    /contract_rederive_enabled !== false/.test(loop),
    "default-on: only disabled when explicitly false",
  );
  assert.ok(/if \(!rederiveEnabled\) return v;/.test(loop), "skips re-derivation when disabled");
});

test("wiring: config + manifest declare contract_rederive_enabled (default true)", () => {
  const cfg = src("config.ts");
  assert.ok(/contract_rederive_enabled\?:\s*boolean/.test(cfg), "config field declared");
  assert.ok(/contract_rederive_enabled:\s*true/.test(cfg), "config default true");
  const manifest = JSON.parse(src("../openclaw.plugin.json"));
  // Walk to the loop config schema block.
  const findKey = (obj) => {
    if (obj && typeof obj === "object") {
      if (obj.contract_rederive_enabled) return obj.contract_rederive_enabled;
      for (const v of Object.values(obj)) {
        const hit = findKey(v);
        if (hit) return hit;
      }
    }
    return null;
  };
  const decl = findKey(manifest);
  assert.ok(decl, "manifest declares contract_rederive_enabled");
  assert.equal(decl.type, "boolean");
  assert.equal(decl.default, true);
});

test("beta.93 version floor", () => {
  const ver = src("version.ts");
  const m = ver.match(/pluginVersion:\s*"0\.1\.0-beta\.(\d+)"/);
  assert.ok(m, "pluginVersion present");
  assert.ok(Number(m[1]) >= 93, `expected >= beta.93, got beta.${m[1]}`);
});
