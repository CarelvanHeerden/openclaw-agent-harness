// beta.75 — three follow-ups from the #876 end-to-end run (session 3858bee6):
//
//   #1  PR review comment on EVERY review, not just at PR creation. On a
//       re-push to an existing PR the review verdict/findings were invisible on
//       the PR (Carel: "the new test file is there but the PR comments didn't
//       update"). New postPrComment() + renderReviewComment(), posted after
//       every pushBranchAndOpenPr. Best-effort (never fails the run).
//
//   #3  Worker scope-guard: the worker modified route.ts despite the brief
//       saying "do NOT touch route.ts". Harden the worker prompt so a negative
//       scope constraint is a HARD boundary (no temporary/reconstruct edits).
//
//   #2 (skill) harness-pr-steward: an out-of-scope/stray change flagged as a
//       BLOCKING finding is AUTO-ACTIONABLE (fire a scoped revise to revert it),
//       not a do_not_merge to sit on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { postPrComment } = await import("../dist/adapters/github.js");

// ---------------------------------------------------------------------------
// #1 — postPrComment (behavioral, stubbed fetch)
// ---------------------------------------------------------------------------

test("beta75 #1: postPrComment POSTs to the issue-comments endpoint and returns ok", async () => {
  const realFetch = globalThis.fetch;
  let seenUrl = "";
  let seenBody = "";
  globalThis.fetch = async (url, opts) => {
    seenUrl = String(url);
    seenBody = String(opts?.body ?? "");
    return { ok: true, status: 201, json: async () => ({ html_url: "https://github.com/o/r/pull/876#issuecomment-1" }) };
  };
  try {
    const r = await postPrComment({ repoFullName: "o/r", prNumber: 876, body: "hello review", ghToken: "t", apiBase: "https://api.github.com" });
    assert.equal(r.ok, true);
    assert.equal(r.status, 201);
    assert.match(seenUrl, /\/repos\/o\/r\/issues\/876\/comments$/, "hits the issue-comments endpoint");
    assert.match(seenBody, /hello review/, "posts the body");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("beta75 #1: postPrComment is best-effort — a non-2xx returns ok:false, never throws", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
  try {
    const r = await postPrComment({ repoFullName: "o/r", prNumber: 1, body: "x", ghToken: "t" });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("beta75 #1: postPrComment swallows a thrown fetch (returns ok:false, no throw)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const r = await postPrComment({ repoFullName: "o/r", prNumber: 1, body: "x", ghToken: "t" });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /network down/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// #1 — wiring source-asserts
// ---------------------------------------------------------------------------

test("beta75 #1: pushBranchAndOpenPr posts a review comment after the PR is resolved", () => {
  const src = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.match(src, /import \{[^}]*postPrComment[^}]*\} from "\.\/adapters\/github\.js"/, "postPrComment imported");
  assert.match(src, /renderReviewComment\(reviewReport/, "builds the comment from the review");
  assert.match(src, /postPrComment\(\{ repoFullName: plan\.repo, prNumber: pr\.number/, "posts to the resolved PR number");
  // best-effort: the post is inside a try that only warns on failure
  const idx = src.indexOf("renderReviewComment(reviewReport");
  const around = src.slice(idx - 200, idx + 400);
  assert.match(around, /try \{/, "wrapped in try (best-effort)");
});

test("beta75 #1: renderReviewComment renders verdict + findings + updated-PR marker", () => {
  const src = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.match(src, /function renderReviewComment\(/, "helper exists");
  const idx = src.indexOf("function renderReviewComment(");
  // To the function's closing brace rather than a byte count: a fixed window
  // silently shrinks the claim every time a comment is added above the thing
  // being asserted, which is how the guidance echo broke this.
  const body = src.slice(idx, src.indexOf("\n}", idx));
  assert.match(body, /verdict/, "renders the verdict");
  assert.match(body, /updatedExisting/, "marks an updated (existing) PR");
  assert.match(body, /Findings/, "renders findings");
});

// ---------------------------------------------------------------------------
// #3 — worker scope-guard prompt
// ---------------------------------------------------------------------------

test("beta75 #3: worker prompt makes a 'do NOT touch <file>' constraint a HARD boundary", () => {
  const src = readFileSync(join(root, "src/orchestrator/sonnet-worker.ts"), "utf8");
  assert.match(src, /SCOPE IS A HARD BOUNDARY/, "explicit scope-discipline rule present");
  assert.match(src, /do NOT touch\/modify\/edit/i, "names the do-not-touch pattern");
  assert.match(src, /reconstruct-then-revert|not to reconstruct|not \"to verify\"/i, "forbids temporary/reconstruct edits of forbidden files");
});

// ---------------------------------------------------------------------------
// #2 — skill: out-of-scope change is auto-actionable
// ---------------------------------------------------------------------------

test("beta75 #2: harness-pr-steward skill treats an out-of-scope/stray change as auto-actionable", () => {
  const skill = readFileSync(join(root, "skills/harness-pr-steward/SKILL.md"), "utf8");
  assert.match(skill, /OUT-OF-SCOPE \/ STRAY CHANGE = ALWAYS AUTO-ACTIONABLE/, "explicit rule present");
  assert.match(skill, /revert that file\/hunk/i, "prescribes reverting the stray change");
  assert.match(skill, /do NOT surface a scope-violation `do_not_merge` to the\s*\n?\s*human/i, "does not sit on do_not_merge for scope violations");
});

test("beta75 version is >= beta.75 (range floor)", () => {
  // Relaxed from an exact match to a floor so later betas (beta.76+) that
  // build on top of beta.75 don't false-fail this suite.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(betaOrdinal(pkg.version) >= 75, `version should be at or past beta.75, got ${pkg.version}`);
});
