/**
 * beta.119 — a finding whose fix no single sub-task can make.
 *
 * Provenance. The b118 OpenClaw smoke (session 4c6b04e9, ProjectThanos PR #986)
 * raised this in cycles 1, 2 AND 3, and fixed it in none:
 *
 *   "Upload route discards the `kind` and `title` form fields the drawer sends"
 *   file: src/app/api/grc/continuity-exercises/[id]/files/route.ts
 *
 * Routing was CORRECT -- that file belongs to sub-task 5, which was targeted
 * and ran in both revise cycles. It reported `no-change` both times, and it was
 * right to: the adversary's own remedy was "either drop the kind/title UI from
 * the drawer, or add the columns to ContinuityExerciseFile". The drawer is
 * sub-task 8's, the Prisma model sub-task 1's, the migration sub-task 2's.
 * Sub-task 5 owned the one file that cannot be changed alone.
 *
 * This is NOT the b107/b116/b118 misrouting class. The finding reached exactly
 * the right owner and the owner was structurally unable to act.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let extractRepoPaths, coFixFiles, findingKey, isSameFinding, detectStuckFindings, describeUnresolvable;
let mapFindingsToSubTasks, buildScopedReviseHint, resolveContractPath;
try {
  ({ extractRepoPaths, coFixFiles, findingKey, isSameFinding, detectStuckFindings, describeUnresolvable } =
    await import("../dist/orchestrator/cross-cutting-findings.js"));
  ({ mapFindingsToSubTasks, buildScopedReviseHint } = await import("../dist/orchestrator/revise-mapping.js"));
  ({ resolveContractPath } = await import("../dist/orchestrator/path-match.js"));
} catch {
  extractRepoPaths = null;
}
const skip = { skip: extractRepoPaths === null };
const match = (owned, candidate) => resolveContractPath(owned, candidate, { strictContract: true });

// The real b118 plan shape, reduced to the sub-tasks that matter.
const UPLOAD_ROUTE = "src/app/api/grc/continuity-exercises/[id]/files/route.ts";
const DRAWER = "src/components/grc/continuity-exercise-drawer.tsx";
const SCHEMA = "prisma/schema.prisma";
const subTasks = () => [
  { seq: 1, filesLikelyTouched: [SCHEMA] },
  { seq: 2, filesLikelyTouched: ["prisma/migrations/20260810120000_continuity_resilience/migration.sql"] },
  { seq: 5, filesLikelyTouched: [UPLOAD_ROUTE] },
  { seq: 8, filesLikelyTouched: [DRAWER, "src/components/grc/continuity-exercise-list.tsx"] },
];

// ---------------------------------------------------------------------------
// 1. Path extraction from prose.
// ---------------------------------------------------------------------------

test("extractRepoPaths pulls repo paths out of a finding's prose", skip, () => {
  const got = extractRepoPaths(
    "The uploader posts `kind`, but src/components/grc/continuity-exercise-drawer.tsx renders a " +
    "dropdown the route ignores. Either remove it or add columns in prisma/schema.prisma.",
  );
  assert.deepEqual(got, [DRAWER, SCHEMA]);
});

test("extractRepoPaths handles Next.js dynamic segments and route groups", skip, () => {
  const got = extractRepoPaths(`see ${UPLOAD_ROUTE} and src/app/(portal)/grc/continuity-exercises/page.tsx`);
  assert.ok(got.includes(UPLOAD_ROUTE));
  assert.ok(got.includes("src/app/(portal)/grc/continuity-exercises/page.tsx"));
});

test("extractRepoPaths ignores a bare basename (too ambiguous to route)", skip, () => {
  // `route.ts` alone matches dozens of files in a Next.js app; claiming an
  // owner off it is exactly the over-match b118 removed elsewhere.
  assert.deepEqual(extractRepoPaths("the handler in route.ts drops the field"), []);
});

test("extractRepoPaths ignores URLs", skip, () => {
  assert.deepEqual(extractRepoPaths("see https://github.com/o/r/blob/main/x.ts for context"), []);
});

// ---------------------------------------------------------------------------
// 2. Co-fix files.
// ---------------------------------------------------------------------------

test("coFixFiles prefers the adversary's declared relatedFiles", skip, () => {
  const f = { file: UPLOAD_ROUTE, title: "discards kind/title", detail: "", relatedFiles: [SCHEMA, DRAWER] };
  assert.deepEqual(coFixFiles(f), [SCHEMA, DRAWER]);
});

test("coFixFiles falls back to prose when relatedFiles is absent", skip, () => {
  const f = { file: UPLOAD_ROUTE, title: "discards kind/title", detail: `the dropdown in ${DRAWER} is dead UI` };
  assert.deepEqual(coFixFiles(f), [DRAWER]);
});

test("coFixFiles never lists the finding's own file", skip, () => {
  const f = { file: UPLOAD_ROUTE, title: "x", detail: `${UPLOAD_ROUTE} drops the field`, relatedFiles: [UPLOAD_ROUTE] };
  assert.deepEqual(coFixFiles(f), []);
});

// ---------------------------------------------------------------------------
// 3. Stuck detection across cycles.
// ---------------------------------------------------------------------------

test("isSameFinding survives the adversary re-wording a repeat", skip, () => {
  // The three REAL titles the b118 run used for one defect across its cycles.
  const c1 = { dimension: "quality", file: UPLOAD_ROUTE, title: "Upload route silently discards `kind` and `title` form fields sent by uploader" };
  const c2 = { dimension: "quality", file: UPLOAD_ROUTE, title: "Upload route STILL discards `kind`/`title` (prior finding not addressed)" };
  const c3 = { dimension: "quality", file: UPLOAD_ROUTE, title: "Upload route STILL discards `kind`/`title` — drawer's kind dropdown is dead UI" };
  assert.ok(isSameFinding(c1, c2));
  assert.ok(isSameFinding(c2, c3));
  assert.ok(isSameFinding(c1, c3));
});

test("isSameFinding separates genuinely different findings on the same file", skip, () => {
  // b118 raised all three of these against the upload route in one cycle.
  const a = { dimension: "quality", file: UPLOAD_ROUTE, title: "Upload route discards kind and title" };
  const b = { dimension: "quality", file: UPLOAD_ROUTE, title: "Blob uploaded with private access is never read back end to end" };
  assert.ok(!isSameFinding(a, b));
});

test("one shared word is a coincidence, not a repeat", skip, () => {
  // A short title clears any ratio on a single hit: {upload} against
  // {upload, route, discards, kind, title} is 1.0 of the shorter set. Both of
  // these are real shapes -- the adversary writes terse titles for small
  // findings -- and calling them the same defect would mark a brand-new
  // finding "stuck" and route it to owners who have never seen it.
  const a = { dimension: "quality", file: UPLOAD_ROUTE, title: "Upload route discards kind and title" };
  const b = { dimension: "quality", file: UPLOAD_ROUTE, title: "Upload" };
  assert.ok(!isSameFinding(a, b));
  assert.ok(!isSameFinding(b, a), "and it is symmetric");
});

test("isSameFinding requires the same file and dimension", skip, () => {
  const a = { dimension: "quality", file: UPLOAD_ROUTE, title: "Upload route discards kind and title" };
  assert.ok(!isSameFinding(a, { ...a, file: DRAWER }));
  assert.ok(!isSameFinding(a, { ...a, dimension: "security" }));
});

test("findingKey is stable for the same finding object", skip, () => {
  const f = { dimension: "quality", file: UPLOAD_ROUTE, title: "Upload route discards kind and title" };
  assert.equal(findingKey(f), findingKey({ ...f }));
});

test("detectStuckFindings finds the b118 finding on its second and third raise", skip, () => {
  const f = (title) => ({ dimension: "quality", severity: "medium", file: UPLOAD_ROUTE, title });
  const c1 = [f("Upload route silently discards `kind` and `title` form fields sent by uploader")];
  const c2 = [f("Upload route STILL discards `kind`/`title` (prior finding not addressed)")];
  const c3 = [f("Upload route STILL discards `kind`/`title` — drawer's kind dropdown is dead UI")];

  assert.equal(detectStuckFindings([], c1).length, 0, "a first raise is not stuck");
  const s2 = detectStuckFindings([c1], c2);
  assert.equal(s2.length, 1);
  assert.equal(s2[0].occurrences, 2);
  const s3 = detectStuckFindings([c1, c2], c3);
  assert.equal(s3.length, 1);
  assert.equal(s3[0].occurrences, 3);
});

test("a finding that appears, is fixed, and returns later is not counted as consecutive", skip, () => {
  const f = { dimension: "quality", severity: "medium", file: UPLOAD_ROUTE, title: "discards kind and title" };
  const other = { dimension: "quality", severity: "low", file: DRAWER, title: "unescaped apostrophe" };
  const s = detectStuckFindings([[f], [other]], [f]);
  assert.equal(s.length, 0, "it was absent last cycle, so the revise cycle did resolve it");
});

// ---------------------------------------------------------------------------
// 4. Co-fix ROUTING: the whole fix reaches every worker it needs.
// ---------------------------------------------------------------------------

test("b118 REGRESSION: the upload finding reaches the drawer and schema owners too", skip, () => {
  const finding = {
    dimension: "quality", severity: "medium", file: UPLOAD_ROUTE,
    title: "Upload route discards `kind`/`title`",
    detail: "The uploader posts them but the handler ignores both.",
    relatedFiles: [SCHEMA, DRAWER],
  };
  const r = mapFindingsToSubTasks(subTasks(), [finding], match, { routeCoFixOwners: true });
  const at = (seq) => r.assignments.find((a) => a.seq === seq);
  const carries = (seq) => at(seq).targeted.length + (at(seq).assisting ?? []).length;

  assert.equal(carries(5), 1, "the file's own owner is still involved");
  assert.equal(carries(1), 1, "the Prisma model owner must be recruited");
  assert.equal(carries(8), 1, "the drawer owner must be recruited");
  assert.equal(carries(2), 0, "an unrelated sub-task is not dragged in");

  // beta.120 (fix 3): recruited is not the same as answerable. b119 handed all
  // three owners an identical "fix this" and the b119 take-2 smoke shows what
  // that produces -- perfect routing for two cycles running, and nobody fixing
  // it. The owner of the finding's own file drives; the rest assist.
  assert.equal(at(5).targeted.length, 1, "the file's own owner is the primary");
  assert.equal(at(1).targeted.length, 0, "a supporting owner is not told to drive");
  assert.equal(at(8).targeted.length, 0, "a supporting owner is not told to drive");
  assert.equal((at(1).assisting ?? []).length, 1);
  assert.equal((at(8).assisting ?? []).length, 1);

  assert.equal(r.coFixRoutings.length, 1);
  assert.deepEqual(r.coFixRoutings[0].seqs.sort(), [1, 8]);
  assert.equal(r.coFixRoutings[0].primarySeq, 5, "exactly one sub-task is answerable, and it owns the file");
});

test("beta.120: a co-fix grant does NOT make the assistant an owner next cycle", skip, () => {
  // The accretion bug. b119 wrote co-fix paths into `filesLikelyTouched`, which
  // is simultaneously the scope gate and the ownership map, on a plan object
  // that outlives the cycle. So cycle N's routing widened the input to cycle
  // N+1's routing: on the b119 take-2 smoke the fan-out went from mean 1.9
  // (max 5) to mean 5.0 (max 9) for the same two-file fix.
  const finding = {
    dimension: "quality", severity: "medium", file: UPLOAD_ROUTE,
    title: "discards kind/title", detail: "", relatedFiles: [DRAWER],
  };
  const withGrant = subTasks().map((s) =>
    // Sub-task 8 owns the drawer; sub-task 2 was GRANTED it by a previous cycle.
    s.seq === 2 ? { ...s, filesLikelyTouched: [...(s.filesLikelyTouched ?? []), DRAWER], coFixGrantedFiles: [DRAWER] } : s,
  );
  const r = mapFindingsToSubTasks(withGrant, [finding], match, { routeCoFixOwners: true });
  assert.ok(
    !r.coFixRoutings[0].seqs.includes(2),
    "a path granted last cycle must not be read as ownership this cycle -- that is what compounds the fan-out",
  );
  assert.deepEqual(r.coFixRoutings[0].seqs.sort(), [8], "only the genuine owner is recruited");
});

test("co-fix routing puts the co-fix path in the recruited sub-task's targeted files", skip, () => {
  const finding = {
    dimension: "quality", severity: "medium", file: UPLOAD_ROUTE,
    title: "discards kind/title", detail: "", relatedFiles: [DRAWER],
  };
  const r = mapFindingsToSubTasks(subTasks(), [finding], match, { routeCoFixOwners: true });
  const a8 = r.assignments.find((a) => a.seq === 8);
  assert.ok(a8.targetedFiles.includes(DRAWER),
    "without this the recruited worker is told to fix something outside its contract");
});

test("co-fix routing is OFF by default (pre-b119 behaviour is byte-identical)", skip, () => {
  const finding = {
    dimension: "quality", severity: "medium", file: UPLOAD_ROUTE,
    title: "discards kind/title", detail: "", relatedFiles: [SCHEMA, DRAWER],
  };
  const r = mapFindingsToSubTasks(subTasks(), [finding], match);
  assert.equal(r.assignments.find((a) => a.seq === 8).targeted.length, 0);
  assert.equal(r.coFixRoutings.length, 0);
});

test("a finding contained in one file recruits nobody", skip, () => {
  const finding = {
    dimension: "quality", severity: "medium", file: UPLOAD_ROUTE,
    title: "unreachable branch", detail: "the else can never run",
  };
  const r = mapFindingsToSubTasks(subTasks(), [finding], match, { routeCoFixOwners: true });
  assert.equal(r.coFixRoutings.length, 0);
  assert.equal(r.assignments.find((a) => a.seq === 5).targeted.length, 1);
});

test("a co-fix path nobody owns recruits nobody (no phantom owner)", skip, () => {
  const finding = {
    dimension: "quality", severity: "medium", file: UPLOAD_ROUTE,
    title: "x", detail: "", relatedFiles: ["src/totally/unowned/thing.ts"],
  };
  const r = mapFindingsToSubTasks(subTasks(), [finding], match, { routeCoFixOwners: true });
  assert.equal(r.coFixRoutings.length, 0);
});

test("meta findings are not co-fix routed", skip, () => {
  const finding = {
    dimension: "runtime", severity: "medium", file: null,
    title: "no runtime verification", detail: `check ${DRAWER} after deploying`,
  };
  const r = mapFindingsToSubTasks(subTasks(), [finding], match, { routeCoFixOwners: true });
  assert.equal(r.coFixRoutings.length, 0);
  assert.equal(r.metaBroadcast.length, 1);
});

// ---------------------------------------------------------------------------
// 5. The worker can declare it is blocked.
// ---------------------------------------------------------------------------

test("the revise hint tells a blocked worker to say so instead of doing nothing", skip, () => {
  const hint = buildScopedReviseHint("revise", "summary", {
    seq: 5, targeted: [{ dimension: "quality", severity: "medium", title: "t", detail: "d", file: UPLOAD_ROUTE }],
    broadcast: [], targetedFiles: [UPLOAD_ROUTE],
  });
  assert.match(hint, /BLOCKED: <finding title>/);
  assert.match(hint, /do NOT silently make no change/);
});

// ---------------------------------------------------------------------------
// 6. The operator-facing report.
// ---------------------------------------------------------------------------

test("describeUnresolvable states the repeat count and the missing files", skip, () => {
  const out = describeUnresolvable([{
    key: "k", title: "Upload route discards kind/title", file: UPLOAD_ROUTE,
    severity: "medium", occurrences: 3, coFixFiles: [SCHEMA, DRAWER],
  }]);
  assert.match(out, /REPEATEDLY UNRESOLVED \(1\)/);
  assert.match(out, /raised in 3 cycles and never resolved/);
  assert.match(out, /The fix also needs: prisma\/schema\.prisma/);
  assert.match(out, /fix spans several sub-tasks/);
});

test("describeUnresolvable is empty when nothing is stuck", skip, () => {
  assert.equal(describeUnresolvable([]), "");
});

// ---------------------------------------------------------------------------
// 7. Wiring.
// ---------------------------------------------------------------------------

test("the adversary is asked for relatedFiles on multi-file fixes", () => {
  const src = S("src/orchestrator/fable5-adversary.ts");
  assert.match(src, /`relatedFiles` \(CRITICAL for multi-file fixes\)/);
  assert.match(src, /relatedFiles\?: string\[\] \| null;/);
});

test("relatedFiles survives the index.ts finding mapper", () => {
  const src = S("src/index.ts");
  const i = src.indexOf("findings: (r.parsed.findings as any[]).map");
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 900), /relatedFiles: Array\.isArray\(f\.relatedFiles\)/);
});

test("the loop detects stuck findings and surfaces the unresolvable ones", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /detectStuckFindings\(/);
  assert.match(src, /"loop\.finding_stuck"/);
  assert.match(src, /"loop\.finding_co_fix_routed"/);
  assert.match(src, /"loop\.finding_unresolvable_across_cycles"/);
  assert.match(src, /describeUnresolvable\(unresolvedAcrossCycles\)/);
});

test("co-fix routing recruits sub-tasks into revise SCOPE, not just the hint", () => {
  // b91 scoping keeps a sub-task only when its files intersect a finding file,
  // so a recruited owner that is not also given the path is skipped moments
  // later -- the exact trap b107 hit with orphan adoption.
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf('"loop.finding_co_fix_routed"');
  assert.ok(i > 0);
  const block = src.slice(i, i + 2000);
  assert.match(block, /st\.filesLikelyTouched\.push\(p\)/);
  // beta.120 (fix 2): the grant is ALSO recorded separately, because the scope
  // gate and the ownership map read the same field and only one of them should
  // be widened by a routing decision.
  // Pin the guarded write, not just the presence of the call: neutering the
  // condition leaves the line in place while recording nothing.
  assert.match(block, /if \(!st\.coFixGrantedFiles\.includes\(p\)\) st\.coFixGrantedFiles\.push\(p\);/);
  // And the grant must be threaded to the router, or the exclusion it powers
  // can never fire.
  assert.match(S("src/orchestrator/loop.ts"), /coFixGrantedFiles: s\.coFixGrantedFiles,/);
});
