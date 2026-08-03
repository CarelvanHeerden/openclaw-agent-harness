// beta.98: verifier false-negative on migration-timestamp-prefixed directories.
//
// From the b96/b97 DR/BCP smoke (session 2c035c56): the worker correctly ran
// `npx prisma migrate dev --name continuity_resilience`, which generated and
// committed `prisma/migrations/20260803073723_continuity_resilience/migration.sql`.
// The lead authored the sub-task contract path BEFORE that timestamp existed
// (planning happens minutes earlier), so the contract was
// `prisma/migrations/continuity_resilience/migration.sql` (or the parent dir).
// All four structural rules (exact / route-group / suffix / basename-dir)
// rejected the match because the `20260803073723_` dir-segment prefix broke
// segment-equality, and `strictContract:true` (b84) disables the fuzzy
// fallbacks -- so a correctly generated + committed migration false-failed
// `file_committed`, killing the run at cycle-1 seq-3, $2.63/$30.
//
// Same CLASS as b50 route-group / b76 drift; NEW TRIGGER = dynamic migration
// stamp prefixes (Prisma/Rails 14-digit, Alembic 12-hex, Django sequential).
//
// beta.98 adds `stripMigrationTimestamp` + a `timestamp-prefix` structural
// rule (ranked after route-group, before suffix) registered in both RULE_RANK
// and isStructuralRule -- so `strictContract:true` accepts it.
import test from "node:test";
import assert from "node:assert/strict";

const { pathMatches, pathMatchRule, resolveContractPath, isStructuralRule, stripMigrationTimestamp } =
  await import("../dist/orchestrator/path-match.js");

// ---------------------------------------------------------------------------
// THE exact smoke case (the whole point of beta.98).
// ---------------------------------------------------------------------------
test("beta98: the Prisma migration-timestamp case matches (committed <ts>_ vs stampless contract)", () => {
  const committed = "prisma/migrations/20260803073723_continuity_resilience/migration.sql";
  const contract = "prisma/migrations/continuity_resilience/migration.sql";
  assert.equal(pathMatches(committed, contract), true);
  assert.equal(pathMatchRule(committed, contract), "timestamp-prefix");
});

test("beta98: timestamp-prefix is a STRUCTURAL rule (strictContract must accept it)", () => {
  assert.equal(isStructuralRule("timestamp-prefix"), true);
  const files = ["prisma/migrations/20260803073723_continuity_resilience/migration.sql"];
  const contract = "prisma/migrations/continuity_resilience/migration.sql";
  const m = resolveContractPath(files, contract, { strictContract: true });
  assert.ok(m, "strictContract resolution must return a match");
  assert.equal(m.file, files[0]);
  assert.equal(m.rule, "timestamp-prefix");
});

test("beta98: contract omits the leading `prisma/migrations` prefix (suffix under stamp)", () => {
  const committed = "prisma/migrations/20260803073723_continuity_resilience/migration.sql";
  const contract = "continuity_resilience/migration.sql";
  assert.equal(pathMatchRule(committed, contract), "timestamp-prefix");
});

// ---------------------------------------------------------------------------
// Other migration-tool prefix forms.
// ---------------------------------------------------------------------------
test("beta98: Rails 14-digit timestamp migration matches", () => {
  const committed = "db/migrate/20260803073723_add_continuity_tables.rb";
  const contract = "db/migrate/add_continuity_tables.rb";
  assert.equal(pathMatchRule(committed, contract), "timestamp-prefix");
});

test("beta98: Django sequential migration matches", () => {
  const committed = "app/migrations/0007_continuity_exercise.py";
  const contract = "app/migrations/continuity_exercise.py";
  assert.equal(pathMatchRule(committed, contract), "timestamp-prefix");
});

test("beta98: Alembic 12-hex revision id matches", () => {
  const committed = "alembic/versions/1a2b3c4d5e6f_add_continuity.py";
  const contract = "alembic/versions/add_continuity.py";
  assert.equal(pathMatchRule(committed, contract), "timestamp-prefix");
});

// ---------------------------------------------------------------------------
// NEGATIVES: the rule must NOT introduce fuzzy false-positives.
// ---------------------------------------------------------------------------
test("beta98 (negative): stamped sibling with a DIFFERENT name does NOT match", () => {
  const committed = "prisma/migrations/20260803073723_something_else/migration.sql";
  const contract = "prisma/migrations/continuity_resilience/migration.sql";
  assert.equal(pathMatches(committed, contract), false);
});

test("beta98 (negative): stamped file under a DIFFERENT parent tree does NOT match", () => {
  const committed = "prisma/other/20260803073723_continuity_resilience/migration.sql";
  const contract = "prisma/migrations/continuity_resilience/migration.sql";
  // basename `migration.sql` matches but dir context differs even after strip.
  assert.equal(pathMatchRule(committed, contract), null);
});

test("beta98 (negative): strictContract still rejects a lone same-basename sibling (no fuzzy widening)", () => {
  const files = ["src/app/api/download/route.ts"];
  const contract = "src/app/api/upload/route.ts";
  const m = resolveContractPath(files, contract, { strictContract: true });
  assert.equal(m, null, "must NOT fuzzy-match a sibling route.ts");
});

// ---------------------------------------------------------------------------
// stripMigrationTimestamp unit behaviour (conservative prefix stripping).
// ---------------------------------------------------------------------------
test("beta98: stripMigrationTimestamp strips only genuine stamps", () => {
  assert.equal(
    stripMigrationTimestamp("prisma/migrations/20260803073723_x/migration.sql"),
    "prisma/migrations/x/migration.sql",
  );
  // A meaningful short numeric name (1-2 digits) is NOT eaten.
  assert.equal(stripMigrationTimestamp("reports/12_summary.md"), "reports/12_summary.md");
  // No stamp -> unchanged.
  assert.equal(stripMigrationTimestamp("src/app/page.tsx"), "src/app/page.tsx");
});

test("beta98: exact + route-group still win over timestamp-prefix (rank order preserved)", () => {
  assert.equal(pathMatchRule("a/b/c.ts", "a/b/c.ts"), "exact");
  assert.equal(
    pathMatchRule("src/app/(portal)/x/page.tsx", "src/app/x/page.tsx"),
    "route-group",
  );
});
