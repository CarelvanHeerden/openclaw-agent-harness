// Onboarding takes an org URL, and the URL has to be believed only as far as
// the operator's config allows.
//
// WHY THIS EXISTS: a person with tokens on more than one provider cannot say
// which one they are pasting by naming an org alone -- "stitch-vercel" is not
// GitHub any more than it is GitLab. The URL carries both facts, so onboarding
// asks for the URL.
//
// The security property under test is the refusal: the accepted hosts come from
// the configured providers, never from a guess. Inferring "looks like a GitLab"
// from an unknown hostname would hand a token to an API the operator never
// approved, so an unconfigured host must fail closed and say what IS allowed.
import test from "node:test";
import assert from "node:assert/strict";

import { acceptedHosts, parseOrgUrl } from "../dist/auth/org-url.js";

const PROVIDERS = {
  github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" },
  gitlab: { api_base: "https://gitlab.com/api/v4", api_key_env: "GITLAB_TOKEN" },
};

const ok = (input, providers = PROVIDERS) => {
  const r = parseOrgUrl(input, providers);
  assert.equal(r.ok, true, `expected "${input}" to parse, got: ${r.ok ? "" : r.error}`);
  return r.value;
};

const refused = (input, providers = PROVIDERS) => {
  const r = parseOrgUrl(input, providers);
  assert.equal(r.ok, false, `expected "${input}" to be refused`);
  return r.error;
};

test("a browser URL yields both the provider and the org", () => {
  assert.deepEqual(ok("https://github.com/stitch-vercel"), { provider: "github", org: "stitch-vercel" });
  assert.deepEqual(ok("https://gitlab.com/exipay"), { provider: "gitlab", org: "exipay" });
});

test("a repo URL resolves to the OWNER, not the repo", () => {
  // The router keys the hierarchy on the owner, so pasting a repo link must not
  // store a token under the repo name.
  assert.deepEqual(ok("https://github.com/stitch-money/payments-api"), {
    provider: "github",
    org: "stitch-money",
  });
});

test("clone and ssh remotes parse, since those are what people copy", () => {
  assert.deepEqual(ok("https://github.com/stitch-vercel/web.git"), { provider: "github", org: "stitch-vercel" });
  assert.deepEqual(ok("git@github.com:stitch-vercel/web.git"), { provider: "github", org: "stitch-vercel" });
  assert.deepEqual(ok("ssh://git@gitlab.com/exipay/billing.git"), { provider: "gitlab", org: "exipay" });
});

test("a bare host/org needs no scheme", () => {
  assert.deepEqual(ok("github.com/stitch-vercel"), { provider: "github", org: "stitch-vercel" });
});

test("org landing pages carry a prefix that is not the org", () => {
  // github.com/orgs/<name> and gitlab.com/groups/<name> are what you get from
  // the org's own settings page, so /orgs/ must not become the org.
  assert.deepEqual(ok("https://github.com/orgs/stitch-vercel"), { provider: "github", org: "stitch-vercel" });
  assert.deepEqual(ok("https://gitlab.com/groups/exipay"), { provider: "gitlab", org: "exipay" });
});

test("the API host is accepted as well as the web host", () => {
  // api_base names api.github.com; a human copies github.com. Both must work.
  assert.deepEqual(ok("https://api.github.com/stitch-vercel"), { provider: "github", org: "stitch-vercel" });
  const hosts = acceptedHosts(PROVIDERS);
  assert.equal(hosts.get("github.com"), "github");
  assert.equal(hosts.get("api.github.com"), "github");
  assert.equal(hosts.get("gitlab.com"), "gitlab");
});

test("query strings and fragments are not part of the org", () => {
  assert.deepEqual(ok("https://github.com/stitch-vercel?tab=repositories"), {
    provider: "github",
    org: "stitch-vercel",
  });
  assert.deepEqual(ok("https://github.com/stitch-vercel#readme"), { provider: "github", org: "stitch-vercel" });
});

test("host matching ignores case, and the org keeps the case it was written in", () => {
  // The confirmation echoes the org back, so "Stitch-Vercel" should not become
  // "stitch-vercel" in the reply. PatRouter matches either form on lookup.
  assert.deepEqual(ok("https://GitHub.com/Stitch-Vercel"), { provider: "github", org: "Stitch-Vercel" });
});

test("an unconfigured host fails closed and names what is allowed", () => {
  const err = refused("https://bitbucket.org/stitch-vercel");
  assert.match(err, /not a configured git provider/);
  assert.match(err, /github\.com/);
  assert.match(err, /gitlab\.com/);
});

test("a self-hosted provider is accepted exactly when it is configured", () => {
  const selfHosted = {
    gitlab: { api_base: "https://gitlab.exipay.internal/api/v4", api_key_env: "GITLAB_TOKEN" },
  };
  assert.deepEqual(ok("https://gitlab.exipay.internal/exipay", selfHosted), {
    provider: "gitlab",
    org: "exipay",
  });
  // The same URL against the stock config is refused, not guessed as GitLab.
  assert.match(refused("https://gitlab.exipay.internal/exipay"), /not a configured git provider/);
});

test("a GitHub Enterprise api_base maps back to its web host", () => {
  const ghe = { github: { api_base: "https://api.git.corp.example/v3", api_key_env: "GH_TOKEN" } };
  assert.deepEqual(ok("https://git.corp.example/platform", ghe), { provider: "github", org: "platform" });
});

test("a host with no org is refused rather than guessed", () => {
  assert.match(refused("https://github.com"), /no org/);
  assert.match(refused("https://github.com/"), /no org/);
});

test("empty input is refused", () => {
  assert.match(refused(""), /no org URL/);
  assert.match(refused(undefined), /no org URL/);
  assert.match(refused("   "), /no org URL/);
});

test("with no providers configured nothing can be onboarded", () => {
  assert.match(refused("https://github.com/stitch-vercel", {}), /no git providers are configured/);
  // Called directly: `refused`'s default parameter would swallow an explicit
  // undefined and silently test the stock providers instead.
  const r = parseOrgUrl("https://github.com/stitch-vercel", undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /no git providers are configured/);
});

test("a malformed api_base is skipped rather than throwing", () => {
  const broken = {
    github: { api_base: "not a url", api_key_env: "GH_TOKEN" },
    gitlab: { api_base: "https://gitlab.com/api/v4", api_key_env: "GITLAB_TOKEN" },
  };
  const hosts = acceptedHosts(broken);
  assert.equal(hosts.has("github.com"), false);
  assert.equal(hosts.get("gitlab.com"), "gitlab");
});

test("a percent-encoded org is decoded", () => {
  assert.deepEqual(ok("https://gitlab.com/my%20group"), { provider: "gitlab", org: "my group" });
});

test("garbage that is not a URL is refused without throwing", () => {
  assert.match(refused("http://"), /is not a URL|no org/);
});
