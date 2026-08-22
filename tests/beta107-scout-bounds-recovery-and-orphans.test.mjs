// beta.107 — the four defects the b106 DR/BCP smoke (session 06b91509,
// ProjectThanos, PR #932) exposed. b106 was the best run so far: the scout
// killed the fictional-path class outright, zero escalations, zero rescues,
// clean CI. Everything below is a defect that run left behind.
//
//   1. SILENT SCOUT TRUNCATION. `loop.lead_scout` recorded `reportChars: 20049`
//      and the smoke report read it as a report that happened to be that long.
//      It is the exact length `boundScoutReport` produces when it cuts at
//      20000: between 1k and 10k characters of scout output were dropped, from
//      the TAIL, which is where the prompt puts the traps.
//   2. PHANTOM BREAKER COUNTS. Two `recovery.auto_resuming` fired at +83s and
//      +126s against a live, healthy planning turn. b47 skips the re-drive for
//      a live session, but INSIDE autoResume -- after the b81 breaker has
//      already counted the attempt. Four such bursts inside a minute mark a
//      working session `failed` with `recovery_bounce_loop`.
//   3. ORPHAN FINDINGS. `src/lib/help/help-content.ts` was required by an
//      ingested repo rule, flagged by the adversary in both revise cycles,
//      owned by no sub-task, and therefore unclosable however many cycles the
//      run was given. It was still open when the run hit its ceiling.
//   4. THE SCRATCH FILE. Workers write `.git-commit-msg.txt` when the sandbox
//      blocks heredocs, then cannot `rm` it because the sandbox blocks that
//      too. b95 hid it from the verifier; it still reached the PR diff, where
//      it became finding #1 of the final review and could not be removed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let boundScoutReportDetailed, boundScoutReport, SCOUT_REPORT_MAX_CHARS;
let mapFindingsToSubTasks, adoptOrphanFindings, computeReviseScope;
let runLeadPlanner, recoverSessions, __resetRecoveryResumeLedger;
let GitAdapter, isCommitMsgNoise, parseHarnessConfig, PLUGIN_VERSION;
try {
  ({ boundScoutReportDetailed, boundScoutReport, SCOUT_REPORT_MAX_CHARS } = await import("../dist/orchestrator/lead-scout.js"));
  ({ mapFindingsToSubTasks, adoptOrphanFindings } = await import("../dist/orchestrator/revise-mapping.js"));
  ({ computeReviseScope } = await import("../dist/orchestrator/revise-scope.js"));
  ({ runLeadPlanner } = await import("../dist/orchestrator/fable5-lead.js"));
  ({ recoverSessions, __resetRecoveryResumeLedger } = await import("../dist/state/recovery.js"));
  ({ GitAdapter, isCommitMsgNoise } = await import("../dist/adapters/git-worktree.js"));
  ({ parseHarnessConfig } = await import("../dist/config.js"));
  ({ PLUGIN_VERSION } = await import("../dist/version.js"));
} catch {
  boundScoutReportDetailed = undefined;
}
const skip = boundScoutReportDetailed === undefined;

// ---------------------------------------------------------------------------
// 1. Scout report bounding — the b106 truncation, and where it took its bite
// ---------------------------------------------------------------------------

// A report shaped the way the prompt asks for one: locations, then excerpts,
// then the traps. The traps are last, and they are the part b104 dropped.
const TRAPS = "## Traps\nAny new page MUST also update src/lib/help/help-content.ts (see .cursor/rules/help-section-updates.mdc).";
function scoutReport(bodyChars) {
  return `## Locations\nGRC pages live under src/app/(portal)/grc/<slug>/page.tsx.\n\n## Excerpts\n${"x".repeat(bodyChars)}\n\n${TRAPS}`;
}

