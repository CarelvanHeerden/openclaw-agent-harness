/**
 * rc.3 -- the six defects that must survive everything rc.3 added.
 *
 * The rc.3 series exists to stop the harness spending cycles on things it
 * cannot fix: duplicate findings, retroactive revision exclusions, an absent
 * compiler, an ever-widening review surface. Every one of those is a mechanism
 * that makes a finding count for LESS, and every one of them is a way to lose a
 * real defect by accident.
 *
 * StitchGuard PR #1168 contained six genuine defects that the run did find,
 * underneath the noise:
 *
 *   1. `parseInt` accepting a fractional or trailing-junk header-row value.
 *   2. A stale request overwriting a newer filter result.
 *   3. Tenant-scoped credentials described to the user as org-wide.
 *   4. A truthy non-string `private_key` passing validation.
 *   5. Connection testing authorised with `read` where it needs administrative
 *      permission.
 *   6. An OpenAPI request schema rejecting a credential field the route accepts.
 *
 * A live smoke against that PR is the real acceptance test and needs the repo,
 * the model spend and the environment. What can be checked here is the half
 * that rc.3 put at risk: each of these is still diff-addressable, still
 * blocking, still not an environment blocker, still six distinct findings after
 * deduplication, still open after reconciliation, and still routed to somebody
 * who is allowed to fix it. If any of them fell through one of the new sieves,
 * it would fall through silently, which is why this is pinned rather than left
 * to the smoke.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const skip = existsSync(join(root, "dist", "orchestrator", "finding-lifecycle.js"))
  ? false
  : "dist not built";
const skipDist = { skip };

/** The six, phrased the way the adversary phrased them. */
const DEFECTS = [
  {
    dimension: "correctness",
    severity: "high",
    title: "Header row index accepts fractional and trailing-junk values",
    detail:
      "parseInt(searchParams.get('headerRow')) accepts '2.7' as 2 and '3abc' as 3, so a malformed query " +
      "silently parses a different row than the caller asked for.",
    file: "src/app/api/security/sast-sheet/route.ts",
  },
  {
    dimension: "correctness",
    severity: "high",
    title: "A stale request can overwrite a newer filter result",
    detail:
      "The Source Code filter fires a request per keystroke and writes whichever response arrives last into " +
      "state, with no sequence token or AbortController, so a slow earlier request overwrites a newer one.",
    file: "src/app/(dashboard)/security/sast/SourceCodeFilter.tsx",
  },
  {
    dimension: "security",
    severity: "high",
    title: "Tenant-scoped credentials are described to the user as org-wide",
    detail:
      "The help copy and the connect dialog both say the credential applies across the organisation, but it " +
      "is stored against the tenant and is only ever read for that tenant.",
    file: "src/components/integrations/ConnectCredentialDialog.tsx",
  },
  {
    dimension: "security",
    severity: "critical",
    title: "A truthy non-string private_key passes validation",
    detail:
      "The guard is `if (!body.private_key)`, so an array, an object or the number 1 satisfies it and reaches " +
      "the key parser, which then throws deep inside the provider client.",
    file: "src/app/api/integrations/credentials/route.ts",
  },
  {
    dimension: "security",
    severity: "high",
    title: "Connection testing is authorised with read permission",
    detail:
      "testConnection() checks for `integrations:read` before performing an action that mutates provider-side " +
      "state and should require the administrative scope.",
    file: "src/lib/integrations/authorize.ts",
  },
  {
    dimension: "correctness",
    severity: "medium",
    title: "The OpenAPI request schema rejects a credential field the route accepts",
    detail:
      "The generated spec marks additionalProperties false and omits `workspace_id`, which the route reads and " +
      "requires, so a client generated from the spec cannot call it successfully.",
    file: "openapi/integrations.yaml",
  },
];

const CTX = { repoHasTestScript: true, runtimeUnavailable: false };

test("smoke: every genuine defect is still diff-addressable and still blocks", skipDist, async () => {
  const { classifyFinding, isBlockingFinding, blocksMerge } = await import(
    "../dist/orchestrator/finding-classify.js"
  );
  for (const f of DEFECTS) {
    const cls = classifyFinding(f, CTX);
    assert.equal(cls, "diff_addressable", `${f.title} was demoted to ${cls}`);
    assert.equal(isBlockingFinding(f, cls), true, `${f.title} stopped blocking`);
    assert.equal(blocksMerge(f, cls), true, `${f.title} stopped holding the merge`);
  }
});

test("smoke: none of them is mistaken for an environment blocker", skipDist, async () => {
  const { detectVerificationBlocker } = await import("../dist/orchestrator/verification-blocker.js");
  for (const f of DEFECTS) {
    assert.equal(detectVerificationBlocker(f), null, `${f.title} was read as an environment fault`);
  }
});

