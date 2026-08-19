// Where an onboarded route sits relative to the config tree.
//
// WHY THIS EXISTS: `pat_routing` is read-only at runtime, so onboarding had no
// way to record a route -- it could store a secret and nothing that pointed at
// it. The overlay is that missing half, and everything here is about the two
// rules governing it.
//
// First: config wins. An operator's hand-written tree must never be overridden
// by a chat message, or a Slack DM becomes a way to redirect someone else's
// commits.
//
// Second, and less obvious: the overlay has to be consulted BEFORE the refusal,
// not after. `resolveHierarchy` throws PatRequesterNotAuthorisedError when an
// org is configured but the requester is not in it. Put the overlay lookup on
// the wrong side of that throw and an org configured for one colleague locks
// out everyone who onboarded themselves -- and it fails as "not authorised",
// which reads like a permissions problem rather than a missing lookup.
import test from "node:test";
import assert from "node:assert/strict";

import { PatRouter, PatRequesterNotAuthorisedError } from "../dist/auth/pat-router.js";

const CAREL = "U07UT6G8LQ4";
const ATALIA = "U0ATALIA000";

/** A hand-rolled RouteLookup, so these tests need no database. */
const lookupOf = (...routes) => ({
  lookup: (provider, org, slackUserId) =>
    routes.find(
      (r) => r.provider === provider && r.org === org.toLowerCase() && r.slackUserId === slackUserId,
    ),
});

const route = (over = {}) => ({
  provider: "github",
  org: "stitch-vercel",
  person: "Carel",
  slackUserId: CAREL,
  commitName: "Carel van Heerden",
  commitEmail: "carel@stitch.money",
  vaultService: "github:stitch-vercel:carel",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

// `commit_identity` is only read on the legacy path, which the hierarchy and
// overlay branches return before ever reaching.
const BASE = { overrides: {}, commit_identity: {}, default_service_pattern: "github-{owner}" };

const resolve = (router, slackUserId = CAREL, repo = "stitch-vercel/web") =>
  router.resolve({ slackUserId, gitHubUser: "stitch-vercel", repoFullName: repo });

test("an onboarded route resolves where config has no tree at all", () => {
  const r = resolve(new PatRouter({ ...BASE }, lookupOf(route())));
  assert.equal(r.provenance, "overlay");
  assert.deepEqual(r.tokenPointer, { vault: "github:stitch-vercel:carel" });
  assert.equal(r.commitIdentity.email, "carel@stitch.money");
  assert.equal(r.person, "Carel");
});

test("config wins over an onboarded route for the same person", () => {
  // The precedence rule. A chat message must not redirect a commit identity an
  // operator wrote down.
  const cfg = {
    ...BASE,
    github: {
      "stitch-vercel": {
        Carel: {
          token: { vault: "configured-service" },
          name: "Configured Name",
          email: "configured@stitch.money",
          slack_user_id: CAREL,
        },
      },
    },
  };
  const r = resolve(new PatRouter(cfg, lookupOf(route())));
  assert.equal(r.provenance, "hierarchy");
  assert.deepEqual(r.tokenPointer, { vault: "configured-service" });
  assert.equal(r.commitIdentity.email, "configured@stitch.money");
});

test("an org configured for a colleague does not lock out someone who onboarded", () => {
  // The ordering bug this file exists to catch. Config defines the org for
  // Carel only; Atalia onboarded her own. Consulting the overlay after the
  // throw would refuse her with "not authorised".
  const cfg = {
    ...BASE,
    github: {
      "stitch-vercel": {
        Carel: {
          token: { vault: "carel-service" },
          name: "Carel van Heerden",
          email: "carel@stitch.money",
          slack_user_id: CAREL,
        },
      },
    },
  };
  const overlay = lookupOf(
    route({ person: "Atalia", slackUserId: ATALIA, commitEmail: "atalia@stitch.money", vaultService: "atalia-service" }),
  );
  const r = resolve(new PatRouter(cfg, overlay), ATALIA);
  assert.equal(r.provenance, "overlay");
  assert.deepEqual(r.tokenPointer, { vault: "atalia-service" });
  assert.equal(r.commitIdentity.email, "atalia@stitch.money");
});

test("a stranger in a configured org is still refused", () => {
  // The overlay must not soften the no-fallback rule: someone with neither a
  // config entry nor an onboarded route gets nobody else's token.
  const cfg = {
    ...BASE,
    github: {
      "stitch-vercel": {
        Carel: {
          token: { vault: "carel-service" },
          name: "Carel van Heerden",
          email: "carel@stitch.money",
          slack_user_id: CAREL,
        },
      },
    },
  };
  assert.throws(
    () => resolve(new PatRouter(cfg, lookupOf(route())), "U0STRANGER"),
    PatRequesterNotAuthorisedError,
  );
});

test("the refusal names onboarding as a way out", () => {
  const cfg = {
    ...BASE,
    github: {
      "stitch-vercel": {
        Carel: { token: { vault: "s" }, name: "C", email: "c@x.com", slack_user_id: CAREL },
      },
    },
  };
  try {
    resolve(new PatRouter(cfg), "U0STRANGER");
    assert.fail("expected a refusal");
  } catch (err) {
    assert.match(err.message, /harness_onboard/);
    assert.match(err.message, /No silent fallback/);
  }
});

test("one person's two orgs resolve to their own tokens", () => {
  // The case a flat per-user name cannot express, now end to end through the
  // router rather than only in the store.
  const overlay = lookupOf(
    route(),
    route({ org: "stitch-money", vaultService: "github:stitch-money:carel" }),
  );
  const router = new PatRouter({ ...BASE }, overlay);
  assert.deepEqual(resolve(router, CAREL, "stitch-vercel/web").tokenPointer, {
    vault: "github:stitch-vercel:carel",
  });
  assert.deepEqual(resolve(router, CAREL, "stitch-money/api").tokenPointer, {
    vault: "github:stitch-money:carel",
  });
});

test("with no overlay the router behaves exactly as before", () => {
  // The overlay is optional. Without one, an unconfigured org falls through to
  // the legacy flat pattern rather than throwing.
  const r = resolve(new PatRouter({ ...BASE }));
  assert.equal(r.provenance, "default_pattern");
  assert.equal(r.credentialService, "github-stitch-vercel");
  assert.equal(r.tokenPointer, undefined);
});

test("an overlay miss still falls through to the legacy path", () => {
  const r = resolve(new PatRouter({ ...BASE }, lookupOf(route({ org: "somewhere-else" }))));
  assert.equal(r.provenance, "default_pattern");
  assert.equal(r.tokenPointer, undefined);
});

test("orgs match case-insensitively through the router", () => {
  const r = resolve(new PatRouter({ ...BASE }, lookupOf(route())), CAREL, "Stitch-Vercel/web");
  assert.equal(r.provenance, "overlay");
  assert.deepEqual(r.tokenPointer, { vault: "github:stitch-vercel:carel" });
});
