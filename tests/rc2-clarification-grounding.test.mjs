/**
 * rc.2: clarifications may only rest on state the harness verified.
 *
 * The failure this locks down, verbatim from the report: a user identified the
 * repository as "StitchGuard" and said "checkout latest main" while asking for
 * a PR against main. The harness answered with a question about a directory
 * that did not exist, a worktree that had never been created, and uncommitted
 * changes that could not have existed because no session was running -- and it
 * framed "base on latest main" and "PR against main" as a choice, when they are
 * the same ordinary workflow described from both ends.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let crystallisePrompt = null;
let guardClarification = null;
let renderGroundingBlock = null;
let resolveRepoAlias = null;
let renderRepoAmbiguityQuestion = null;
let verifyContinuationWorktree = null;
let resolveScoutRepo = null;
let GitAdapter = null;
try {
  ({ GitAdapter } = await import("../dist/adapters/git-worktree.js"));
  ({ crystallisePrompt } = await import("../dist/crystallise/prompt-refiner.js"));
  ({ guardClarification, renderGroundingBlock } = await import("../dist/crystallise/clarification-guard.js"));
  ({ resolveRepoAlias, renderRepoAmbiguityQuestion } = await import("../dist/crystallise/repo-alias.js"));
  ({ verifyContinuationWorktree } = await import("../dist/orchestrator/loop.js"));
  ({ resolveScoutRepo } = await import("../dist/orchestrator/lead.js"));
} catch {
  /* dist not built; runtime cases skip, source assertions still run */
}
const skip = crystallisePrompt === null ? "dist not built" : false;

/**
 * The exact question the harness produced. Kept verbatim -- paraphrasing a
 * regression fixture is how a regression test stops testing the regression.
 */
const OBSERVED_FAILURE_QUESTION =
  "Should I implement this in `/home/node/.openclaw/workspace/Stitch-Vercel/StitchGuard` " +
  "and update the existing worktree to `origin/main`, preserving any uncommitted changes?";

/** The request that produced it. */
const OBSERVED_FAILURE_REQUEST =
  "In StitchGuard, checkout latest main and add a rate limit to the login endpoint. Open a PR against main.";

const CONFIG = {
  repos: {
    allowed: ["Stitch-Vercel/StitchGuard", "Stitch-Vercel/ProjectThanos"],
    default_base_branch: "main",
  },
};

const noopLogger = { info() {}, warn() {} };

function briefFor(overrides = {}) {
  return {
    title: "Rate limit the login endpoint",
    motivation: "Unbounded login attempts allow credential stuffing against the app.",
    acceptanceCriteria: ["POST /login returns 429 after 5 attempts in 60s"],
    filesLikelyTouched: ["src/routes/login.ts"],
    outOfScope: [],
    riskLevel: "medium",
    ...overrides,
  };
}

/** Collects audit rows the way index.ts wires them. */
function recorder() {
  const events = [];
  return { events, audit: (event, payload) => events.push({ event, payload }) };
}

// ---------------------------------------------------------------------------
// The reported failure, end to end
// ---------------------------------------------------------------------------

test("rc2: the exact observed clarification is never put to the user", { skip }, async () => {
  const { events, audit } = recorder();
  const result = await crystallisePrompt(OBSERVED_FAILURE_REQUEST, {
    config: CONFIG,
    logger: noopLogger,
    audit,
    // The classifier that produced the defect: "clarify", with the invented
    // path and worktree as its suggested question.
    callClassifier: async () => ({
      intent: "clarify",
      reason: "unclear which checkout to use",
      suggestedClarification: OBSERVED_FAILURE_QUESTION,
    }),
    callCrystalliser: async () => briefFor({ repoHint: "StitchGuard" }),
  });

  assert.equal(result.kind, "brief", "a fabricated question must not stop the run; it must be withheld");
  const withheld = events.find((e) => e.event === "crystallise.clarification_withheld");
  assert.ok(withheld, "withholding a question must leave an audit trail of its own");
  assert.deepEqual(
    [...withheld.payload.suppressed].sort(),
    ["invented_filesystem_path", "unverified_worktree_state"],
    "both fabrications must be named, not just the first one found",
  );
});