test("beta107: 20049 was a TRUNCATION, and the trail now says so", { skip }, () => {
  // The exact b106 number, reproduced. Any report between ~21k and ~30k chars
  // produced this identical length under b104's bounding, which is why it could
  // not be read as a genuine report length.
  const b104Style = (t, max) => (t.length <= max ? t : `${t.slice(0, max)}\n\n... (repo report truncated, ${t.length - max} chars omitted)`);
  for (const n of [21234, 25000, 29999]) {
    assert.equal(b104Style("x".repeat(n), 20000).length, 20049, "the b106 signature");
  }
  // b107 reports it as data rather than leaving it to arithmetic.
  const b = boundScoutReportDetailed(scoutReport(30000), 20000);
  assert.equal(b.truncated, true);
  assert.equal(b.originalChars, scoutReport(30000).length);
  assert.ok(b.omittedChars > 0);
});

test("beta107: truncation keeps the TRAPS, not just the head", { skip }, () => {
  const b = boundScoutReportDetailed(scoutReport(40000), 8000);
  assert.ok(b.truncated);
  assert.ok(b.text.includes("GRC pages live under"), "head survives: locations are load-bearing");
  assert.ok(
    b.text.includes("help-content.ts"),
    "the traps section must survive -- b106's one unclosable finding was a repo rule that lives here",
  );
  assert.ok(b.text.length <= 8000 + 200, `stayed within the ceiling; got ${b.text.length}`);
});

test("beta107: head-only truncation would have LOST the traps (the b104 behaviour)", { skip }, () => {
  const full = scoutReport(40000);
  const headOnly = full.slice(0, 8000);
  assert.ok(!headOnly.includes("help-content.ts"), "confirms the b104 failure mode this fix removes");
});

test("beta107: an untruncated report is passed through and reported as such", { skip }, () => {
  const small = scoutReport(100);
  const b = boundScoutReportDetailed(small, 20000);
  assert.equal(b.truncated, false);
  assert.equal(b.omittedChars, 0);
  assert.equal(b.text, small);
  assert.equal(b.originalChars, small.length);
  assert.equal(boundScoutReport(small, 20000), small, "the string wrapper still behaves");
});

test("beta107: the ceiling itself was raised, so ordinary briefs stop hitting it", { skip }, () => {
  assert.equal(SCOUT_REPORT_MAX_CHARS, 32000);
  // b106's real report fitted comfortably under the new ceiling.
  assert.equal(boundScoutReportDetailed(scoutReport(21000), SCOUT_REPORT_MAX_CHARS).truncated, false);
});

// --- the bounding detail must reach the plan, not stop at the module ---

const BRIEF = () => ({
  title: "t", motivation: "m", acceptanceCriteria: ["a"],
  repoHint: "o/r", filesLikelyTouched: [], outOfScope: [],
});

function leadDeps(scoutReportText, over = {}) {
  return {
    config: {
      repos: { allowed: ["o/*"], default_base_branch: "main" },
      loop: { lead_repo_scout_enabled: true, lead_scout_max_chars: 4000 },
      models: { lead: "l" }, budgets: {},
    },
    logger: { info() {}, warn() {} },
    allocateWorktree: async () => "/tmp/wt",
    scoutRepo: async () => ({ report: scoutReportText }),
    callLeadModel: async () => ({
      repo: "o/r", branch: "harness/b", riskLevel: "low", reviewChecklist: ["c"],
      subTasks: [{
        seq: 1, title: "t", intent: "i", filesLikelyTouched: ["a.ts"],
        successCriteria: ["x"], estimatedTokens: 100, contractScope: "local",
        taskMode: "mutate", verify: [{ kind: "commit_made" }],
        workerContext: { rationale: "r", changeSpec: "c" },
      }],
    }),
    estimateCost: () => 0,
    ...over,
  };
}

test("beta107: a truncated report is flagged on the plan's scout outcome", { skip }, async () => {
  const plan = await runLeadPlanner(BRIEF(), leadDeps(scoutReport(30000)));
  assert.equal(plan.scout.ran, true);
  assert.equal(plan.scout.truncated, true, "b106 had no way to say this");
  assert.ok(plan.scout.reportCharsRaw > plan.scout.reportChars, "raw length is preserved for comparison");
});

test("beta107: an untruncated report is NOT flagged", { skip }, async () => {
  const plan = await runLeadPlanner(BRIEF(), leadDeps(scoutReport(50)));
  assert.equal(plan.scout.ran, true);
  assert.ok(!plan.scout.truncated);
  assert.equal(plan.scout.reportCharsRaw, plan.scout.reportChars);
});

