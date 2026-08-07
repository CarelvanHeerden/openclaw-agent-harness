/**
 * beta.113: the four defects the local DR/BCP run exposed.
 *
 * Session cffa0ebf, ProjectThanos, the same disaster-recovery brief OpenClaw
 * had struggled with. It built the feature -- eleven commits, 1,818 insertions,
 * schema + migration + eight routes + tests + page + sidebar, typecheck clean
 * in both cycles, down to ONE blocking finding after cycle 2 -- and then died
 * in cycle 3 having produced no PR, 56 minutes and $9.41 in.
 *
 *   1. A worker stalled and took the run with it. Sub-task 3 hit
 *      `phase2_first_token`, the b64 retry fired, and attempt 2 hit
 *      `phase2_first_token` again -- both against the same 30-second window.
 *   2. Both revise cycles re-ran all eight sub-tasks, tripped by two `info`
 *      findings that no worker would ever have been dispatched to close.
 *   3. The lead planned those eight sub-tasks blind: `skippedReason=no_repo_hint`
 *      on a run whose allow-list named exactly one repo.
 *   4. The migration file was reported out-of-scope in both cycles, against a
 *      plan that declared the directory it was created in.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { computeReviseScope } from "../dist/orchestrator/revise-scope.js";
import { declaredCovers, firstTokenWindowForAttempt } from "../dist/orchestrator/loop.js";
import { resolveScoutRepo } from "../dist/orchestrator/fable5-lead.js";
import { parseHarnessConfig } from "../dist/config.js";

// parseHarnessConfig rejects a config with no authorised users and no repos.
const MIN = { slack: { authorised_users: ["U1"] }, repos: { allowed: ["owner/repo"] } };

// ---------------------------------------------------------------------------
// 1. A slow start gets a wider window, not the same one twice.
// ---------------------------------------------------------------------------

test("beta113: each retry widens the first-token window", () => {
  const w = (attempt) => firstTokenWindowForAttempt(attempt, 30, 3, 300);
  assert.equal(w(1), 30, "the first attempt keeps the configured window");
  assert.ok(w(2) > w(1), "a retry against an identical deadline is the same experiment twice");
  assert.ok(w(3) > w(2), "and the second retry must widen again");
  assert.deepEqual([w(1), w(2), w(3)], [30, 90, 270]);
});

test("beta113: the escalation is capped", () => {
  // Unbounded growth would let one stalled sub-task sit for the whole turn
  // budget, which is the failure mode the watchdog exists to prevent.
  assert.equal(firstTokenWindowForAttempt(9, 30, 3, 300), 300);
  assert.equal(firstTokenWindowForAttempt(4, 30, 3, 300), 300, "270 * 3 clamps to the cap");
  // A cap below the base must not shrink the first attempt below what was asked for.
  assert.equal(firstTokenWindowForAttempt(1, 120, 3, 30), 120);
});

test("beta113: a multiplier of 1 restores the old fixed-window behaviour", () => {
  const w = [1, 2, 3].map((a) => firstTokenWindowForAttempt(a, 30, 1, 300));
  assert.deepEqual(w, [30, 30, 30], "operators must be able to switch escalation off");
});

test("beta113: the defaults give a stalled worker three attempts, widening", () => {
  const cfg = parseHarnessConfig(MIN);
  assert.equal(cfg.loop.worker_timeout_max_attempts, 3, "two attempts was one retry");
  assert.equal(cfg.loop.worker_first_token_retry_multiplier, 3);
  assert.equal(cfg.loop.worker_first_token_retry_cap_seconds, 300);
  const base = cfg.loop.sdk_first_token_timeout_seconds ?? 30;
  const windows = [1, 2, 3].map((a) =>
    firstTokenWindowForAttempt(
      a,
      base,
      cfg.loop.worker_first_token_retry_multiplier,
      cfg.loop.worker_first_token_retry_cap_seconds,
    ),
  );
  assert.deepEqual(windows, [30, 90, 270]);
  const total = windows.reduce((a, b) => a + b, 0);
  assert.ok(
    total < cfg.loop.worker_timeout_seconds,
    `all three first-token windows (${total}s) must fit inside the full-turn timeout ` +
      `(${cfg.loop.worker_timeout_seconds}s), or the escalation can never reach its last attempt`,
  );
});

test("beta113: the new knobs are clamped", () => {
  const hi = parseHarnessConfig({
    ...MIN,
    loop: {
      worker_timeout_max_attempts: 99,
      worker_first_token_retry_multiplier: 1000,
      worker_first_token_retry_cap_seconds: 99999,
    },
  });
  assert.equal(hi.loop.worker_timeout_max_attempts, 5);
  assert.equal(hi.loop.worker_first_token_retry_multiplier, 10);
  assert.equal(hi.loop.worker_first_token_retry_cap_seconds, 1800);
  const lo = parseHarnessConfig({
    ...MIN,
    loop: {
      worker_timeout_max_attempts: 0,
      worker_first_token_retry_multiplier: 0,
      worker_first_token_retry_cap_seconds: 1,
    },
  });
  assert.equal(lo.loop.worker_timeout_max_attempts, 1);
  assert.equal(lo.loop.worker_first_token_retry_multiplier, 1);
  assert.equal(lo.loop.worker_first_token_retry_cap_seconds, 10);
});

// ---------------------------------------------------------------------------
// 2. An info finding must not force every sub-task to re-run.
// ---------------------------------------------------------------------------

const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ seq, filesLikelyTouched: [`src/f${seq}.ts`] }));
/** The two file-less findings that tripped the gate in cycle 2 AND cycle 3. */
const DRBCP_INFO = [
  { dimension: "quality", severity: "info", file: null, title: "Test coverage gaps beyond the four required categories" },
  { dimension: "quality", severity: "info", file: null, title: "Remaining coverage gaps beyond the four mandated categories" },
];