test("rc2: StitchGuard + latest main + PR against main proceeds with no clarification", { skip }, async () => {
  const result = await crystallisePrompt(OBSERVED_FAILURE_REQUEST, {
    config: CONFIG,
    logger: noopLogger,
    callClassifier: async () => ({ intent: "dev_task", reason: "clearly a code change" }),
    callCrystalliser: async () => briefFor({ repoHint: "StitchGuard" }),
  });
  assert.equal(result.kind, "brief");
  assert.equal(result.brief.repoHint, "Stitch-Vercel/StitchGuard", "the short name resolves uniquely");
});

test("rc2: a brief withheld from clarify is not reported as still needing clarification", { skip }, async () => {
  const result = await crystallisePrompt(OBSERVED_FAILURE_REQUEST, {
    config: CONFIG,
    logger: noopLogger,
    callClassifier: async () => ({
      intent: "clarify",
      reason: "unclear",
      suggestedClarification: OBSERVED_FAILURE_QUESTION,
    }),
    callCrystalliser: async () => briefFor({ repoHint: "StitchGuard" }),
  });
  assert.equal(result.kind, "brief");
  assert.equal(result.classification.intent, "dev_task",
    "a brief that reports intent:clarify would re-trigger the pause downstream");
});

// ---------------------------------------------------------------------------
// Repository alias resolution
// ---------------------------------------------------------------------------

test("rc2: a unique short repository name resolves to owner/repo", { skip }, () => {
  const allowed = ["Stitch-Vercel/StitchGuard", "Stitch-Vercel/ProjectThanos"];
  assert.deepEqual(resolveRepoAlias("StitchGuard", allowed),
    { kind: "resolved", repo: "Stitch-Vercel/StitchGuard", via: "alias" });
  assert.deepEqual(resolveRepoAlias("stitchguard", allowed),
    { kind: "resolved", repo: "Stitch-Vercel/StitchGuard", via: "alias" });
  assert.deepEqual(resolveRepoAlias("stitch-guard", allowed),
    { kind: "resolved", repo: "Stitch-Vercel/StitchGuard", via: "alias" },
    "separator differences are a spelling, not a different repository");
});

test("rc2: an exact basename match is not made ambiguous by a looser one", { skip }, () => {
  // `StitchGuard` matches the first exactly and the second only after folding.
  // Pooling the tiers would turn a decided answer into a question.
  const allowed = ["a/StitchGuard", "b/stitch_guard"];
  assert.deepEqual(resolveRepoAlias("StitchGuard", allowed),
    { kind: "resolved", repo: "a/StitchGuard", via: "alias" });
});

test("rc2: an ambiguous alias asks only which repository", { skip }, async () => {
  const { events, audit } = recorder();
  const result = await crystallisePrompt("add rate limiting in StitchGuard", {
    config: { repos: { allowed: ["one/StitchGuard", "two/StitchGuard"], default_base_branch: "main" } },
    logger: noopLogger,
    audit,
    callClassifier: async () => ({ intent: "dev_task", reason: "code change" }),
    callCrystalliser: async () => briefFor({ repoHint: "StitchGuard" }),
  });

  assert.equal(result.kind, "clarify");
  assert.equal(result.reason, "repository_ambiguous", "the reason must be machine-readable");
  assert.match(result.question, /which repository/i);
  assert.match(result.question, /one\/StitchGuard/);
  assert.match(result.question, /two\/StitchGuard/);
  // The whole point: it offers repositories, not checkout mechanics.
  assert.doesNotMatch(result.question, /worktree|directory|checkout|uncommitted|branch/i,
    "an ambiguous repository is a repository question and nothing else");
  assert.ok(events.some((e) => e.event === "crystallise.clarification_asked"
    && e.payload.reason === "repository_ambiguous"));
});

