// beta.76 — the big fix: (A) test-file-unique path fallback, (1) contract-path
// RE-DERIVATION (the real cure for path drift), (B) disk-preflight + corrupt-
// node_modules diagnostic.
//
// ROOT (Opus-5/Sonnet-5 smoke, session 73e7451f, seq 3): lead contract path
// `tests/api/grc/evidence.test.ts` drifted from the worker's committed
// `src/__tests__/api/grc/evidence-fileurl-validation.test.ts` on BOTH axes
// (directory topology `tests/` vs `src/__tests__/`, AND basename generic vs
// descriptive) -> past every existing match rule incl. basename-unique. Plus a
// second defect: the worktree `npm ci` hit ENOSPC, corrupting node_modules so
// the test could not run -> a scoped-single-test-file accept could false-green
// an UNRUN test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  resolveContractPath,
  isTestFilePath,
} from "../dist/orchestrator/path-match.js";
import {
  rederiveContractPath,
  learnRemapsForDir,
} from "../dist/orchestrator/contract-rederive.js";
import { looksLikeDiskExhaustion } from "../dist/adapters/git-worktree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");
function src(rel) {
  return readFileSync(join(SRC, rel), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────
// Defect A: isTestFilePath — repo-agnostic test-file detection.
// ─────────────────────────────────────────────────────────────────────────
test("isTestFilePath recognises every common convention", () => {
  assert.equal(isTestFilePath("src/__tests__/api/grc/evidence-fileurl-validation.test.ts"), true);
  assert.equal(isTestFilePath("tests/api/grc/evidence.test.ts"), true);
  assert.equal(isTestFilePath("foo.spec.tsx"), true);
  assert.equal(isTestFilePath("pkg/handler_test.go"), true); // Go co-located
  assert.equal(isTestFilePath("tests/test_upload.py"), true); // pytest name
  assert.equal(isTestFilePath("spec/models/user_spec.rb"), true); // RSpec dir
  assert.equal(isTestFilePath("test/unit/thing.js"), true); // Node test/ dir
  // NOT test files:
  assert.equal(isTestFilePath("src/app/api/grc/evidence/route.ts"), false);
  assert.equal(isTestFilePath("src/lib/taxonomy.ts"), false);
  assert.equal(isTestFilePath("README.md"), false);
});

test("Defect A: test-file-unique fallback resolves the exact seq-3 drift", () => {
  const contract = "tests/api/grc/evidence.test.ts";
  const committed = ["src/__tests__/api/grc/evidence-fileurl-validation.test.ts"];
  // basename-unique alone MISSES (basenames differ):
  assert.equal(resolveContractPath(committed, contract, { allowBasenameFallback: true }), null);
  // test-file-unique catches it:
  const m = resolveContractPath(committed, contract, { allowBasenameFallback: true, allowTestFileFallback: true });
  assert.ok(m, "expected a match via test-file-unique");
  assert.equal(m.file, committed[0]);
  assert.equal(m.rule, "test-file-unique");
});

test("Defect A: test-file-unique falls through on 2+ committed test files (no guessing)", () => {
  const contract = "tests/api/grc/evidence.test.ts";
  const committed = [
    "src/__tests__/api/grc/evidence-fileurl-validation.test.ts",
    "src/__tests__/api/grc/evidence-internal-url.test.ts",
  ];
  const m = resolveContractPath(committed, contract, { allowBasenameFallback: true, allowTestFileFallback: true });
  assert.equal(m, null, "ambiguous >1 test files must fall through to a real failure");
});

test("Defect A: test-file-unique does not fire for a non-test contract", () => {
  const contract = "src/app/api/grc/evidence/route.ts";
  const committed = ["src/__tests__/api/grc/evidence.test.ts"];
  const m = resolveContractPath(committed, contract, { allowBasenameFallback: true, allowTestFileFallback: true });
  assert.equal(m, null, "impl contract must not resolve to a lone test file");
});

test("Defect A: opt-in only — default callers never get test-file-unique", () => {
  const contract = "tests/api/grc/evidence.test.ts";
  const committed = ["src/__tests__/api/grc/evidence-fileurl-validation.test.ts"];
  assert.equal(resolveContractPath(committed, contract), null);
  assert.equal(resolveContractPath(committed, contract, { allowBasenameFallback: true }), null);
});

test("Defect A: structural rules still WIN over the test-file fallback", () => {
  // A route-group match should win and report its own rule, not test-file-unique.
  const contract = "src/app/foo/page.tsx";
  const committed = ["src/app/(portal)/foo/page.tsx"];
  const m = resolveContractPath(committed, contract, { allowBasenameFallback: true, allowTestFileFallback: true });
  assert.equal(m.rule, "route-group");
});

// ─────────────────────────────────────────────────────────────────────────
// Option 1: contract re-derivation (the real cure).
// ─────────────────────────────────────────────────────────────────────────
test("learnRemapsForDir learns the tests/ -> src/__tests__/ remap from real files", () => {
  const remaps = learnRemapsForDir("tests/api/grc", [
    "src/app/api/grc/evidence/route.ts", // shares tail api/grc
    "src/__tests__/api/grc/evidence-fileurl-validation.test.ts", // shares tail api/grc, drift
  ]);
  // Expect a remap whose tail is api/grc and to-prefix reaches src/__tests__.
  const hit = remaps.find((r) => r.tail === "api/grc" && r.to === "src/__tests__");
  assert.ok(hit, `expected tests->src/__tests__ remap, got ${JSON.stringify(remaps)}`);
  assert.equal(hit.from, "tests");
});

test("Option 1: rederiveContractPath corrects the stale prefix, preserving tail+basename", () => {
  const real = ["src/__tests__/api/grc/evidence-fileurl-validation.test.ts"];
  const rd = rederiveContractPath("tests/api/grc/evidence.test.ts", real);
  assert.equal(rd.remapped, true);
  assert.equal(rd.path, "src/__tests__/api/grc/evidence.test.ts");
  // The corrected path now resolves against the committed file via test-file-unique.
  const m = resolveContractPath(real, rd.path, { allowBasenameFallback: true, allowTestFileFallback: true });
  assert.ok(m);
});

test("Option 1: no evidence-backed remap -> path returned unchanged (never stricter)", () => {
  // No real file shares a trailing subtree with the stale dir.
  const rd = rederiveContractPath("tests/api/grc/evidence.test.ts", ["src/lib/unrelated/helper.ts"]);
  assert.equal(rd.remapped, false);
  assert.equal(rd.path, "tests/api/grc/evidence.test.ts");
});

test("Option 1: empty ground-truth set is a no-op", () => {
  const rd = rederiveContractPath("tests/api/grc/evidence.test.ts", []);
  assert.equal(rd.remapped, false);
});

test("Option 1: a bare-filename contract (no dir) is left unchanged", () => {
  const rd = rederiveContractPath("evidence.test.ts", ["src/__tests__/x/evidence.test.ts"]);
  assert.equal(rd.remapped, false);
});

test("Option 1: prefix-only drift (src/ inserted) is learned and corrected", () => {
  const real = ["src/components/grc/widget.tsx"];
  const rd = rederiveContractPath("components/grc/other.tsx", real);
  assert.equal(rd.remapped, true);
  assert.equal(rd.path, "src/components/grc/other.tsx");
});

// ─────────────────────────────────────────────────────────────────────────
// Defect B: disk exhaustion classification.
// ─────────────────────────────────────────────────────────────────────────
test("Defect B: looksLikeDiskExhaustion catches the real signatures", () => {
  assert.equal(looksLikeDiskExhaustion("npm ci failed (1): ENOSPC: no space left on device"), true);
  assert.equal(looksLikeDiskExhaustion("Error: EIO: i/o error, write"), true);
  assert.equal(looksLikeDiskExhaustion("disk quota exceeded"), true);
  assert.equal(looksLikeDiskExhaustion("npm ERR! code E404 not found"), false);
  assert.equal(looksLikeDiskExhaustion("tsc: type error TS2345"), false);
  assert.equal(looksLikeDiskExhaustion(""), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Wiring source-assertions.
// ─────────────────────────────────────────────────────────────────────────
test("wiring: index.ts enables allowTestFileFallback at the 3 scoped call sites", () => {
  const idx = src("index.ts");
  const hits = idx.match(/allowTestFileFallback:\s*true/g) ?? [];
  assert.ok(hits.length >= 3, `expected >=3 allowTestFileFallback:true, found ${hits.length}`);
});

test("wiring: loop.ts re-derives contract paths + accumulates discovered paths", () => {
  const loop = src("orchestrator/loop.ts");
  assert.ok(loop.includes('import { rederiveContractPath }'), "loop imports rederiveContractPath");
  assert.ok(loop.includes("discoveredRealPaths"), "loop accumulates discoveredRealPaths");
  assert.ok(loop.includes("loop.contract_path_rederived"), "loop audits contract_path_rederived");
  // The accumulate step reads both committed and uncommitted files.
  assert.ok(/result\.filesChanged.*result\.uncommittedFiles/s.test(loop), "accumulates filesChanged + uncommittedFiles");
  // Re-derivation must skip file_in_pr (repo-wide list, not scoped).
  assert.ok(loop.includes('v.kind === "file_in_pr"'), "re-derivation skips file_in_pr");
});

test("wiring: git-worktree disk preflight + disk-exhaustion escalation", () => {
  const gw = src("adapters/git-worktree.ts");
  assert.ok(gw.includes("minFreeDiskBytes"), "GitAdapterOptions carries minFreeDiskBytes");
  assert.ok(gw.includes("statfsSync"), "uses statfsSync for the preflight");
  assert.ok(gw.includes("harness.worktree_disk_low"), "surfaces the disk-low diagnostic");
  assert.ok(gw.includes("harness.worktree_bootstrap_disk_exhaustion"), "escalates a disk-exhaustion install failure");
  assert.ok(gw.includes("looksLikeDiskExhaustion(msg)"), "classifies the catch on disk-exhaustion");
});

test("wiring: config + manifest declare min_free_disk_bytes", () => {
  const cfg = src("config.ts");
  assert.ok(cfg.includes("min_free_disk_bytes: number"), "StorageConfig field");
  assert.ok(/min_free_disk_bytes:\s*1024 \* 1024 \* 1024/.test(cfg), "default 1 GiB");
  const manifest = src("../openclaw.plugin.json");
  assert.ok(manifest.includes('"min_free_disk_bytes"'), "manifest declares the key");
});
