// beta.118 — the b117 DR/BCP run (session d66dbaed, ProjectThanos, PR #977)
// shipped `do_not_merge` on ONE medium finding, and it was b107's own worked
// example for the third release running: never routed in b115, routed in b116,
// and in b117 routed to the WRONG worker while the audit recorded success.
//
// The adversary filed `src/lib/help/help-content.ts`, dimension `fit`, titled
// "New UI surface shipped without required help-content update", with an EMPTY
// detail. No sub-task owned that file, so orphan adoption went looking:
//
//   - `findingMentions` needs the finding's prose to name an owned path. The
//     only text was the title, which names none. Zero for all six.
//   - `sharedPrefixDepth` then returned exactly 1 for every sub-task under
//     `src/`: they agree on the source root and diverge at the next segment.
//   - 1 cleared the `score <= 0` guard, and the lowest-seq tie-break gave the
//     finding to seq 2, "Create continuity-exercises CRUD API routes".
//
// The API worker touched the identical two route files in both cycles and
// ignored a help-content finding about a UI page, which is the only sane thing
// it could have done. The adversary re-raised it as "prior fix not applied".
//
// Two fixes, and the tests below pin both:
//   1. A `nearest_path` claim must share a directory BELOW the source root.
//      Agreeing only on `src/` is a signal every candidate emits, so it names
//      no owner and is refused -- audited as `prefix_too_shallow`, which is a
//      different animal from "nobody was even adjacent".
//   2. The adversary must quote the TRIGGERING diff path in `detail` when it
//      files against a registry file the diff does not touch. That restores a
//      `mentioned_in_finding` winner, and it is sub-task 5 -- the one that
//      built the page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let mapFindingsToSubTasks, adoptOrphanFindings, skip = false;
try {
  ({ mapFindingsToSubTasks, adoptOrphanFindings } = await import("../dist/orchestrator/revise-mapping.js"));
} catch {
  skip = "dist not built";
}

// The real b117 plan, verbatim from `sub_tasks.files_touched` of session
// d66dbaed. Five of the six sit under `src/` and share nothing beyond it.
const B117_SUBTASKS = [
  { seq: 1, filesLikelyTouched: ["prisma/migrations/20260810120000_continuity_resilience/migration.sql", "prisma/schema.prisma"] },
  { seq: 2, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/[id]/route.ts", "src/app/api/grc/continuity-exercises/route.ts"] },
  { seq: 3, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/[id]/files/route.ts"] },
  { seq: 4, filesLikelyTouched: ["src/components/ui/sidebar.tsx"] },
  { seq: 5, filesLikelyTouched: ["src/app/(portal)/grc/continuity-resilience/page.tsx", "src/components/grc/continuity-artefact-upload.tsx"] },
  { seq: 6, filesLikelyTouched: ["src/__tests__/api/grc/continuity-exercises-api.test.ts"] },
];

// The finding exactly as the adversary emitted it: title, file, empty detail.
const B117_FINDING = {
  dimension: "fit",
  severity: "medium",
  title: "New UI surface shipped without required help-content update",
  detail: "",
  file: "src/lib/help/help-content.ts",
};

// Strict structural matcher, as the loop injects it: nobody owns the file.
const MATCH = (owned, cand) => owned.find((o) => o === cand);
const OWNED = (st) => st.filesLikelyTouched;

test("beta118: the b117 finding is NOT handed to the CRUD-API sub-task", { skip }, () => {
  const r = mapFindingsToSubTasks(B117_SUBTASKS, [B117_FINDING], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanAdoptions.length, 0, "sharing only `src/` names no owner");
  const two = r.assignments.find((a) => a.seq === 2);
  assert.ok(!two.targeted.includes(B117_FINDING), "seq 2 builds API routes; a help-content finding is not its work");
  assert.ok(!two.targetedFiles.includes("src/lib/help/help-content.ts"));
});

test("beta118: a source-root-only claim is refused, and says so", { skip }, () => {
  const r = mapFindingsToSubTasks(B117_SUBTASKS, [B117_FINDING], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanRefusals.length, 1);
  const ref = r.orphanRefusals[0];
  assert.equal(ref.reason, "prefix_too_shallow");
  assert.equal(ref.score, 1, "depth 1 == they agree on `src` and nothing else");
  assert.deepEqual(ref.seqs, [2, 3, 4, 5, 6], "every sub-task under src/ was equally (un)related");
  assert.equal(ref.file, "src/lib/help/help-content.ts");
});

test("beta118: a refused orphan is still broadcast -- nothing is dropped", { skip }, () => {
  const r = mapFindingsToSubTasks(B117_SUBTASKS, [B117_FINDING], MATCH, { adoptOrphans: true });
  assert.equal(r.mappingMisses.length, 1, "still a miss for the audit trail");
  for (const a of r.assignments) assert.ok(a.broadcast.includes(B117_FINDING));
});

test("beta118: naming the triggering page routes the finding to the sub-task that built it", { skip }, () => {
  // What the b118 adversary contract requires: quote the diff path that
  // triggered the registry requirement.
  const compliant = {
    ...B117_FINDING,
    detail:
      "src/app/(portal)/grc/continuity-resilience/page.tsx introduces a new UI surface, " +
      "so src/lib/help/help-content.ts needs a matching entry per .cursor/rules/help-section-updates.mdc.",
  };
  const r = mapFindingsToSubTasks(B117_SUBTASKS, [compliant], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanAdoptions.length, 1);
  const ad = r.orphanAdoptions[0];
  assert.equal(ad.seq, 5, "the sub-task that built the page, not the one numbered lowest");
  assert.equal(ad.reason, "mentioned_in_finding");
  const five = r.assignments.find((a) => a.seq === 5);
  assert.ok(five.targeted.includes(compliant), "targeted, so revise scoping cannot skip it");
  assert.ok(five.targetedFiles.includes("src/lib/help/help-content.ts"), "and it may change the file");
  assert.equal(r.orphanRefusals.length, 0);
});

test("beta118: a named path still wins from a shallow directory", { skip }, () => {
  // seq 4 shares only `src` with the finding's file (depth 1, under the
  // threshold) but the prose names its file outright. Explicit beats inferred:
  // the depth floor must not suppress a path the adversary actually cited.
  const named = {
    dimension: "fit", severity: "medium", file: "src/lib/help/help-content.ts",
    title: "sidebar entry added without help content",
    detail: "src/components/ui/sidebar.tsx gained an entry; help-content.ts was not updated.",
  };
  const ads = adoptOrphanFindings(B117_SUBTASKS, [named], OWNED);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].seq, 4);
  assert.equal(ads[0].reason, "mentioned_in_finding");
});