test("beta107: loop.lead_scout carries the truncation fields", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  const evt = loop.slice(loop.indexOf('"loop.lead_scout"'), loop.indexOf('"loop.lead_scout"') + 1400);
  assert.match(evt, /truncated: plan\.scout\.truncated === true/);
  assert.match(evt, /reportCharsRaw: plan\.scout\.reportCharsRaw/);
});

// ---------------------------------------------------------------------------
// 2. Recovery — the breaker must not count a resume it never performed
// ---------------------------------------------------------------------------

function recoveryState() {
  const audits = [];
  const sessions = [{ id: "s1", requester: "U1", slack_channel: "C", slack_thread: "T", status: "planning", cycles_ran: 0, last_completed_sub_task: null, updated_at: Date.now() }];
  return {
    audits,
    store: {
      audit: (event, payload, sessionId) => audits.push({ event, payload, sessionId }),
      db: {
        prepare: (sql) => ({
          all: () => (sql.includes("FROM sessions") ? sessions : []),
          get: () => sessions[0],
          run: (...args) => {
            if (sql.includes("SET status = 'failed'")) sessions[0].status = "failed";
            if (sql.includes("SET status = 'interrupted'")) sessions[0].status = "interrupted";
            return args;
          },
        }),
      },
    },
    sessions,
  };
}

const RECOVERY_OPTS = (over) => ({
  staleAfterSeconds: 3600, // fresh, so it takes the auto-resume branch
  logger: { info() {}, warn() {} },
  agentOrchestrated: true,
  maxResumes: 3,
  resumeWindowSeconds: 60,
  ...over,
});

test("beta107: a session with a live runner is skipped, and never counted", { skip }, async () => {
  __resetRecoveryResumeLedger();
  const { store, audits, sessions } = recoveryState();
  let resumed = 0;
  // Five sweeps in one window -- far past the 3-resume breaker -- against a
  // session that is alive and working. This is the b106 shape, amplified.
  for (let i = 0; i < 5; i++) {
    await recoverSessions(store, RECOVERY_OPTS({
      isLiveRunner: () => true,
      autoResume: async () => { resumed += 1; },
    }));
  }
  assert.equal(resumed, 0, "a live session is never re-driven");
  assert.equal(audits.filter((a) => a.event === "recovery.auto_resuming").length, 0);
  assert.equal(audits.filter((a) => a.event === "recovery.skipped_live_runner").length, 5);
  assert.equal(
    audits.filter((a) => a.event === "recovery.circuit_breaker_tripped").length, 0,
    "THE b107 FIX: a healthy run must not be hard-stopped by sweeps that correctly ignored it",
  );
  assert.equal(sessions[0].status, "planning", "still planning, not failed");
});

test("beta107: WITHOUT the guard the same five sweeps hard-stop the healthy session", { skip }, async () => {
  __resetRecoveryResumeLedger();
  const { store, audits, sessions } = recoveryState();
  // isLiveRunner omitted == pre-b107 behaviour: the breaker counts every sweep.
  for (let i = 0; i < 5; i++) {
    await recoverSessions(store, RECOVERY_OPTS({ autoResume: async () => {} }));
  }
  assert.ok(
    audits.some((a) => a.event === "recovery.circuit_breaker_tripped"),
    "reproduces the defect: b106 was two sweeps into this",
  );
  assert.equal(sessions[0].status, "failed");
});

test("beta107: a genuinely dead session still recovers and still trips the breaker", { skip }, async () => {
  __resetRecoveryResumeLedger();
  const { store, audits } = recoveryState();
  let resumed = 0;
  for (let i = 0; i < 5; i++) {
    await recoverSessions(store, RECOVERY_OPTS({
      isLiveRunner: () => false,
      autoResume: async () => { resumed += 1; },
    }));
  }
  assert.ok(resumed > 0, "recovery must still do its job");
  assert.ok(
    audits.some((a) => a.event === "recovery.circuit_breaker_tripped"),
    "the b81 breaker must still protect against a real bounce loop",
  );
});

