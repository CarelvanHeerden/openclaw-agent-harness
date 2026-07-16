import test from "node:test";
import assert from "node:assert/strict";

let buildSdkEnv;
try {
  ({ buildSdkEnv } = await import("../dist/adapters/claude-sdk.js"));
} catch {
  buildSdkEnv = null;
}

test("buildSdkEnv: undefined key -> undefined env (inherit default SDK behaviour)",
  { skip: buildSdkEnv === null }, () => {
    assert.equal(buildSdkEnv(undefined), undefined);
    assert.equal(buildSdkEnv(""), undefined);
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