test("beta113: two info findings no longer force all eight sub-tasks to re-run", () => {
  // The medium is filed against a file sub-task 8 declares, so scoping has
  // somewhere to land. In the run itself no sub-task declared it -- covered by
  // the empty-selection test below.
  const owned = [...eight.slice(0, 7), { seq: 8, filesLikelyTouched: ["src/lib/help/help-content.ts"] }];
  const r = computeReviseScope(
    owned,
    [{ dimension: "codebase-fit", severity: "medium", file: "src/lib/help/help-content.ts" }, ...DRBCP_INFO],
    2,
  );
  assert.equal(r.scoped, true, "the cycle must scope; an info finding dispatches no worker");
  assert.deepEqual(r.runSeqs, [8], "only the sub-task owning the one actionable finding should re-run");
});

test("beta113: an unfiled finding at or above medium still forces everything", () => {
  // The gate exists for genuine ambiguity. Medium and up is actionable, so an
  // unattributable one really could belong to any sub-task.
  //
  // Each case pairs the unfiled finding with a FILED one that a sub-task owns.
  // Without that pair the finding list has no resolvable file at all, and
  // `fs.length === 0` returns the same verdict by a different route -- so the
  // test would pass even with the severity floor widened to swallow everything.
  const owned = [...eight.slice(0, 7), { seq: 8, filesLikelyTouched: ["src/target.ts"] }];
  const filed = { dimension: "spec", severity: "high", file: "src/target.ts" };
  for (const severity of ["medium", "high", "critical"]) {
    const r = computeReviseScope(owned, [filed, { dimension: "quality", severity, file: null }], 2);
    assert.equal(r.scoped, false, `an unfiled ${severity} must not be scoped away`);
    assert.equal(r.reason, "unscopable_findings");
    assert.equal(r.runSeqs.length, 8, "every sub-task must run; the unfiled finding could belong to any of them");
  }
  // The control: the same filed finding ALONE scopes to one sub-task, so the
  // assertions above are about the unfiled finding and nothing else.
  const control = computeReviseScope(owned, [filed], 2);
  assert.equal(control.scoped, true);
  assert.deepEqual(control.runSeqs, [8]);
});

test("beta113: an unfiled finding with no severity is treated as actionable", () => {
  // Unknown is not a licence to skip work.
  const r = computeReviseScope(eight, [{ dimension: "quality", file: null }], 2);
  assert.equal(r.scoped, false);
  assert.equal(r.reason, "unscopable_findings");
});

test("beta113: low and info are both below the actionable floor", () => {
  const owned = [...eight.slice(0, 7), { seq: 8, filesLikelyTouched: ["src/target.ts"] }];
  for (const severity of ["info", "informational", "low", "nit"]) {
    const r = computeReviseScope(
      owned,
      [{ dimension: "spec", severity: "high", file: "src/target.ts" }, { dimension: "quality", severity, file: null }],
      2,
    );
    assert.equal(r.scoped, true, `an unfiled ${severity} must not disable scoping`);
    assert.deepEqual(r.runSeqs, [8]);
  }
});