// ---------------------------------------------------------------------------
// 3. Orphan findings — b106's help-content.ts, which nobody could fix
// ---------------------------------------------------------------------------

// The real b106 plan shape (abbreviated) and the real finding.
const B106_SUBTASKS = [
  { seq: 1, filesLikelyTouched: ["prisma/schema.prisma"] },
  { seq: 7, filesLikelyTouched: ["src/components/grc/poi-attachment-upload.tsx"] },
  { seq: 9, filesLikelyTouched: ["src/app/(portal)/grc/continuity-exercises/page.tsx"] },
];
const HELP_FINDING = {
  dimension: "spec", severity: "medium",
  title: "New page + dialog added without the mandatory help-content.ts update",
  detail: "src/app/(portal)/grc/continuity-exercises/page.tsx introduces a page but src/lib/help/help-content.ts was not updated, per .cursor/rules/help-section-updates.mdc.",
  file: "src/lib/help/help-content.ts",
};
// Strict structural matcher, as the loop injects it: no sub-task owns the file.
const MATCH = (owned, cand) => owned.find((o) => o === cand);

test("beta107: the b106 orphan finding is adopted by the sub-task its own prose names", { skip }, () => {
  const r = mapFindingsToSubTasks(B106_SUBTASKS, [HELP_FINDING], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanAdoptions.length, 1);
  const ad = r.orphanAdoptions[0];
  assert.equal(ad.seq, 9, "the PAGE sub-task, which the finding names -- not seq 1 on a bare src/ prefix tie");
  assert.equal(ad.reason, "mentioned_in_finding");
  const nine = r.assignments.find((a) => a.seq === 9);
  assert.ok(nine.targeted.includes(HELP_FINDING), "targeted, not merely broadcast");
  assert.ok(nine.targetedFiles.includes("src/lib/help/help-content.ts"), "and the file is in scope to change");
  assert.equal(r.anyTargeted, true);
});

test("beta107: adoption is OFF by default, so b92 behaviour is byte-identical", { skip }, () => {
  const r = mapFindingsToSubTasks(B106_SUBTASKS, [HELP_FINDING], MATCH);
  assert.equal(r.orphanAdoptions.length, 0);
  assert.equal(r.mappingMisses.length, 1);
  for (const a of r.assignments) assert.equal(a.targeted.length, 0);
});

test("beta107: an adopted finding is STILL broadcast -- nothing is ever dropped", { skip }, () => {
  const r = mapFindingsToSubTasks(B106_SUBTASKS, [HELP_FINDING], MATCH, { adoptOrphans: true });
  assert.equal(r.mappingMisses.length, 1, "still surfaced as a miss for the audit trail");
  for (const a of r.assignments) {
    assert.ok(a.broadcast.includes(HELP_FINDING), "every sub-task still sees it as context");
  }
});

test("beta107: adoption falls back to the nearest path when nothing is named", { skip }, () => {
  const silent = { ...HELP_FINDING, title: "help content stale", detail: "needs an entry" };
  const subs = [
    { seq: 1, filesLikelyTouched: ["prisma/schema.prisma"] },
    { seq: 4, filesLikelyTouched: ["src/lib/help/panel.tsx"] },
  ];
  const r = mapFindingsToSubTasks(subs, [silent], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanAdoptions[0].seq, 4, "src/lib/help beats prisma/ on shared directory depth");
  assert.equal(r.orphanAdoptions[0].reason, "nearest_path");
});

test("beta107: adoption REFUSES when no sub-task has any claim", { skip }, () => {
  const alien = { dimension: "quality", severity: "low", title: "x", detail: "y", file: "docs/CONTRIBUTING.md" };
  const subs = [{ seq: 1, filesLikelyTouched: ["prisma/schema.prisma"] }];
  const r = mapFindingsToSubTasks(subs, [alien], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanAdoptions.length, 0, "an arbitrary owner is worse than an honest miss");
  assert.equal(r.mappingMisses.length, 1);
});

test("beta107: a file-less finding is never adopted", { skip }, () => {
  const fileless = { dimension: "quality", severity: "low", title: "vague", detail: "d" };
  const r = mapFindingsToSubTasks(B106_SUBTASKS, [fileless], MATCH, { adoptOrphans: true });
  assert.equal(r.orphanAdoptions.length, 0);
});

