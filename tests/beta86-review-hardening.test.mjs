/**
 * beta.86 — two tightenings from Staging's independent review of beta.85 (PR #111),
 * closed BEFORE the smoke rather than deferred (Carel: "100%, no comebacks").
 *
 * #1 (correctness) Empty targetedFiles -> keep STRICT. beta.85's revise-relaxation
 *    computed targetedFiles from findings' `.file`. If a revise emits findings but
 *    NONE carries a file path, targetedFiles is empty and EVERY file_written/
 *    file_committed would be relaxed -- a new false-pass vector. beta.86: relax
 *    ONLY when targetedFiles is non-empty; otherwise keep everything strict and
 *    audit `loop.revise_contract_strict_no_targets`.
 *
 * #2 (UX) de-dup consecutive identical progress headlines in deliverProgress.
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

test("beta.86: version bumped to >= beta.86 in package.json + version.ts", () => {
  const betaNum = betaOrdinal;
  const pkg = JSON.parse(readSrc("package.json"));
  assert.ok(betaNum(pkg.version) >= 86, `package.json ${pkg.version}`);
  const ver = readSrc("src/version.ts");
  assert.ok(betaNum(/pluginVersion:\s*"([^"]+)"/.exec(ver)?.[1] ?? "") >= 86, "version.ts");
});

test("beta.86 #1: empty targetedFiles keeps STRICT (relaxation gated on non-empty set)", () => {
  const src = readSrc("src/orchestrator/loop.ts");
  // The relaxation loop must be gated on targetedFiles.length > 0.
  assert.ok(
    // beta.88: the gate tightened from `targetedFiles.length > 0` to
    // `anyTargetResolvable` (non-empty AND at least one target structurally
    // resolves to a contract path) -- so a fileless OR unresolvable target set
    // keeps everything strict.
    /if \(anyTargetResolvable\) \{/.test(src),
    "relaxation must only run when a target actually resolves to a contract path",
  );
  // The else branch keeps strict + audits the distinct reason.
  assert.ok(
    src.includes("loop.revise_contract_strict_no_targets"),
    "fileless-findings case must audit revise_contract_strict_no_targets (keep strict)",
  );
  // reviseRelaxed still only set inside the guarded (resolvable) block.
  const relaxedIdx = src.indexOf("reviseRelaxed: true");
  const guardIdx = src.indexOf("if (anyTargetResolvable) {");
  assert.ok(relaxedIdx > guardIdx && guardIdx > 0, "reviseRelaxed must be set inside the resolvable guard");
});

test("beta.86 #1(a): revise_contract_relaxed audit + log echo the targeted set", () => {
  const src = readSrc("src/orchestrator/loop.ts");
  // both the audit and the interaction log carry targetedFiles for post-mortems.
  assert.ok(/revise_contract_relaxed[\s\S]{0,200}targetedFiles/.test(src), "audit echoes targetedFiles");
  assert.ok(/event: "revise_contract_relaxed"[\s\S]{0,160}targetedFiles/.test(src), "interaction log echoes targetedFiles");
});

test("beta.86 #2: deliverProgress de-dups identical consecutive headlines", () => {
  const src = readSrc("src/index.ts");
  assert.ok(/lastProgressHeadline\??:\s*Map<string, string>/.test(src), "runtime carries lastProgressHeadline map");
  assert.ok(
    /dedup\.get\(sessionId\) === headline\) return/.test(src),
    "an identical consecutive headline must be skipped",
  );
  assert.ok(/dedup\.set\(sessionId, headline\)/.test(src), "the last headline must be recorded after posting");
});
