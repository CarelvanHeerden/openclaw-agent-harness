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

test("PatRouter: {requester} resolves the requesting user's github login (multi-user)",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: {},
      default_service_pattern: "github-{requester}",
      user_identities: { U_ALICE: { github: "alice-gh" }, U_BOB: { github: "bob-gh" } },
    });
    const a = r.resolve({ slackUserId: "U_ALICE", gitHubUser: "acme", repoFullName: "acme/widgets" });
    const b = r.resolve({ slackUserId: "U_BOB", gitHubUser: "acme", repoFullName: "acme/widgets" });
    assert.equal(a.credentialService, "github-alice-gh");
    assert.equal(b.credentialService, "github-bob-gh");
  });

test("PatRouter: {requester} falls back to repo owner when user has no identity",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: {},
      default_service_pattern: "github-{requester}",
      user_identities: {},
    });
    const res = r.resolve({ slackUserId: "U_X", gitHubUser: "acme", repoFullName: "acme/widgets" });
    assert.equal(res.credentialService, "github-acme");
  });

test("PatRouter: provider inference + gitlab apiBase/env",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {},
      commit_identity: {},
      default_service_pattern: "{provider}-{requester}",
      user_identities: { U_ALICE: { github: "alice-gh", gitlab: "alice-gl" } },
      default_provider: "github",
      provider_by_owner: { "my-gitlab-group": "gitlab" },
      providers: {
        github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" },
        gitlab: { api_base: "https://gitlab.example.com/api/v4", api_key_env: "GITLAB_TOKEN" },
      },
    });
    const gh = r.resolve({ slackUserId: "U_ALICE", gitHubUser: "acme", repoFullName: "acme/widgets" });
    assert.equal(gh.provider, "github");
    assert.equal(gh.credentialService, "github-alice-gh");
    assert.equal(gh.apiBase, "https://api.github.com");
    assert.equal(gh.apiKeyEnv, "GH_TOKEN");

    const gl = r.resolve({ slackUserId: "U_ALICE", gitHubUser: "my-gitlab-group", repoFullName: "my-gitlab-group/svc" });
    assert.equal(gl.provider, "gitlab");
    assert.equal(gl.credentialService, "gitlab-alice-gl");
    assert.equal(gl.apiBase, "https://gitlab.example.com/api/v4");
    assert.equal(gl.apiKeyEnv, "GITLAB_TOKEN");
  });

test("PatRouter: explicit provider override wins over inference",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {}, commit_identity: {}, default_service_pattern: "{provider}-{owner}",
      default_provider: "github",
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "acme", repoFullName: "acme/x", provider: "gitlab" });
    assert.equal(res.provider, "gitlab");
    assert.equal(res.credentialService, "gitlab-acme");
  });

test("PatRouter: legacy pat_routing.auth.api_key_env still wins for github",
  { skip: PatRouter === null }, () => {
    const r = new PatRouter({
      overrides: {}, commit_identity: {}, default_service_pattern: "github-{owner}",
      auth: { api_key_env: "LEGACY_GH_TOKEN" },
    });
    const res = r.resolve({ slackUserId: "U1", gitHubUser: "acme", repoFullName: "acme/x" });
    assert.equal(res.apiKeyEnv, "LEGACY_GH_TOKEN");
  });