test("beta107: adoption is stable -- equal claims resolve to the lowest seq", { skip }, () => {
  const silent = { dimension: "spec", severity: "low", title: "t", detail: "d", file: "src/lib/help/help-content.ts" };
  const subs = [
    { seq: 3, filesLikelyTouched: ["src/lib/help/a.ts"] },
    { seq: 5, filesLikelyTouched: ["src/lib/help/b.ts"] },
  ];
  for (let i = 0; i < 3; i++) {
    const r = mapFindingsToSubTasks(subs, [silent], MATCH, { adoptOrphans: true });
    assert.equal(r.orphanAdoptions[0].seq, 3, "same finding maps to the same worker across cycles");
  }
});

test("beta107: adoptOrphanFindings prefers a named path over a deeper shared prefix", { skip }, () => {
  // seq 2 is DEEPER in the tree; seq 9 is the one the finding actually names.
  const subs = [
    { seq: 2, filesLikelyTouched: ["src/lib/help/other.ts"] },
    { seq: 9, filesLikelyTouched: ["src/app/(portal)/grc/continuity-exercises/page.tsx"] },
  ];
  const ads = adoptOrphanFindings(subs, [HELP_FINDING], (st) => st.filesLikelyTouched);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].seq, 9);
  assert.equal(ads[0].reason, "mentioned_in_finding");
});

test("beta107: the adopting sub-task survives b91 revise scoping", { skip }, () => {
  // THE PAYOFF. Without the orphan file in scope, seq 9 intersects no finding
  // and gets skipped -- so the worker asked to fix the finding never runs.
  const plan = [
    { seq: 1, filesLikelyTouched: ["prisma/schema.prisma"], dependsOn: [] },
    { seq: 9, filesLikelyTouched: ["src/app/(portal)/grc/continuity-exercises/page.tsx"], dependsOn: [] },
  ];
  const only = [HELP_FINDING];
  const before = computeReviseScope(plan, only, 2);
  // b106's shape: nobody declares the orphan file, so seq 9 intersects no
  // finding. Pre-b113 that skipped seq 9 (and everyone else) and the fix never
  // got made. b113 refuses to scope a cycle down to nobody, so the work now
  // happens -- but only by running every sub-task, which is what adoption
  // exists to avoid.
  assert.equal(before.scoped, false, "b113: an empty selection falls back rather than skipping everyone");
  assert.equal(before.reason, "no_subtask_owns_the_findings");
  assert.ok(before.runSeqs.includes(1), "the fallback is indiscriminate: unrelated seq 1 runs too");

  const adopted = plan.map((s) => (s.seq === 9 ? { ...s, filesLikelyTouched: [...s.filesLikelyTouched, HELP_FINDING.file] } : s));
  const after = computeReviseScope(adopted, only, 2);
  assert.ok(!after.skipSeqs.includes(9), "with the adopted file in scope, seq 9 runs");
  assert.ok(after.runSeqs.includes(9));
});

test("beta107: the loop adopts, audits, and widens the adopter's scope", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /adoptOrphans: this\.deps\.config\.loop\.revise_adopt_orphan_findings !== false/);
  assert.match(loop, /"loop\.orphan_finding_adopted"/);
  assert.match(loop, /adoptedBySeq: adopted\?\.seq \?\? null/);
  assert.match(loop, /st\.filesLikelyTouched\.push\(ad\.file\)/);
});

// ---------------------------------------------------------------------------
// 4. The commit-message scratch file — against real git
// ---------------------------------------------------------------------------

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const IDENT = { name: "H", email: "h@e.com" };
function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", cwd, ...args], {
    encoding: "utf8", env: gitEnv,
  });
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "b107-git-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "user.email", "t@e.com");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const adapter = () =>
  new GitAdapter({ worktreesRoot: mkdtempSync(join(tmpdir(), "b107-wt-")), logger: { info() {}, warn() {}, error() {} } });

