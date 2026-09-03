import test from "node:test";
import assert from "node:assert/strict";

let buildSdkEnv;
try {
  ({ buildSdkEnv } = await import("../dist/adapters/claude-code.js"));
} catch {
  buildSdkEnv = null;
}

// beta.110: this used to assert `undefined` for a missing key, which told the
// SDK to inherit the FULL parent env -- silently bypassing the beta.57 denylist
// in exactly the configuration (no explicit key) where it still matters. The
// no-key path now returns a FILTERED env: no ANTHROPIC_API_KEY is injected, so
// the child still falls through to its own `/login` store, but it no longer
// inherits every secret the harness holds.
test("buildSdkEnv: undefined key -> filtered env with no injected key",
  { skip: buildSdkEnv === null }, () => {
    process.env.OAH_TEST_MARKER = "keep-me";
    process.env.OAH_TEST_TOKEN = "strip-me";
    try {
      for (const key of [undefined, ""]) {
        const env = buildSdkEnv(key);
        assert.ok(env && typeof env === "object", "no-key path must not hand the child an unfiltered env");
        assert.equal(env.ANTHROPIC_API_KEY, undefined, "no key was resolved, so none should be injected");
        assert.equal(env.OAH_TEST_MARKER, "keep-me", "non-secret vars should still be inherited");
        assert.equal(env.OAH_TEST_TOKEN, undefined, "the denylist must still apply without a key");
      }
    } finally {
      delete process.env.OAH_TEST_MARKER;
      delete process.env.OAH_TEST_TOKEN;
    }
  });

test("buildSdkEnv: sets ANTHROPIC_API_KEY and inherits parent env",
  { skip: buildSdkEnv === null }, () => {
    process.env.OAH_TEST_MARKER = "keep-me";
    const env = buildSdkEnv("sk-abc-123");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-abc-123");
    assert.equal(env.OAH_TEST_MARKER, "keep-me");
    delete process.env.OAH_TEST_MARKER;
  });

test("buildSdkEnv: explicit key overrides an inherited ANTHROPIC_API_KEY",
  { skip: buildSdkEnv === null }, () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ambient-should-be-overridden";
    const env = buildSdkEnv("sk-explicit-wins");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-explicit-wins");
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  });
