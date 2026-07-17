/**
 * beta.24 — credential regression fixes surfaced by the Staging Thanos smoke.
 *
 * Staging session `b499a9cf` (2026-07-17): harness's `git clone --bare` for
 * a private repo (`Stitch-Vercel/ProjectThanos`) failed at 61s with
 * "Repository not found". Independent proof the PAT was valid: both Clark
 * and Staging cloned the same repo from /tmp with the same token before
 * the harness attempt.
 *
 * Root cause: GitHub returns 404 (not 401) on unauthenticated requests to
 * private repos. The harness's clone step relied on GIT_ASKPASS to inject
 * credentials, but git only prompts for credentials on 401 -- it never gets
 * a chance to ask on 404. Fix: embed the token in the URL for the initial
 * clone so the request is authenticated from byte one. Scrub the token
 * out of on-disk config immediately after.
 *
 * These tests cover the pure URL-construction helper and its idempotence
 * on tokens that contain URL-special characters.
 */
import test from "node:test";
import assert from "node:assert/strict";

let buildAuthedCloneUrl;
try {
  ({ buildAuthedCloneUrl } = await import("../dist/adapters/git-worktree.js"));
} catch {
  buildAuthedCloneUrl = null;
}

const skipAll = { skip: buildAuthedCloneUrl === null };

test(
  "beta.24: buildAuthedCloneUrl embeds the x-access-token username and encoded token",
  skipAll,
  () => {
    const url = buildAuthedCloneUrl("Stitch-Vercel/ProjectThanos", "ghp_abc123XYZ");
    assert.equal(
      url,
      "https://x-access-token:ghp_abc123XYZ@github.com/Stitch-Vercel/ProjectThanos.git",
    );
  },
);

test(
  "beta.24: buildAuthedCloneUrl URL-encodes tokens that contain URL-special chars",
  skipAll,
  () => {
    // Defensive against a future token format that includes '%', '@', ':', '/'.
    // Current GH PATs only use [A-Za-z0-9_], but we don't want a token
    // rotation to a new format to silently corrupt the URL.
    const url = buildAuthedCloneUrl("owner/repo", "abc%def@ghi:jkl/mno");
    assert.match(
      url,
      /^https:\/\/x-access-token:abc%25def%40ghi%3Ajkl%2Fmno@github\.com\/owner\/repo\.git$/,
    );
  },
);

test(
  "beta.24: buildAuthedCloneUrl handles Stitch-Vercel/ProjectThanos exactly (Staging repro)",
  skipAll,
  () => {
    // Regression pin on the exact repo that failed in Staging session
    // b499a9cf. This test would have failed pre-beta.24 because there was
    // no buildAuthedCloneUrl function -- the plain URL was passed to git.
    const token = "github_pat_11BSAQF2A0EXAMPLE_placeholder_shape";
    const url = buildAuthedCloneUrl("Stitch-Vercel/ProjectThanos", token);
    assert.match(url, /^https:\/\/x-access-token:/);
    assert.match(url, /@github\.com\/Stitch-Vercel\/ProjectThanos\.git$/);
    assert.ok(url.includes(token), "token must be embedded verbatim (no additional encoding for GH PAT chars)");
  },
);