test("rc2: a glob allow-list cannot conjure a repository from a bare name", { skip }, () => {
  // A glob says an owner is permitted, not which repositories exist under it.
  assert.deepEqual(resolveRepoAlias("StitchGuard", ["Stitch-Vercel/*"]), { kind: "unresolved" });
});

test("rc2: an explicit owner/repo is passed through untouched", { skip }, () => {
  assert.deepEqual(resolveRepoAlias("Stitch-Vercel/StitchGuard", ["Stitch-Vercel/StitchGuard"]),
    { kind: "resolved", repo: "Stitch-Vercel/StitchGuard", via: "explicit" });
  // A disallowed repository must reach the allow-list gate by name, so it can
  // be refused with a reason rather than quietly becoming "no hint".
  assert.deepEqual(resolveRepoAlias("attacker/evil", ["Stitch-Vercel/StitchGuard"]),
    { kind: "resolved", repo: "attacker/evil", via: "explicit" });
});

test("rc2: a path or URL in repoHint is reduced to a repository name", { skip }, () => {
  const allowed = ["Stitch-Vercel/StitchGuard"];
  // The same fabrication reflex that produced the clarification can land here,
  // and a slash-bearing hint used to be forwarded verbatim into the requester
  // preflight -- which would hunt for a PAT for an owner called "workspace".
  for (const hint of [
    "/home/node/.openclaw/workspace/Stitch-Vercel/StitchGuard",
    "/home/node/workspace/StitchGuard",
    "~/src/StitchGuard",
    "https://github.com/Stitch-Vercel/StitchGuard.git",
    "git@github.com:Stitch-Vercel/StitchGuard.git",
    "Stitch-Vercel/StitchGuard.git",
  ]) {
    const r = resolveRepoAlias(hint, allowed);
    assert.equal(r.kind, "resolved", `unresolved: ${hint}`);
    assert.equal(r.repo, "Stitch-Vercel/StitchGuard", `wrong repo for ${hint}`);
  }
});

test("rc2: the scout resolves a bare name instead of skipping", { skip }, () => {
  // Before rc.2 this returned undefined and the lead planned the repo blind.
  assert.equal(resolveScoutRepo("StitchGuard", ["Stitch-Vercel/StitchGuard", "Stitch-Vercel/ProjectThanos"]),
    "Stitch-Vercel/StitchGuard");
  assert.equal(resolveScoutRepo("StitchGuard", ["one/StitchGuard", "two/StitchGuard"]), undefined,
    "two candidates is a real choice; scouting one could prime the plan for the wrong codebase");
  // b113's sole-concrete-entry fallback must survive.
  assert.equal(resolveScoutRepo(undefined, ["Stitch-Vercel/StitchGuard"]), "Stitch-Vercel/StitchGuard");
  assert.equal(resolveScoutRepo(undefined, ["Stitch-Vercel/*"]), undefined);
});

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

const NEW_RUN = { allowedRepos: ["Stitch-Vercel/StitchGuard"], defaultBaseBranch: "main" };

test("rc2: invented absolute paths are withheld", { skip }, () => {
  for (const q of [
    OBSERVED_FAILURE_QUESTION,
    "Should I work in /home/node/.openclaw/workspace/x?",
    "Is the checkout at /Users/carel/projects/app?",
    "Shall I use ~/work/app for this?",
    "Should I use C:\\Users\\dev\\app?",
  ]) {
    const v = guardClarification(q, NEW_RUN, "substantive_ambiguity");
    assert.equal(v.action, "withhold", `should have been withheld: ${q}`);
  }
});

