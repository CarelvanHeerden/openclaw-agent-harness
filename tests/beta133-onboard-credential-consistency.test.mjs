// beta.133 credential routing coverage plus the canonical four-operation surface.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { PatRouter } from "../dist/auth/pat-router.js";
import { registerHarnessTools } from "../dist/tools/registration.js";

const routing = (pattern) => ({ overrides: {}, commit_identity: {}, default_service_pattern: pattern, default_provider: "github", provider_by_owner: {}, providers: { github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" } } });
const resolveFor = (pattern, slackUserId) => new PatRouter(routing(pattern)).resolve({ slackUserId, gitHubUser: "Stitch-Vercel", repoFullName: "Stitch-Vercel/ProjectThanos" }).credentialService;

test("beta133: {userid} routing preserves host user-id case", () => {
  const requester = "U07UT6G8LQ4";
  assert.equal(resolveFor("git-pat:{userid}", requester), "git-pat:U07UT6G8LQ4");
  assert.equal(resolveFor("{owner}/{userid}", requester), "stitch-vercel/U07UT6G8LQ4");
});

test("beta133: the retired onboarding module is absent from source and dist", () => {
  assert.equal(existsSync(new URL("../src/slack/onboarding.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../dist/slack/onboarding.js", import.meta.url)), false);
});

test("beta133: ordinary interaction exposes exactly four operations", () => {
  const names = [];
  registerHarnessTools({ logger: { info() {}, warn() {}, error() {} }, registerTool(def) { names.push(def.name); return () => {}; } }, {});
  assert.deepEqual(names.sort(), ["harness_change_result", "harness_confirm_change", "harness_merge_change", "harness_prepare_change"]);
});
