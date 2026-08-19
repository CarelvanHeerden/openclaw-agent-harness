// A token says who it belongs to, and that settles who may replace it.
//
// WHY THIS EXISTS: `harness_onboard` takes the requester as an ARGUMENT. On an
// agent-relayed call nothing proves the caller is that person. The DM flow
// protects capture -- the prompt opens in the named user's own DM, so a caller
// cannot read someone else's token -- but not storage: a caller could submit
// THEIR token under SOMEONE ELSE'S id, and that person's later commits would
// push with it.
//
// Validation already calls GET /user and gets back the login the token
// authenticates as, so the token settles the argument without any Slack scope
// and without trusting the relaying agent.
//
// The fail-closed rule is the point: a token that will not say who it belongs
// to cannot be shown to be the same one, and "cannot attest" is not "matches".
import test from "node:test";
import assert from "node:assert/strict";

import { checkTokenIdentity } from "../dist/auth/identity.js";

test("a brand-new route accepts the first token and records its owner", () => {
  const v = checkTokenIdentity(undefined, "carelvanheerden");
  assert.equal(v.ok, true);
  assert.equal(v.kind, "first");
  assert.equal(v.attested, true);
  assert.equal(v.login, "carelvanheerden");
});

test("a first token that will not identify itself is accepted but flagged unattested", () => {
  // Nothing to compare against, so there is nothing to refuse -- but the caller
  // must be able to say that this credential can never be checked later.
  const v = checkTokenIdentity(undefined, undefined);
  assert.equal(v.ok, true);
  assert.equal(v.kind, "first");
  assert.equal(v.attested, false);
  assert.equal(v.login, undefined);
});

test("the same account may replace its own token", () => {
  const v = checkTokenIdentity("carelvanheerden", "carelvanheerden");
  assert.equal(v.ok, true);
  assert.equal(v.kind, "match");
});

test("login comparison ignores case, as the providers do", () => {
  assert.equal(checkTokenIdentity("CarelvanHeerden", "carelvanheerden").ok, true);
  assert.equal(checkTokenIdentity("carelvanheerden", "  CarelVanHeerden  ").ok, true);
});

test("a different account is refused, and the message says both names", () => {
  // The escalation this exists to stop: storing your token under someone
  // else's identity so their commits push with it.
  const v = checkTokenIdentity("atalia", "carelvanheerden");
  assert.equal(v.ok, false);
  assert.equal(v.kind, "mismatch");
  assert.equal(v.recorded, "atalia");
  assert.equal(v.presented, "carelvanheerden");
  assert.match(v.message, /belongs to 'atalia'/);
  assert.match(v.message, /authenticates as 'carelvanheerden'/);
  assert.match(v.message, /Nothing was changed/);
});

test("a token that discloses no account cannot replace an attested one", () => {
  // Fail closed. Being unable to attest is not the same as attesting a match,
  // and treating it as one would reopen the swap this check prevents.
  const v = checkTokenIdentity("carelvanheerden", undefined);
  assert.equal(v.ok, false);
  assert.equal(v.kind, "unattested");
  assert.equal(v.recorded, "carelvanheerden");
  assert.match(v.message, /did not identify its account/);
});

test("blank and whitespace logins count as absent, not as a match", () => {
  // "" must not sail through a naive equality check against a recorded login.
  assert.equal(checkTokenIdentity("carelvanheerden", "").kind, "unattested");
  assert.equal(checkTokenIdentity("carelvanheerden", "   ").kind, "unattested");
  assert.equal(checkTokenIdentity("", "carelvanheerden").kind, "first");
  assert.equal(checkTokenIdentity("   ", "carelvanheerden").kind, "first");
});
