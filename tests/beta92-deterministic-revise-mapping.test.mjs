import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(__dirname, "..", p), "utf8");

// Pull the built pure modules (dist). If the build is absent, skip behavioural.
let mapping = null;
let scope = null;
let confab = null;
try {
  mapping = await import("../dist/orchestrator/revise-mapping.js");
} catch { /* build missing */ }
try {
  scope = await import("../dist/orchestrator/revise-scope.js");
} catch { /* build missing */ }
try {
  confab = await import("../dist/orchestrator/worker-confab-detect.js");
} catch { /* build missing */ }
const skip = { skip: mapping === null };
const skipScope = { skip: scope === null };
const skipConfab = { skip: confab === null };

// A strict structural matcher stub mirroring resolveContractPath's suffix rule:
// candidate matches an owned path when they are equal or one is a /-suffix of
// the other (a bare basename never over-matches a dir'd sibling).
const strictMatch = (owned, candidate) => {
  const norm = (p) => p.trim().replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  const c = norm(candidate);
  if (!c.includes("/")) return undefined; // bare basename -> no structural match (strict)
  for (const o of owned) {
    const oo = norm(o);
    if (oo === c || oo.endsWith("/" + c) || c.endsWith("/" + oo)) return oo;
  }
  return undefined;
};

// ---- revise-mapping: diff-addressable mapping ----------------------------

test("beta.92: diff-addressable finding maps to the owning sub-task only", skip, () => {
  const subTasks = [
    { seq: 1, filesLikelyTouched: ["src/app/api/grc/exercises/route.ts"] },
    { seq: 2, filesLikelyTouched: ["src/app/api/grc/exercises/[id]/files/[fileId]/route.ts"] },
  ];
  const findings = [
    { dimension: "quality", severity: "medium", title: "missing ActivityLog", file: "src/app/api/grc/exercises/route.ts" },
  ];
  const res = mapping.mapFindingsToSubTasks(subTasks, findings, strictMatch);
  assert.equal(res.anyTargeted, true);
  const a1 = res.assignments.find((a) => a.seq === 1);
  const a2 = res.assignments.find((a) => a.seq === 2);
  assert.equal(a1.targeted.length, 1);
  assert.equal(a2.targeted.length, 0, "the sibling route.ts sub-task must NOT be targeted");
  assert.deepEqual(a1.targetedFiles, ["src/app/api/grc/exercises/route.ts"]);
});

test("beta.92: meta (fit|runtime) findings broadcast to ALL sub-tasks, never counted as targeted", skip, () => {
  const subTasks = [
    { seq: 1, filesLikelyTouched: ["a/route.ts"] },
    { seq: 2, filesLikelyTouched: ["b/route.ts"] },
  ];
  const findings = [
    { dimension: "runtime", severity: "low", title: "preview deploy reports 17 errors", file: null },
    { dimension: "fit", severity: "medium", title: "add ActivityLog to every state-changing route", file: null },
  ];
  const res = mapping.mapFindingsToSubTasks(subTasks, findings, strictMatch);
  assert.equal(res.anyTargeted, false, "meta findings are not targeted");
  assert.equal(res.metaBroadcast.length, 2);
  for (const a of res.assignments) {
    assert.equal(a.targeted.length, 0);
    assert.equal(a.broadcast.length, 2, "both meta findings reach every sub-task");
  }
});

test("beta.92: MAPPING MISS — filed diff-addressable finding matching no sub-task attaches to ALL (never dropped)", skip, () => {
  const subTasks = [
    { seq: 1, filesLikelyTouched: ["src/app/api/grc/exercises/route.ts"] },
  ];
  const findings = [
    // a filed quality finding whose file no sub-task owns
    { dimension: "quality", severity: "medium", title: "orphan finding", file: "src/lib/help/help-content.ts" },
  ];
  const res = mapping.mapFindingsToSubTasks(subTasks, findings, strictMatch);
  assert.equal(res.mappingMisses.length, 1, "unmatched filed finding is a mapping miss");
  assert.equal(res.anyTargeted, false);
  // attached to every sub-task as broadcast, not lost
  assert.equal(res.assignments[0].broadcast.length, 1);
  assert.equal(res.assignments[0].broadcast[0].title, "orphan finding");
});

test("beta.92: a diff-addressable finding maps to MULTIPLE sub-tasks that both own the file", skip, () => {
  const subTasks = [
    { seq: 1, filesLikelyTouched: ["src/x/route.ts"] },
    { seq: 2, contextPaths: ["src/x/route.ts"] },
  ];
  const findings = [{ dimension: "security", severity: "high", title: "authz gap", file: "src/x/route.ts" }];
  const res = mapping.mapFindingsToSubTasks(subTasks, findings, strictMatch);
  assert.equal(res.anyTargeted, true);
  assert.equal(res.assignments.find((a) => a.seq === 1).targeted.length, 1);
  assert.equal(res.assignments.find((a) => a.seq === 2).targeted.length, 1);
});

