/**
 * beta.25 regression tests: hierarchical pat_routing.
 *
 * New shape: provider -> org(owner) -> person -> { token, name, email, slack_user_id }.
 *
 * - Person is matched to the requester by slack_user_id.
 * - Match yields a token pointer (value|env|vault) + commit identity (name/email),
 *   bypassing the legacy vault-service-name path.
 * - If the org IS configured hierarchically but the requester is NOT listed:
 *   hard fail (PatRequesterNotAuthorisedError). No silent fallback.
 * - Legacy flat config still works when no hierarchical entry matches.
 * - Config-load validation: person node must have name, valid email, and
 *   exactly one token pointer.
 */
import test from "node:test";
import assert from "node:assert/strict";

let PatRouter, PatRequesterNotAuthorisedError, parseHarnessConfig, validatePatHierarchy;
try {
  ({ PatRouter, PatRequesterNotAuthorisedError } = await import("../dist/auth/pat-router.js"));
  ({ parseHarnessConfig, validatePatHierarchy } = await import("../dist/config.js"));
} catch {
  PatRouter = null;
}
const skip = { skip: PatRouter === null };

function baseRouting(extra = {}) {
  return {
    overrides: {},
    commit_identity: {},
    default_service_pattern: "github-{owner}",
    default_provider: "github",
    provider_by_owner: {},
    providers: {
      github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" },
      gitlab: { api_base: "https://gitlab.com/api/v4", api_key_env: "GITLAB_TOKEN" },
    },
    ...extra,
  };
}

test("beta.25: hierarchy match resolves person token pointer + identity", skip, () => {
  const router = new PatRouter(
    baseRouting({
      github: {
        "stitch-vercel": {
          Janice: {
            token: { env: "GH_STITCH_JANICE" },
            name: "Janice Doe",
            email: "janice@stitch.example",
            slack_user_id: "U_JANICE",
          },
        },
      },
    }),
  );
  const r = router.resolve({
    slackUserId: "U_JANICE",
    gitHubUser: "stitch-vercel",
    repoFullName: "stitch-vercel/app",
  });
  assert.equal(r.provenance, "hierarchy");
  assert.equal(r.person, "Janice");
  assert.deepEqual(r.tokenPointer, { env: "GH_STITCH_JANICE" });
  assert.equal(r.commitIdentity.name, "Janice Doe");
  assert.equal(r.commitIdentity.email, "janice@stitch.example");
  assert.equal(r.provider, "github");
});

test("beta.25: same person, different org resolves different token", skip, () => {
  const router = new PatRouter(
    baseRouting({
      github: {
        "stitch-vercel": {
          Carel: { token: { env: "GH_STITCH_CAREL" }, name: "Carel", email: "c@stitch.io", slack_user_id: "U_CAREL" },
        },
        CarelvanHeerden: {
          Carel: { token: { value: "ghp_private" }, name: "Carel", email: "c@personal.io", slack_user_id: "U_CAREL" },
        },
      },
    }),
  );
  const stitch = router.resolve({ slackUserId: "U_CAREL", gitHubUser: "stitch-vercel", repoFullName: "stitch-vercel/x" });
  const priv = router.resolve({ slackUserId: "U_CAREL", gitHubUser: "CarelvanHeerden", repoFullName: "CarelvanHeerden/y" });
  assert.deepEqual(stitch.tokenPointer, { env: "GH_STITCH_CAREL" });
  assert.equal(stitch.commitIdentity.email, "c@stitch.io");
  assert.deepEqual(priv.tokenPointer, { value: "ghp_private" });
  assert.equal(priv.commitIdentity.email, "c@personal.io");
});

test("beta.25: unlisted requester under a configured org hard-fails (no silent fallback)", skip, () => {
  const router = new PatRouter(
    baseRouting({
      github: {
        "stitch-vercel": {
          Janice: { token: { env: "GH_J" }, name: "Janice", email: "j@x.io", slack_user_id: "U_JANICE" },
        },
      },
    }),
  );
  assert.throws(
    () => router.resolve({ slackUserId: "U_STRANGER", gitHubUser: "stitch-vercel", repoFullName: "stitch-vercel/app" }),
    (err) => {
      assert.ok(err instanceof PatRequesterNotAuthorisedError);
      assert.match(err.message, /no github token configured for requester 'U_STRANGER'/);
      assert.match(err.message, /No silent fallback/);
      return true;
    },
  );
});