test("rc2: a URL path or repo-relative path is not mistaken for a filesystem claim", { skip }, () => {
  // Over-broad path matching would be its own defect: these are legitimate
  // questions about what to build.
  for (const q of [
    "Should /api/v2/users return 429, or only /api/v2/login?",
    "Do you want the limiter in src/routes/login.ts or in middleware?",
  ]) {
    const v = guardClarification(q, NEW_RUN, "substantive_ambiguity");
    assert.equal(v.action, "ask", `should have been asked: ${q}`);
  }
});

test("rc2: worktree and uncommitted-work claims are withheld on a new run", { skip }, () => {
  for (const q of [
    "Should I update the existing worktree?",
    "Do you want me to keep the uncommitted changes?",
    "There are local changes -- discard them?",
    "The repo is already checked out; reuse it?",
    "Should I stash the work in progress first?",
  ]) {
    const v = guardClarification(q, NEW_RUN, "substantive_ambiguity");
    assert.equal(v.action, "withhold", `should have been withheld: ${q}`);
    assert.ok(v.suppressed.includes("unverified_worktree_state"));
  }
});

test("rc2: a VERIFIED continuation may discuss its own worktree", { skip }, () => {
  // The resume flow exists precisely to ask whether to keep work that provably
  // exists. Blanket-banning the vocabulary would break it.
  const grounding = {
    ...NEW_RUN,
    continuation: {
      sessionId: "s-1",
      repo: "Stitch-Vercel/StitchGuard",
      branch: "harness/feat-abc",
      worktreePath: "/var/harness/worktrees/pending-1-abcd",
    },
  };
  const v = guardClarification(
    "Your branch has uncommitted changes in /var/harness/worktrees/pending-1-abcd. Keep them?",
    grounding,
    "verified_continuation_conflict",
  );
  assert.equal(v.action, "ask");
  assert.equal(v.reason, "verified_continuation_conflict");

  // But a DIFFERENT path is still unverified, even mid-continuation.
  const other = guardClarification(
    "Should I use /home/node/other/place instead?",
    grounding,
    "verified_continuation_conflict",
  );
  assert.equal(other.action, "withhold");
  assert.ok(other.suppressed.includes("invented_filesystem_path"));
});

test("rc2: base-on-main and PR-against-main is not a fork", { skip }, () => {
  for (const q of [
    "You asked to base this on latest main but also to open a PR against main -- which do you want?",
    "Should I start from origin/main, or open the pull request into main?",
  ]) {
    const v = guardClarification(q, NEW_RUN, "substantive_ambiguity");
    assert.equal(v.action, "withhold", `should have been withheld: ${q}`);
    assert.ok(v.suppressed.includes("harness_owned_checkout"));
  }
});

test("rc2: basing on one branch and targeting another IS still askable", { skip }, () => {
  const v = guardClarification(
    "Should I base this on latest main and open the PR into release/1.4?",
    NEW_RUN,
    "substantive_ambiguity",
  );
  assert.equal(v.action, "ask", "different branches is a genuine question, not the false conflict");
});

test("rc2: a substantive product question is untouched", { skip }, () => {
  const v = guardClarification(
    "Should the limiter be per-IP or per-account?",
    NEW_RUN,
    "substantive_ambiguity",
  );
  assert.equal(v.action, "ask");
  assert.equal(v.reason, "substantive_ambiguity");
});

test("rc2: a bimodal crystalliser fork about mechanics is withheld", { skip }, async () => {
  const { events, audit } = recorder();
  const result = await crystallisePrompt(OBSERVED_FAILURE_REQUEST, {
    config: CONFIG,
    logger: noopLogger,
    audit,
    callClassifier: async () => ({ intent: "dev_task", reason: "code change" }),
    callCrystalliser: async () => briefFor({
      repoHint: "StitchGuard",
      interpretations: [
        { reading: "update the existing worktree", whatDiffers: "reuses uncommitted changes" },
        { reading: "fresh clone", whatDiffers: "discards them" },
      ],
      clarificationNeeded: { question: OBSERVED_FAILURE_QUESTION, options: ["reuse", "fresh"] },
    }),
  });
  assert.equal(result.kind, "brief", "a mechanical fork is not a fork");
  assert.ok(events.some((e) => e.event === "crystallise.clarification_withheld"
    && e.payload.role === "crystalliser"));
});