test("beta107: the scratch file the worker cannot delete never reaches a commit", { skip }, async () => {
  const dir = repo();
  try {
    // Exactly what a sandboxed worker leaves behind: real work, plus the
    // scratch file it used to pass the commit message and could not rm.
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/feature.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, ".git-commit-msg.txt"), "feat: add the thing\n");

    const sha = await adapter().commit(dir, "feat: add the thing", IDENT);
    assert.ok(sha, "the real work still commits");

    const committed = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").split("\n").map((l) => l.trim()).filter(Boolean);
    assert.ok(committed.includes("src/feature.ts"), "the real change is present");
    assert.ok(!committed.some(isCommitMsgNoise), `scratch file reached the commit: ${committed.join(",")}`);
    assert.ok(!existsSync(join(dir, ".git-commit-msg.txt")), "and it is gone from the worktree");
    assert.equal(git(dir, "status", "--porcelain").trim(), "", "no residue left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("beta107: a scratch file the WORKER already committed is removed from the tip", { skip }, async () => {
  const dir = repo();
  try {
    // The other b106 path: the worker ran its own `git add -A && git commit`,
    // so the file is already in history before the harness commits.
    writeFileSync(join(dir, ".git-commit-msg.txt"), "wip\n");
    writeFileSync(join(dir, "src.ts"), "1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "worker self-commit");
    const base = git(dir, "rev-parse", "HEAD~1").trim();
    assert.ok(git(dir, "ls-files").includes(".git-commit-msg.txt"), "precondition: it is tracked");

    writeFileSync(join(dir, "src.ts"), "2\n");
    await adapter().commit(dir, "harness follow-up", IDENT);

    assert.ok(!git(dir, "ls-files").includes(".git-commit-msg.txt"), "absent from the branch tip");
    const prDiff = git(dir, "diff", "--name-only", base, "HEAD").split("\n").map((l) => l.trim()).filter(Boolean);
    assert.ok(!prDiff.some(isCommitMsgNoise), `the PR diff the adversary reviews is clean: ${prDiff.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("beta107: an ordinary commit is untouched by the sweep", { skip }, async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "a.ts"), "1\n");
    const sha = await adapter().commit(dir, "m", IDENT);
    assert.ok(sha);
    const files = git(dir, "show", "--name-only", "--pretty=format:", "HEAD").split("\n").map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(files, ["a.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("beta107: a clean worktree with nothing but a scratch file still reports null", { skip }, async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".git-commit-msg.txt"), "only noise\n");
    const sha = await adapter().commit(dir, "m", IDENT);
    assert.equal(sha, null, "sweeping the only change leaves genuinely nothing to commit");
    assert.ok(!existsSync(join(dir, ".git-commit-msg.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Config + version
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["example-org/*"], default_base_branch: "main" },
};

test("beta107: the new defaults are on and documented", { skip }, () => {
  const cfg = parseHarnessConfig(MINIMAL_CONFIG);
  assert.equal(cfg.loop.revise_adopt_orphan_findings, true);
  assert.equal(cfg.loop.lead_scout_max_chars, 32000);
});

test("beta107: an operator can turn orphan adoption off", { skip }, () => {
  const cfg = parseHarnessConfig({ ...MINIMAL_CONFIG, loop: { revise_adopt_orphan_findings: false } });
  assert.equal(cfg.loop.revise_adopt_orphan_findings, false);
});

test("beta107: the new keys are declared in both schemas", () => {
  for (const [f, pick] of [["src/config.schema.json", (d) => d], ["openclaw.plugin.json", (d) => d.configSchema]]) {
    const loop = pick(JSON.parse(S(f))).properties.loop.properties;
    assert.equal(loop.revise_adopt_orphan_findings.default, true, f);
    assert.equal(loop.lead_scout_max_chars.default, 32000, f);
  }
});

test("beta107: pluginVersion and package.json agree at >= beta.107", { skip }, () => {
  const pkg = JSON.parse(S("package.json"));
  assert.equal(PLUGIN_VERSION.pluginVersion, pkg.version);
  const n = betaOrdinal(pkg.version);
  assert.ok(n >= 107, `expected >= beta.107, got ${pkg.version}`);
});