test("beta118: a genuine directory claim is still adopted", { skip }, () => {
  // The b107 behaviour that must survive: `src/lib/help/panel.tsx` shares
  // `src/lib/help` with the finding's file. That is a real claim, not a root.
  const silent = { ...B117_FINDING, title: "help content stale", detail: "needs an entry" };
  const subs = [
    { seq: 1, filesLikelyTouched: ["prisma/schema.prisma"] },
    { seq: 4, filesLikelyTouched: ["src/lib/help/panel.tsx"] },
  ];
  const r = mapFindingsToSubTasks(subs, [silent], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanAdoptions.length, 1);
  assert.equal(r.orphanAdoptions[0].seq, 4);
  assert.equal(r.orphanAdoptions[0].reason, "nearest_path");
  assert.equal(r.orphanAdoptions[0].score, 3);
});

test("beta118: two deep claims still resolve stably to the lowest seq", { skip }, () => {
  // Both own files IN `src/lib/help/`, so both are plausible owners of
  // `help-content.ts`. Refusing here would lose a real signal; b118 narrows the
  // floor, it does not outlaw ties.
  const silent = { ...B117_FINDING, title: "t", detail: "d" };
  const subs = [
    { seq: 3, filesLikelyTouched: ["src/lib/help/a.ts"] },
    { seq: 5, filesLikelyTouched: ["src/lib/help/b.ts"] },
  ];
  for (let i = 0; i < 3; i++) {
    const r = mapFindingsToSubTasks(subs, [silent], MATCH, { adoptOrphans: true });
    assert.equal(r.orphanAdoptions[0].seq, 3);
    assert.equal(r.orphanRefusals.length, 0);
  }
});

test("beta118: no adjacency at all is still a plain miss, not a shallow refusal", { skip }, () => {
  const alien = { dimension: "quality", severity: "low", title: "x", detail: "y", file: "docs/CONTRIBUTING.md" };
  const subs = [{ seq: 1, filesLikelyTouched: ["prisma/schema.prisma"] }];
  const r = mapFindingsToSubTasks(subs, [alien], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanAdoptions.length, 0);
  assert.equal(r.orphanRefusals.length, 0, "depth 0 was never a candidate; only depth 1 is the new refusal");
});

test("beta118: the adversary must quote the triggering path for a registry finding", { skip }, () => {
  const src = readFileSync(join(root, "src/orchestrator/fable5-adversary.ts"), "utf8");
  assert.match(src, /REGISTRY findings/, "the contract is stated");
  assert.match(src, /MUST quote the EXACT repo-relative path of the diff file that TRIGGERED/);
  assert.match(src, /`detail` is NEVER empty for a `medium`\+ finding/, "the empty detail that started this");
});

test("beta118: the drained-slot count is read BEFORE the pool is cleared", { skip }, () => {
  // `drain()` empties the slot map, so reading `createdCount` after it always
  // audited 0 -- and that line is the only record of how much parallelism a run
  // actually bought. b117 created two slots and reported none.
  const js = readFileSync(join(root, "dist/orchestrator/loop.js"), "utf8");
  const i = js.indexOf("parallel_pool_drained");
  assert.ok(i > 0, "the audit still exists");
  const window = js.slice(Math.max(0, i - 400), i);
  const readAt = window.lastIndexOf("createdCount");
  const drainAt = window.lastIndexOf("drain()");
  assert.ok(readAt > 0, "the count is captured near the audit");
  assert.ok(readAt < drainAt, "captured before drain(), not after");
  assert.ok(!/slots:\s*\w+\.createdCount/.test(js), "and not re-read inline at audit time");
});