test("rc2: a genuine bimodal fork still pauses the run", { skip }, async () => {
  const result = await crystallisePrompt("sort out rate limiting", {
    config: CONFIG,
    logger: noopLogger,
    callClassifier: async () => ({ intent: "dev_task", reason: "code change" }),
    callCrystalliser: async () => briefFor({
      repoHint: "StitchGuard",
      interpretations: [
        { reading: "build a limiter", whatDiffers: "new middleware" },
        { reading: "document the existing policy", whatDiffers: "docs only" },
      ],
    }),
  });
  assert.equal(result.kind, "clarify", "b80's bimodality pause must survive the grounding guard");
  assert.equal(result.reason, "substantive_ambiguity");
});

// ---------------------------------------------------------------------------
// No generated clarification may carry an unverified path or state claim
// ---------------------------------------------------------------------------

test("rc2: every question the pipeline emits is free of paths and state claims", { skip }, async () => {
  const emitted = [];
  const proposals = [
    OBSERVED_FAILURE_QUESTION,
    "Should I implement this in /home/node/.openclaw/workspace/Stitch-Vercel/StitchGuard?",
    "Which repo?",
    "Should the limiter be per-IP or per-account?",
  ];
  for (const suggestedClarification of proposals) {
    const r = await crystallisePrompt(OBSERVED_FAILURE_REQUEST, {
      config: { repos: { allowed: ["one/StitchGuard", "two/StitchGuard"], default_base_branch: "main" } },
      logger: noopLogger,
      callClassifier: async () => ({ intent: "clarify", reason: "x", suggestedClarification }),
      callCrystalliser: async () => briefFor({ repoHint: "StitchGuard" }),
    });
    if (r.kind === "clarify") emitted.push(r.question);
  }
  assert.ok(emitted.length > 0, "the sweep must actually exercise the clarify path");
  for (const q of emitted) {
    assert.doesNotMatch(q, /\/home\/|\/Users\/|\/var\/|~\/|[A-Za-z]:\\/, `leaked a filesystem path: ${q}`);
    assert.doesNotMatch(q, /existing worktree|uncommitted|local changes/i, `leaked a state claim: ${q}`);
  }
});

// ---------------------------------------------------------------------------
// Continuation worktrees: verified only
// ---------------------------------------------------------------------------