test("beta.92: buildScopedReviseHint shows only THIS sub-task's targeted + broadcast, not a raw dump", skip, () => {
  const a = {
    seq: 1,
    targeted: [{ dimension: "quality", severity: "medium", title: "T1", detail: "d1", file: "x.ts" }],
    broadcast: [{ dimension: "fit", severity: "low", title: "META", detail: "cross-cutting" }],
    targetedFiles: ["x.ts"],
  };
  const hint = mapping.buildScopedReviseHint("revise", "summary", a);
  assert.match(hint, /target THIS sub-task's files/);
  assert.match(hint, /T1/);
  assert.match(hint, /Cross-cutting guidance/);
  assert.match(hint, /META/);
});

// ---- revise-scope: meta-exemption from the unscopable gate ----------------

test("beta.92: a single unfiled RUNTIME finding no longer makes the cycle unscopable", skipScope, () => {
  const subTasks = [
    { seq: 1, filesLikelyTouched: ["a/route.ts"] },
    { seq: 2, filesLikelyTouched: ["b/route.ts"] },
  ];
  const findings = [
    { dimension: "quality", severity: "medium", file: "a/route.ts" },
    { dimension: "runtime", severity: "low", file: null }, // unfiled meta -> exempt
  ];
  const res = scope.computeReviseScope(subTasks, findings, 2);
  assert.equal(res.scoped, true, "the unfiled runtime finding must be EXEMPT from the unscopable gate");
  assert.ok(res.skipSeqs.includes(2), "the non-targeted sub-task (b) is skipped");
  assert.ok(res.runSeqs.includes(1));
});

test("beta.92: an unfiled DIFF-ADDRESSABLE finding STILL makes the cycle unscopable (conservative)", skipScope, () => {
  const subTasks = [{ seq: 1, filesLikelyTouched: ["a/route.ts"] }, { seq: 2, filesLikelyTouched: ["b/route.ts"] }];
  const findings = [
    { dimension: "quality", severity: "medium", file: "a/route.ts" },
    { dimension: "security", severity: "high", file: null }, // unfiled diff-addressable -> unscopable
  ];
  const res = scope.computeReviseScope(subTasks, findings, 2);
  assert.equal(res.scoped, false);
  assert.equal(res.reason, "unscopable_findings");
});

// ---- worker-confab-detect --------------------------------------------------

test("beta.92: confab detector flags a 'did not touch' claim about a contract-required file", skipConfab, () => {
  const msg = "I updated the delete route. I did not touch src/app/api/grc/exercises/[id]/files/[fileId]/download/route.ts as it was already correct.";
  const required = [
    "src/app/api/grc/exercises/[id]/files/[fileId]/route.ts",
    "src/app/api/grc/exercises/[id]/files/[fileId]/download/route.ts",
  ];
  const r = confab.detectWorkerConfab(msg, required);
  assert.equal(r.suspected, true);
  assert.ok(r.offenders.some((p) => p.endsWith("download/route.ts")));
});

test("beta.92: confab detector does NOT fire when the worker touched everything", skipConfab, () => {
  const msg = "I added the ActivityLog and implemented both routes as required. Committed as abc123.";
  const required = ["src/x/route.ts"];
  const r = confab.detectWorkerConfab(msg, required);
  assert.equal(r.suspected, false);
});

test("beta.92: confab detector is a no-op with no required paths (empty contract / relaxed-only)", skipConfab, () => {
  const r = confab.detectWorkerConfab("I left everything untouched, all already correct.", []);
  assert.equal(r.suspected, false);
});

// ---- loop / config / manifest wiring source-asserts -----------------------

test("beta.92: loop deletes the LLM revise-spec turn and wires deterministic mapping", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /mapFindingsToSubTasks/);
  assert.match(src, /buildScopedReviseHint/);
  assert.match(src, /reviseSpecApplied = reviseMapping\.anyTargeted/);
  assert.match(src, /deterministic_revise_mapping !== false/);
  // mapping-miss guardrail audit
  assert.match(src, /loop\.finding_mapping_miss/);
  // confab detector wired, log-only
  assert.match(src, /detectWorkerConfab/);
  assert.match(src, /loop\.worker_confab_suspected/);
  assert.match(src, /worker_confab_detect !== false/);
  // the timed LLM turn is GONE
  assert.ok(!/withTimeout\(reviseSpecCall/.test(src), "the timed revise-spec call must be deleted");
});

test("beta.92: config + manifest declare the two new keys with defaults", () => {
  const cfg = S("src/config.ts");
  assert.match(cfg, /deterministic_revise_mapping\?: boolean/);
  assert.match(cfg, /worker_confab_detect\?: boolean/);
  assert.match(cfg, /deterministic_revise_mapping: true/);
  assert.match(cfg, /worker_confab_detect: true/);
  const man = S("openclaw.plugin.json");
  assert.match(man, /"deterministic_revise_mapping"/);
  assert.match(man, /"worker_confab_detect"/);
});

test("beta.92: revise-scope exempts meta dimensions from the unscopable gate (source)", () => {
  const src = S("src/orchestrator/revise-scope.ts");
  assert.match(src, /META_DIMENSIONS/);
  assert.match(src, /!isMetaDimension\(f\)/);
});

test("beta.92: version floor >= beta.92", () => {
  // Relaxed from an exact pin to a FLOOR (beta.73 lesson) so downstream betas
  // don't have to touch this file just to bump the version.
  const verMatch = S("src/version.ts").match(/0\.1\.0-beta\.(\d+)/);
  const pkgMatch = S("package.json").match(/0\.1\.0-beta\.(\d+)/);
  assert.ok(verMatch && Number(verMatch[1]) >= 92, `version.ts >= beta.92, got ${verMatch?.[1]}`);
  assert.ok(pkgMatch && Number(pkgMatch[1]) >= 92, `package.json >= beta.92, got ${pkgMatch?.[1]}`);
});
