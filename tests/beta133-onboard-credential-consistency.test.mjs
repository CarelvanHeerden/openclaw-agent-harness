// Restored beta.133 non-interaction credential routing coverage plus the canonical tool surface.
import test from "node:test";
import assert from "node:assert/strict";
import { PatRouter } from "../dist/auth/pat-router.js";
import { checkOnboardConsistency, resolveOnboardVaultService } from "../dist/slack/onboarding.js";
import { registerHarnessTools } from "../dist/tools/registration.js";

const routing = (pattern) => ({ overrides: {}, commit_identity: {}, default_service_pattern: pattern, default_provider: "github", provider_by_owner: {}, providers: { github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" } } });
const resolveFor = (pattern, slackUserId) => new PatRouter(routing(pattern)).resolve({ slackUserId, gitHubUser: "Stitch-Vercel", repoFullName: "Stitch-Vercel/ProjectThanos" }).credentialService;

test("beta133: {userid} resolves consistently and preserves Slack-id case", () => {
  const requester = "U07UT6G8LQ4";
  assert.equal(resolveFor("git-pat:{userid}", requester), "git-pat:U07UT6G8LQ4");
  assert.equal(resolveFor("{owner}/{userid}", requester), "stitch-vercel/U07UT6G8LQ4");
  const written = resolveOnboardVaultService(requester, { pattern: "git-pat:{userid}", provider: "github" });
  assert.equal(checkOnboardConsistency(written, [resolveFor("git-pat:{userid}", requester)]).ok, true);
});

test("beta133: credential consistency still rejects a name no configured route reads", () => {
  const verdict = checkOnboardConsistency("git-pat:U1", [" github-acme ", "github-acme"]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.writing, "git-pat:U1");
  assert.deepEqual(verdict.expected, ["github-acme"]);
  assert.equal(checkOnboardConsistency("git-pat:U1", []).undetermined, true);
});

test("beta133: onboarding is no longer an ordinary interaction tool", () => {
  const names = [];
  registerHarnessTools({ logger: { info() {}, warn() {}, error() {} }, registerTool(def) { names.push(def.name); return () => {}; } }, {});
  assert.deepEqual(names.sort(), ["harness_change_result", "harness_confirm_change", "harness_merge_change", "harness_prepare_change"]);
  assert.equal(names.includes("harness_onboard"), false);
});