test("rc2: continuation verification accepts a real, matching worktree", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rc2-wt-"));
  try {
    const wt = join(dir, "pending-1-abcd");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/pending-1-abcd\n");
    const plan = { repo: "Stitch-Vercel/StitchGuard", branch: "harness/feat-abc", worktreePath: wt };
    assert.equal(
      verifyContinuationWorktree(plan, { sessionId: "s-1", repo: "Stitch-Vercel/StitchGuard", branch: "harness/feat-abc" }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rc2: a failed session's missing worktree cannot be inherited", { skip }, () => {
  const plan = {
    repo: "Stitch-Vercel/StitchGuard",
    branch: "harness/feat-abc",
    worktreePath: "/home/node/.openclaw/workspace/openclaw-agent-harness/worktrees/pending-1786955556117-3f741f5e",
  };
  const reason = verifyContinuationWorktree(plan, {
    sessionId: "s-new",
    repo: "Stitch-Vercel/StitchGuard",
    branch: "harness/feat-abc",
  });
  assert.match(String(reason), /no longer exists/, "a plan is a recollection, not proof the directory is there");
});

test("rc2: a worktree whose branch is not this session's is refused", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rc2-wt-"));
  try {
    const wt = join(dir, "pending-2-efgh");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: /somewhere\n");
    // Ownership: the directory name carries no session identity, so the branch
    // is the only thing that can say whose worktree this is.
    assert.match(
      String(verifyContinuationWorktree(
        { repo: "Stitch-Vercel/StitchGuard", branch: "harness/other-run", worktreePath: wt },
        { sessionId: "s-1", repo: "Stitch-Vercel/StitchGuard", branch: "harness/feat-abc" },
      )),
      /branch/,
    );
    assert.match(
      String(verifyContinuationWorktree(
        { repo: "Other/Repo", branch: "harness/feat-abc", worktreePath: wt },
        { sessionId: "s-1", repo: "Stitch-Vercel/StitchGuard", branch: "harness/feat-abc" },
      )),
      /Other\/Repo/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rc2: a directory that is no longer a git worktree is refused", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rc2-wt-"));
  try {
    assert.match(
      String(verifyContinuationWorktree(
        { repo: "r/r", branch: "b", worktreePath: dir },
        { sessionId: "s-1", repo: "r/r", branch: "b" },
      )),
      /not a git worktree/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Grounding reaches the models
// ---------------------------------------------------------------------------

test("rc2: the grounding block states the checkout policy and the absence of state", { skip }, () => {
  const block = renderGroundingBlock(NEW_RUN);
  assert.match(block, /Stitch-Vercel\/StitchGuard/, "the allow-list must reach the model that was clarifying without it");
  assert.match(block, /NO active session, NO worktree/i);
  assert.match(block, /origin\/main/);
  assert.match(block, /THE SAME normal workflow/i);
  assert.match(block, /NEVER write an absolute path/i);
});

test("rc2: a verified continuation is described to the model instead", { skip }, () => {
  const block = renderGroundingBlock({
    ...NEW_RUN,
    continuation: { sessionId: "s-1", repo: "r/r", branch: "harness/x", worktreePath: "/tmp/wt" },
  });
  assert.match(block, /continues session s-1/);
  assert.doesNotMatch(block, /NO active session/i);
});

test("rc2: both model prompts carry the grounding block and the mechanics ban", () => {
  const src = readFileSync(resolve(root, "src/adapters/claude-code.ts"), "utf8");
  // The prompts are the first line of defence; the guard is the second. If the
  // block silently stops being assembled, the guard would still hold but the
  // models would go back to generating questions nobody can show.
  assert.match(src, /groundingBlock = params\.grounding \? renderGroundingBlock/,
    "the grounding block must be assembled from the caller's verified facts");
  assert.match(src, /Branch, base branch, worktree and checkout are NEVER clarify triggers/,
    "the classifier must be told branch questions are not its business");
  assert.match(src, /A FORK IS ABOUT WHAT GETS BUILT/,
    "the crystalliser must be told a mechanical difference is not an interpretation");
  assert.doesNotMatch(src, /MISSING the one thing you'd need to act \(which repo\/branch\/file\)/,
    "the old trigger listed branch, which is exactly what produced the defect");
});

test("rc2: the wiring passes grounding and audit into crystallisation", () => {
  const src = readFileSync(resolve(root, "src/index.ts"), "utf8");
  assert.match(src, /grounding: groundingFrom\(config\)/,
    "a grounding block that is never passed is decoration");
  assert.match(src, /audit: \(event, payload\) => state\.audit\(event, payload\)/,
    "withheld clarifications must be durable; they leave no other trace");
});

test("rc2: the pre-session clarify path records a machine-readable reason", () => {
  const src = readFileSync(resolve(root, "src/tools/registration.ts"), "utf8");
  assert.match(src, /tool\.run\.clarification_requested/,
    "harness_run clarifies before a session exists, so nothing else records it");
  assert.match(src, /reason: cResult\.reason/);
});

// ---------------------------------------------------------------------------
// What a new run actually does on disk
//
// Real git against local file remotes. "Bases on the latest origin/main" is a
// git-semantics claim, and the b100 lost-commits defect is the standing proof
// that a source-grep assertion cannot check one.
// ---------------------------------------------------------------------------

const QUIET = { info() {}, warn() {}, error() {} };
const IDENT = { name: "Harness Test", email: "harness@test.local" };
const git = (args, cwd) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const tmpRoots = [];
test.after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** A bare origin with one commit on main, plus the harness bare repo. */
function makeWorld(name) {
  const base = mkdtempSync(join(tmpdir(), `rc2-${name}-`));
  tmpRoots.push(base);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const worktreesRoot = join(base, "wt");

  git(["init", "--bare", "-b", "main", origin]);
  mkdirSync(seed, { recursive: true });
  git(["init", "-b", "main"], seed);
  git(["config", "user.name", IDENT.name], seed);
  git(["config", "user.email", IDENT.email], seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(["add", "-A"], seed);
  git(["commit", "-m", "initial"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "-u", "origin", "main"], seed);

  const bare = join(worktreesRoot, ".repos", "Stitch-Vercel", "StitchGuard.git");
  mkdirSync(join(worktreesRoot, ".repos", "Stitch-Vercel"), { recursive: true });
  git(["clone", "--bare", origin, bare]);

  const adapter = new GitAdapter({ worktreesRoot, logger: QUIET, bootstrapDeps: false });
  return { origin, seed, bare, adapter };
}

/** allocate() repoints the shared bare at github.com, so re-pin every time. */
function alloc(w, sessionId, extra = {}) {
  git(["remote", "set-url", "origin", w.origin], w.bare);
  return w.adapter.allocate({
    repoFullName: "Stitch-Vercel/StitchGuard",
    baseBranch: "main",
    sessionBranch: "harness/rate-limit-login",
    sessionId,
    ghToken: "",
    commitIdentity: IDENT,
    ...extra,
  });
}

test("rc2: a fresh request gets a new worktree based on the LATEST origin/main", { skip }, async () => {
  const w = makeWorld("fresh");
  // Someone else lands on main between the request and the run. "checkout
  // latest main" asks for this commit, and it is what a fresh run does anyway.
  writeFileSync(join(w.seed, "other.md"), "landed after the request\n");
  git(["add", "-A"], w.seed);
  git(["commit", "-m", "docs: unrelated"], w.seed);
  git(["push", "origin", "main"], w.seed);
  const latest = git(["rev-parse", "HEAD"], w.seed);

  const decisions = [];
  const wt = await alloc(w, "pending-1-abcd", { onBranchDecision: (d) => decisions.push(d) });

  assert.equal(git(["rev-parse", "HEAD"], wt), latest, "the branch must be cut from the latest origin/main");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], wt), "harness/rate-limit-login",
    "a namespaced branch of its own, not main");
  assert.ok(decisions.length > 0 && /reset_to_base|base/i.test(JSON.stringify(decisions[0])),
    `a fresh run bases on the default branch: ${JSON.stringify(decisions)}`);
});

test("rc2: a terminal session's worktree is not inherited by a new run", { skip }, async () => {
  const w = makeWorld("stale");
  const first = await alloc(w, "pending-1-aaaa");
  // The failed run's directory is gone, exactly as the reported incident found
  // (`cd: .../pending-1786955556117-3f741f5e: No such file or directory`).
  // Deleted WITHOUT a release, so git's worktree metadata still points at it --
  // the messy state a crashed run leaves, not a tidy teardown.
  rmSync(first, { recursive: true, force: true });

  const second = await alloc(w, "pending-2-bbbb", { sessionBranch: "harness/rate-limit-login-2" });
  assert.notEqual(second, first, "a new run must allocate its own directory");
  assert.ok(existsSync(second));
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], second), "harness/rate-limit-login-2");
});