test("smoke: six defects stay six findings through deduplication", skipDist, async () => {
  const { dedupeFindings, findingFingerprint } = await import("../dist/orchestrator/finding-lifecycle.js");
  const { kept, duplicates } = dedupeFindings(DEFECTS);
  assert.equal(kept.length, 6, "the fingerprint must separate six different defects");
  assert.equal(duplicates.length, 0);
  assert.equal(new Set(kept.map(findingFingerprint)).size, 6);

  // And the thing dedup is FOR still works on top of them: the same six
  // arriving twice, as two review chunks would produce, is still six.
  const twice = dedupeFindings([...DEFECTS, ...DEFECTS]);
  assert.equal(twice.kept.length, 6);
  assert.equal(twice.duplicates.length, 6);
});

test("smoke: a reworded repeat of one of them is the same finding, not a seventh", skipDist, async () => {
  const { dedupeFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const reworded = {
    ...DEFECTS[1],
    title: "A stale request overwrites a newer filter result",
    detail:
      "Source Code filtering has no request sequencing, so an earlier slow response lands after a newer one " +
      "and replaces it.",
  };
  assert.equal(dedupeFindings([...DEFECTS, reworded]).kept.length, 6);
});

test("smoke: they survive the lifecycle open, and the late-discovery policy is not what closes them", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");

  // Cycle 1 is the baseline review: all six are admitted.
  const first = reconcileFindings({ cycle: 1, current: DEFECTS, prior: [], changedThisCycle: [] });
  assert.equal(first.findings.length, 6);
  assert.equal(first.records.every((r) => r.state === "open"), true);

  // Cycle 2 with nothing fixed: still six open, none aged out. The late
  // discovery policy governs NEW findings against unchanged code, and these
  // are neither new nor against unchanged code.
  const second = reconcileFindings({
    cycle: 2,
    current: DEFECTS,
    prior: first.records,
    changedThisCycle: [],
  });
  assert.equal(second.findings.length, 6, "an unfixed defect is not a stale one");
  assert.equal(second.records.filter((r) => r.state === "open").length, 6);
  assert.equal(second.lateDiscoveries.length, 0);
});

test("smoke: a fixed defect resolves, and the other five are untouched by it", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const first = reconcileFindings({ cycle: 1, current: DEFECTS, prior: [], changedThisCycle: [] });
  const fixed = DEFECTS[3];
  const second = reconcileFindings({
    cycle: 2,
    current: DEFECTS.filter((f) => f !== fixed),
    prior: first.records,
    changedThisCycle: [fixed.file],
  });
  const record = second.records.find((r) => r.title === fixed.title);
  assert.equal(record.state, "resolved");
  assert.equal(second.findings.length, 5, "resolving one does not disturb the rest");
});

test("smoke: each defect is routed to somebody allowed to edit its file", skipDist, async () => {
  const { groupUnownedFindingsForRepair, renderRepairIntent } = await import(
    "../dist/orchestrator/revise-mapping.js"
  );
  // None of these files belongs to "Declare SAST workflow routes", which is
  // where PR #1168 sent several of them. Unowned, they become repair groups
  // that carry their own file grants.
  const groups = groupUnownedFindingsForRepair(DEFECTS);
  assert.equal(groups.length, 6, "six unrelated files are six repair tasks");
  for (const f of DEFECTS) {
    const owner = groups.find((g) => g.findings.some((x) => x.title === f.title));
    assert.ok(owner, `${f.title} was routed nowhere`);
    assert.ok(owner.files.includes(f.file), `the repair task for ${f.title} cannot edit ${f.file}`);
    assert.match(renderRepairIntent(owner), new RegExp(f.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("smoke: an environment blocker alongside them takes none of them with it", skipDist, async () => {
  // The rc.3 blocker path runs first in both classification and reconciliation.
  // The failure mode worth pinning is that it takes the whole cycle's findings
  // with it, leaving a run that reports one environment fault and no defects.
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const { classifyFinding } = await import("../dist/orchestrator/finding-classify.js");
  const tsc = {
    dimension: "quality",
    severity: "high",
    title: "The typecheck could not run",
    detail: "sh: tsc: not found",
    file: null,
  };
  const out = reconcileFindings({ cycle: 1, current: [...DEFECTS, tsc], prior: [], changedThisCycle: [] });
  const blocked = out.records.filter((r) => r.state === "environment_blocked");
  assert.equal(blocked.length, 1);
  assert.equal(out.records.filter((r) => r.state === "open").length, 6);
  for (const f of DEFECTS) assert.equal(classifyFinding(f, CTX), "diff_addressable", f.title);
});
