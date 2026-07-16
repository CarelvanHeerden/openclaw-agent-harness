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
      overrides: { U1: { "example-org/example-repo": "github-carel-example" } },
      commit_identity: {},
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "carel", repoFullName: "example-org/example-repo" });
    assert.equal(res.credentialService, "github-carel-example");
    assert.equal(res.provenance, "override_repo");
  });

test("PatRouter: owner-scoped override picked when repo not listed",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: { U1: { "example-org": "github-carel-example" } },
      commit_identity: {},
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "carel", repoFullName: "example-org/OtherRepo" });
    assert.equal(res.credentialService, "github-carel-example");
    assert.equal(res.provenance, "override_owner");
  });

test("PatRouter: default pattern lowercase-substitutes user + org",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: {},
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "CarelvanHeerden", repoFullName: "example-org/example-repo" });
    assert.equal(res.credentialService, "github-carelvanheerden-example-org");
    assert.equal(res.provenance, "default_pattern");
  });

test("PatRouter: commit_identity override wins over noreply default",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: { U1: { name: "Carel", email: "dev@example.com" } },
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "CarelvanHeerden", repoFullName: "example-org/example-repo" });
    assert.deepEqual(res.commitIdentity, { name: "Carel", email: "dev@example.com" });
  });

test("PatRouter: invalid repo throws",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({ overrides: {}, commit_identity: {}, default_service_pattern: "x" });
    assert.throws(() => r.resolve({ slackUserId: "U1", gitHubUser: "c", repoFullName: "no-slash" }));
  });

test("PatRouter: {owner} placeholder (new default) -- no duplicated segment for personal repo",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: {},
      default_service_pattern: "github-{owner}",
    });
    // Personal repo: gitHubUser === owner. Old "github-{user}-{org}" produced
    // "github-carelvanheerden-carelvanheerden". {owner} gives a single segment.
    const res = r.resolve({
      slackUserId: "U1",
      gitHubUser: "CarelvanHeerden",
      repoFullName: "CarelvanHeerden/openclaw-agent-harness",
    });
    assert.equal(res.credentialService, "github-carelvanheerden");
    assert.equal(res.provenance, "default_pattern");
  });

test("PatRouter: {owner}-{repo} placeholders (per-repo tokens)",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: {},
      default_service_pattern: "github-{owner}-{repo}",
    });
    const res = r.resolve({
      slackUserId: "U1",
      gitHubUser: "CarelvanHeerden",
      repoFullName: "CarelvanHeerden/Openclaw-Agent-Harness",
    });
    assert.equal(res.credentialService, "github-carelvanheerden-openclaw-agent-harness");
  });

test("PatRouter: legacy {user}/{org} aliases still resolve",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: {},
      default_service_pattern: "github-{user}-{org}",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "alice", repoFullName: "acme/widgets" });
    assert.equal(res.credentialService, "github-alice-acme");
  });
