import test from "node:test";
import assert from "node:assert/strict";

let PatRouter;
try {
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
} catch {
  PatRouter = null;
}

test("PatRouter: repo-scoped override wins",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: { U1: { "Stitch-Vercel/ProjectThanos": "github-carel-stitch" } },
      commit_identity: {},
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "carel", repoFullName: "Stitch-Vercel/ProjectThanos" });
    assert.equal(res.credentialService, "github-carel-stitch");
    assert.equal(res.provenance, "override_repo");
  });

test("PatRouter: owner-scoped override picked when repo not listed",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: { U1: { "Stitch-Vercel": "github-carel-stitch" } },
      commit_identity: {},
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "carel", repoFullName: "Stitch-Vercel/OtherRepo" });
    assert.equal(res.credentialService, "github-carel-stitch");
    assert.equal(res.provenance, "override_owner");
  });

test("PatRouter: default pattern lowercase-substitutes user + org",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: {},
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "CarelvanHeerden", repoFullName: "Stitch-Vercel/ProjectThanos" });
    assert.equal(res.credentialService, "github-carelvanheerden-stitch-vercel");
    assert.equal(res.provenance, "default_pattern");
  });

test("PatRouter: commit_identity override wins over noreply default",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: { U1: { name: "Carel", email: "carel@stitch.money" } },
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "CarelvanHeerden", repoFullName: "Stitch-Vercel/ProjectThanos" });
    assert.deepEqual(res.commitIdentity, { name: "Carel", email: "carel@stitch.money" });
  });

test("PatRouter: invalid repo throws",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({ overrides: {}, commit_identity: {}, default_service_pattern: "x" });
    assert.throws(() => r.resolve({ slackUserId: "U1", gitHubUser: "c", repoFullName: "no-slash" }));
  });
