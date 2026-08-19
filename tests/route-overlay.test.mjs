// The routing entry that onboarding writes.
//
// WHY THIS EXISTS: `pat_routing.<provider>.<org>.<person>` lives in plugin
// config, which is read-only at runtime, so onboarding could store a secret but
// nothing that told the router to use it. The token sat in the vault under a
// name no session looked up, every step reported success, and the run died an
// hour later at clone.
//
// The case that drove the shape of this table: one person holds DIFFERENT
// tokens for different orgs on the same provider -- Carel on stitch-vercel and
// Carel on stitch-money. A flat per-user name cannot express that, and the
// second onboarding would overwrite the first, so a run would silently push
// with the wrong org's token.
//
// These tests drive a real SQLite database through the real schema, because a
// primary key that does not do what it claims is exactly the defect that would
// reintroduce the overwrite.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStateStoreSync } from "../dist/state/store.js";
import { RouteOverlay, normaliseOrg } from "../dist/auth/route-overlay.js";

const CAREL = "U07UT6G8LQ4";
const ATALIA = "U0ATALIA000";

function makeOverlay(now) {
  const dir = mkdtempSync(join(tmpdir(), "oah-overlay-"));
  const state = openStateStoreSync(join(dir, "state.db"));
  return { state, overlay: new RouteOverlay(state.db, now) };
}

const route = (over) => ({
  provider: "github",
  org: "stitch-vercel",
  person: "Carel",
  slackUserId: CAREL,
  commitName: "Carel van Heerden",
  commitEmail: "carel@stitch.money",
  vaultService: "github:stitch-vercel:carel",
  ...over,
});

test("an empty overlay resolves nothing", () => {
  const { state, overlay } = makeOverlay();
  assert.equal(overlay.lookup("github", "stitch-vercel", CAREL), undefined);
  state.close();
});

test("what onboarding writes is what the router reads back", () => {
  const { state, overlay } = makeOverlay();
  overlay.upsert(route());
  const hit = overlay.lookup("github", "stitch-vercel", CAREL);
  assert.equal(hit.vaultService, "github:stitch-vercel:carel");
  assert.equal(hit.commitEmail, "carel@stitch.money");
  assert.equal(hit.person, "Carel");
  state.close();
});

test("one person, two orgs, two DIFFERENT tokens", () => {
  // The scenario a flat per-user name cannot express. Both rows must survive,
  // and each org must resolve to its own vault entry.
  const { state, overlay } = makeOverlay();
  overlay.upsert(route());
  overlay.upsert(route({ org: "stitch-money", vaultService: "github:stitch-money:carel" }));

  assert.equal(overlay.lookup("github", "stitch-vercel", CAREL).vaultService, "github:stitch-vercel:carel");
  assert.equal(overlay.lookup("github", "stitch-money", CAREL).vaultService, "github:stitch-money:carel");
  assert.equal(overlay.listForRequester(CAREL).length, 2);
  state.close();
});

test("the same org on two providers stays distinct", () => {
  const { state, overlay } = makeOverlay();
  overlay.upsert(route({ provider: "github", org: "exipay", vaultService: "github:exipay:carel" }));
  overlay.upsert(route({ provider: "gitlab", org: "exipay", vaultService: "gitlab:exipay:carel" }));
  assert.equal(overlay.lookup("gitlab", "exipay", CAREL).vaultService, "gitlab:exipay:carel");
  assert.equal(overlay.lookup("github", "exipay", CAREL).vaultService, "github:exipay:carel");
  state.close();
});

test("a lookup is scoped to the requester, never to whoever is in the org", () => {
  // Two people in one org must not borrow each other's token -- the whole
  // reason the hierarchy refuses to fall back.
  const { state, overlay } = makeOverlay();
  overlay.upsert(route());
  overlay.upsert(route({
    person: "Atalia",
    slackUserId: ATALIA,
    commitName: "Atalia",
    commitEmail: "atalia@stitch.money",
    vaultService: "github:stitch-vercel:atalia",
  }));

  assert.equal(overlay.lookup("github", "stitch-vercel", CAREL).vaultService, "github:stitch-vercel:carel");
  assert.equal(overlay.lookup("github", "stitch-vercel", ATALIA).vaultService, "github:stitch-vercel:atalia");
  assert.equal(overlay.lookup("github", "stitch-vercel", "U0NOBODY"), undefined);
  assert.equal(overlay.listForOrg("github", "stitch-vercel").length, 2);
  state.close();
});

test("orgs match case-insensitively, because a URL preserves whatever was typed", () => {
  const { state, overlay } = makeOverlay();
  overlay.upsert(route({ org: "Stitch-Vercel" }));
  assert.ok(overlay.lookup("github", "stitch-vercel", CAREL));
  assert.ok(overlay.lookup("github", "STITCH-VERCEL", CAREL));
  assert.equal(normaliseOrg("  Stitch-Vercel "), "stitch-vercel");
  state.close();
});

test("re-onboarding keeps the original created_at and moves updated_at", () => {
  // The management view shows when a credential was first added; a rotation
  // must not make it look new.
  let clock = 1000;
  const { state, overlay } = makeOverlay(() => clock);
  const first = overlay.upsert(route());
  assert.equal(first.createdAt, 1000);

  clock = 5000;
  const second = overlay.upsert(route({ vaultService: "github:stitch-vercel:carel" }));
  assert.equal(second.createdAt, 1000, "created_at should survive a rotation");
  assert.equal(second.updatedAt, 5000);
  assert.equal(overlay.listForRequester(CAREL).length, 1, "rotation must not duplicate the row");
  state.close();
});

test("removal reports whether anything was actually removed", () => {
  const { state, overlay } = makeOverlay();
  overlay.upsert(route());
  assert.equal(overlay.remove("github", "stitch-vercel", "Carel"), true);
  assert.equal(overlay.remove("github", "stitch-vercel", "Carel"), false);
  assert.equal(overlay.lookup("github", "stitch-vercel", CAREL), undefined);
  state.close();
});

test("the table names a vault entry and never holds the token", () => {
  // A routing row is not a secret store. If a token column ever appears here it
  // is a design regression, and this is the cheapest place to catch it.
  const { state, overlay } = makeOverlay();
  overlay.upsert(route());
  const cols = state.db.prepare("PRAGMA table_info(credential_routes)").all().map((c) => String(c.name));
  for (const banned of ["token", "secret", "pat", "password", "ciphertext"]) {
    assert.equal(cols.includes(banned), false, `credential_routes must not carry a "${banned}" column`);
  }
  assert.ok(cols.includes("vault_service"));
  state.close();
});

test("expiry and attested login round-trip, since both drive later refusals", () => {
  const { state, overlay } = makeOverlay();
  overlay.upsert(route({ providerLogin: "carelvanheerden", tokenExpiresAt: 1893456000000 }));
  const hit = overlay.lookup("github", "stitch-vercel", CAREL);
  assert.equal(hit.providerLogin, "carelvanheerden");
  assert.equal(hit.tokenExpiresAt, 1893456000000);
  state.close();
});

test("an absent login or expiry comes back undefined, not null", () => {
  const { state, overlay } = makeOverlay();
  overlay.upsert(route());
  const hit = overlay.lookup("github", "stitch-vercel", CAREL);
  assert.equal(hit.providerLogin, undefined);
  assert.equal(hit.tokenExpiresAt, undefined);
  state.close();
});