test("beta.25: unconfigured org falls through to legacy flat path", skip, () => {
  const router = new PatRouter(
    baseRouting({
      github: {
        "stitch-vercel": {
          Janice: { token: { env: "GH_J" }, name: "Janice", email: "j@x.io", slack_user_id: "U_JANICE" },
        },
      },
    }),
  );
  // "other-org" has no hierarchy entry -> legacy default_service_pattern.
  const r = router.resolve({ slackUserId: "U_ANYONE", gitHubUser: "other-org", repoFullName: "other-org/repo" });
  assert.equal(r.provenance, "default_pattern");
  assert.equal(r.credentialService, "github-other-org");
  assert.equal(r.tokenPointer, undefined);
});

test("beta.25: gitlab hierarchy resolves with gitlab provider + apiBase", skip, () => {
  const router = new PatRouter(
    baseRouting({
      provider_by_owner: { exipay: "gitlab" },
      gitlab: {
        exipay: {
          Francois: { token: { vault: "gitlab-exipay-francois" }, name: "Francois", email: "f@exipay.io", slack_user_id: "U_F" },
        },
      },
    }),
  );
  const r = router.resolve({ slackUserId: "U_F", gitHubUser: "exipay", repoFullName: "exipay/pay" });
  assert.equal(r.provider, "gitlab");
  assert.equal(r.apiBase, "https://gitlab.com/api/v4");
  assert.deepEqual(r.tokenPointer, { vault: "gitlab-exipay-francois" });
});

// ---- config validation ----

test("beta.25: config load rejects person node missing email", skip, () => {
  assert.throws(
    () =>
      validatePatHierarchy(
        baseRouting({
          github: { org1: { Bob: { token: { env: "T" }, name: "Bob" } } },
        }),
      ),
    /org1\.Bob\.email is required/,
  );
});

test("beta.25: config load rejects invalid email", skip, () => {
  assert.throws(
    () => validatePatHierarchy(baseRouting({ github: { org1: { Bob: { token: { env: "T" }, name: "Bob", email: "not-an-email" } } } })),
    /email is required and must be a valid email/,
  );
});

test("beta.25: config load rejects zero token pointers", skip, () => {
  assert.throws(
    () => validatePatHierarchy(baseRouting({ github: { org1: { Bob: { token: {}, name: "Bob", email: "b@x.io" } } } })),
    /must set exactly one of value\|env\|vault \(none set\)/,
  );
});

test("beta.25: config load rejects multiple token pointers", skip, () => {
  assert.throws(
    () =>
      validatePatHierarchy(
        baseRouting({ github: { org1: { Bob: { token: { env: "T", value: "x" }, name: "Bob", email: "b@x.io" } } } }),
      ),
    /must set exactly one of value\|env\|vault \(2 set\)/,
  );
});

test("beta.25: valid hierarchy passes validation", skip, () => {
  assert.doesNotThrow(() =>
    validatePatHierarchy(
      baseRouting({
        github: { org1: { Bob: { token: { env: "T" }, name: "Bob", email: "b@x.io", slack_user_id: "U1" } } },
      }),
    ),
  );
});

test("beta.25: full parseHarnessConfig accepts hierarchical pat_routing", skip, () => {
  const cfg = parseHarnessConfig({
    slack: { authorised_users: ["U1"] },
    repos: { allowed: ["org1/*"] },
    pat_routing: {
      github: { org1: { Bob: { token: { env: "T" }, name: "Bob", email: "b@x.io", slack_user_id: "U1" } } },
    },
  });
  assert.ok(cfg.pat_routing.github.org1.Bob);
  assert.equal(cfg.pat_routing.github.org1.Bob.email, "b@x.io");
});
