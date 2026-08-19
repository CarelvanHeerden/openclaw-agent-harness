// A secret is redacted because of the FIELD it arrived in, not only its shape.
//
// WHY THIS EXISTS: the log scrubs credential shapes it recognises -- `ghp_`,
// `github_pat_`, `glpat-`, `sk-ant-`. That list is a guess about other people's
// formats, and `harness_onboard` now accepts self-hosted providers: a GitHub
// Enterprise or private GitLab host issues tokens in whatever shape that
// deployment chose. The tool input carries the raw token under a key called
// `token`, so a format nobody has seen yet would be written to the log intact.
//
// Redacting by key closes that, and it is the half that cannot go stale. The
// matching is deliberately exact rather than substring: `tokensIn` and
// `tokenPointer` are diagnostics, and blanking them to be safe would take away
// the numbers the budget ledger is debugged with.
import test from "node:test";
import assert from "node:assert/strict";

import { redactValue } from "../dist/state/interaction-log.js";

test("a token field is redacted whatever shape the value has", () => {
  // The case shape matching cannot reach: a self-hosted provider's format.
  const out = redactValue({ action: "add", token: "xyzzy-corp-internal-format-9f8e7d" });
  assert.equal(out.token, "***");
  assert.equal(out.action, "add", "non-secret fields must survive");
});

test("the known shapes are still caught wherever they appear", () => {
  const out = redactValue({ note: "paste ghp_abcdefghijklmnopqrstuvwxyz01 here" });
  assert.equal(out.note.includes("ghp_abcdefghijklmnopqrstuvwxyz01"), false);
});

test("secret keys are matched exactly, so token counters survive", () => {
  // A substring match on "token" would blank all of these, and they are the
  // numbers a budget or routing problem is diagnosed from.
  const out = redactValue({ tokensIn: "1200", tokensOut: "300", tokenPointer: "github:acme:carel" });
  assert.equal(out.tokensIn, "1200");
  assert.equal(out.tokensOut, "300");
  assert.equal(out.tokenPointer, "github:acme:carel");
});

test("the usual spellings of a credential field are covered", () => {
  const out = redactValue({
    api_key: "k1", apiKey: "k2", accessToken: "k3", access_token: "k4",
    password: "p", secret: "s", Authorization: "Bearer whatever", privateKey: "pk",
  });
  for (const [k, v] of Object.entries(out)) assert.equal(v, "***", `${k} must be redacted`);
});

test("a secret nested in objects and arrays is still redacted", () => {
  const out = redactValue({ calls: [{ name: "harness_onboard", args: { token: "opaque-value-here" } }] });
  assert.equal(out.calls[0].args.token, "***");
  assert.equal(out.calls[0].name, "harness_onboard");
});

test("an array under a secret key is redacted element by element", () => {
  const out = redactValue({ token: ["one-value", "another-value"] });
  assert.deepEqual(out.token, ["***", "***"]);
});

test("an empty string is left alone, so absence stays distinguishable", () => {
  // "***" would claim a secret was present. An empty field means there wasn't
  // one, which is worth being able to tell apart when reading a failure.
  assert.equal(redactValue({ token: "" }).token, "");
});

test("non-strings under a secret key are not turned into stars", () => {
  assert.equal(redactValue({ token: null }).token, null);
  assert.equal(redactValue({ token: false }).token, false);
});