test("beta113: scoping never selects zero sub-tasks", () => {
  // The DR/BCP case exactly: the only actionable finding named
  // src/lib/help/help-content.ts, which NO sub-task declared -- the same reason
  // it was also reported out-of-scope. Scoping to nobody would dispatch no
  // worker, change nothing, and burn a review cycle finding that out.
  const r = computeReviseScope(
    eight,
    [{ dimension: "codebase-fit", severity: "medium", file: "src/lib/help/help-content.ts" }, ...DRBCP_INFO],
    2,
  );
  assert.equal(r.scoped, false, "an empty selection must fall back, not proceed");
  assert.equal(r.reason, "no_subtask_owns_the_findings");
  assert.equal(r.runSeqs.length, 8, "falling back means the pre-b113 behaviour, not silence");
});

test("beta113: cycle 1 is still never scoped", () => {
  const r = computeReviseScope(eight, DRBCP_INFO, 1);
  assert.equal(r.scoped, false);
  assert.equal(r.reason, "not_revise_cycle");
});

// ---------------------------------------------------------------------------
// 3. The lead scouts the repo the run is going to clone anyway.
// ---------------------------------------------------------------------------

test("beta113: a sole allowed repo is scouted when the brief carries no hint", () => {
  assert.equal(
    resolveScoutRepo(undefined, ["Stitch-Vercel/ProjectThanos"]),
    "Stitch-Vercel/ProjectThanos",
    "the DR/BCP run planned eight sub-tasks blind against exactly this config",
  );
});

test("beta113: an explicit hint still wins over the allow-list", () => {
  assert.equal(resolveScoutRepo("owner/hinted", ["owner/other"]), "owner/hinted");
});

test("beta113: an ambiguous allow-list is still not scouted", () => {
  // Two candidates means the lead has a real choice; scouting one of them would
  // prime the plan for a codebase the run may not use.
  assert.equal(resolveScoutRepo(undefined, ["a/one", "b/two"]), undefined);
  // A glob names no single repo to clone.
  assert.equal(resolveScoutRepo(undefined, ["Stitch-Vercel/*"]), undefined);
  assert.equal(resolveScoutRepo(undefined, ["*"]), undefined);
  assert.equal(resolveScoutRepo(undefined, []), undefined);
  assert.equal(resolveScoutRepo(undefined, ["not-a-repo"]), undefined, "an entry with no owner/ is not a repo");
});

test("beta113: a glob alongside one concrete repo is still ambiguous", () => {
  assert.equal(resolveScoutRepo(undefined, ["Stitch-Vercel/ProjectThanos", "other/*"]), undefined);
});

// ---------------------------------------------------------------------------
// 4. A declared directory covers the files created beneath it.
// ---------------------------------------------------------------------------

test("beta113: a declared directory covers a generated migration", () => {
  // Nothing could have declared this filename: `prisma migrate dev` stamps the
  // timestamp at generation time, and the spec mandated running it.
  assert.equal(
    declaredCovers("prisma/migrations/20260807102822_continuity_resilience/migration.sql", "prisma/migrations"),
    true,
  );
});

test("beta113: a declared file still covers only itself", () => {
  assert.equal(declaredCovers("src/app/api/x/route.ts", "src/app/api/x/route.ts"), true);
  assert.equal(declaredCovers("src/app/api/other/route.ts", "src/app/api/x/route.ts"), false);
});

test("beta113: a declared directory does not cover the world", () => {
  assert.equal(declaredCovers("src/lib/help/help-content.ts", "prisma/migrations"), false);
  assert.equal(declaredCovers("node_modules/x/y.js", "src"), false);
  assert.equal(
    declaredCovers("prisma/migrationsX/a.sql", "prisma/migrations"),
    false,
    "prefix matching must respect the path separator",
  );
});

test("beta113: trailing slashes and globs read as directories", () => {
  assert.equal(declaredCovers("src/components/ui/sidebar.tsx", "src/components/ui/"), true);
  assert.equal(declaredCovers("src/a/b/c.ts", "src/a/*"), true);
  assert.equal(declaredCovers("src/a/b/c.ts", "src/a/**"), true);
});

test("beta113: an npm cache is still out of scope against a real declaration", () => {
  // b110 aborts a cycle on too many out-of-scope files. Widening the matcher
  // must not blunt that: this is the exact path that took down the b109 revise.
  const declared = ["prisma/migrations", "prisma/schema.prisma", "src/app/api/grc/continuity-exercises"];
  const cache = ".npm-cache-tmp/_cacache/content-v2/sha512/00/00/7d862a2642ce435d";
  assert.equal(declared.some((d) => declaredCovers(cache, d)), false);
});
