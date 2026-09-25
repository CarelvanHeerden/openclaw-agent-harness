import test from "node:test";
import assert from "node:assert/strict";
import { isRepoAllowed } from "../dist/orchestrator/lead.js";
import { resolveRepoAlias } from "../dist/crystallise/repo-alias.js";

test("repository allow-list comparison canonicalizes configured and requested case", () => {
  assert.equal(isRepoAllowed("stitch-vercel/stitchguard", ["Stitch-Vercel/StitchGuard"]), true);
  assert.equal(isRepoAllowed("STITCH-VERCEL/STITCHGUARD", ["stitch-vercel/stitchguard"]), true);
  assert.equal(isRepoAllowed("stitch-vercel/ProjectThanos", ["Stitch-Vercel/*"]), true);
});

test("repository allow-list keeps exact owner/repository boundaries", () => {
  const allowed = ["Stitch-Vercel/StitchGuard", "Trusted-Org/*"];
  for (const denied of [
    "Stitch-Vercel/StitchGuard-fork",
    "Stitch-Vercel-Evil/StitchGuard",
    "Trusted-Org",
    "Trusted-Org/repo/extra",
    "Trusted-Org/../repo",
    "Trusted-Org/%2e%2e",
    "Trusted-Org\\repo",
    "https://github.com/Trusted-Org/repo",
    " Trusted-Org/repo",
    "Trusted-Org/repo ",
    "Trusted‐Org/repo",
  ]) assert.equal(isRepoAllowed(denied, allowed), false, denied);
});

test("malformed configured entries never authorize a repository", () => {
  for (const configured of [
    "Trusted-Org/repo/extra",
    "Trusted-Org/../repo",
    "Trusted-Org/%2a",
    "Trusted-Org/**",
    "https://github.com/Trusted-Org/repo",
    " Trusted-Org/*",
    "Trusted‐Org/*",
  ]) assert.equal(isRepoAllowed("trusted-org/repo", [configured]), false, configured);
});

test("locator resolution uses the same case-insensitive fail-closed allow-list boundary", () => {
  assert.deepEqual(
    resolveRepoAlias("https://github.com/stitch-vercel/stitchguard.git", ["Stitch-Vercel/StitchGuard"]),
    { kind: "resolved", repo: "stitch-vercel/stitchguard", via: "explicit" },
  );
  const malformed = resolveRepoAlias("https://github.com/stitch-vercel/stitchguard/extra", ["Stitch-Vercel/StitchGuard"]);
  assert.equal(malformed.kind, "resolved");
  assert.equal(isRepoAllowed(malformed.repo, ["Stitch-Vercel/StitchGuard"]), false);
});
