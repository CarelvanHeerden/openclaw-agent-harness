// The floor helper the 29 version tests share. What it has to get right is the
// boundary the old inline closures got wrong: a version that is not a beta at
// all, but comes after every beta.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { betaOrdinal, compareSemver, pluginVersionOf } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

test("a beta yields its own number, so existing floors keep their meaning", () => {
  assert.equal(betaOrdinal("0.1.0-beta.70"), 70);
  assert.equal(betaOrdinal("0.1.0-beta.136"), 136);
  assert.equal(betaOrdinal("0.1.0-beta.7"), 7);
});

test("three-digit betas are not truncated (the beta.100 regression)", () => {
  assert.ok(betaOrdinal("0.1.0-beta.100") >= 100);
  assert.ok(betaOrdinal("0.1.0-beta.136") >= 112);
  assert.ok(betaOrdinal("0.1.0-beta.99") < 100);
});

test("everything after the beta line clears every floor", () => {
  for (const v of ["0.1.0", "1.0.0-rc.1", "1.0.0-rc.12", "1.0.0", "1.2.3", "2.0.0-beta.1"]) {
    assert.equal(betaOrdinal(v), Infinity, v);
    assert.ok(betaOrdinal(v) >= 136, `${v} should clear a beta.136 floor`);
  }
});

test("versions before the beta line, and non-versions, do not pass a floor", () => {
  for (const v of ["0.0.9", "0.1.0-alpha.9", "", null, undefined, "not-a-version"]) {
    assert.ok(!(betaOrdinal(v) >= 0), `${v} must not clear a floor`);
  }
});

test("semver precedence, including prerelease ordering", () => {
  assert.equal(compareSemver("0.1.0-beta.9", "0.1.0-beta.10"), -1);
  assert.equal(compareSemver("0.1.0-beta.136", "0.1.0"), -1);
  assert.equal(compareSemver("0.1.0", "1.0.0-rc.1"), -1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0-rc.2"), -1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
});

test("pluginVersionOf reads the version out of version.ts as written", () => {
  const src = readFileSync(join(root, "src", "version.ts"), "utf8");
  const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  assert.equal(pluginVersionOf(src), declared, "version.ts and package.json must agree");
  assert.equal(pluginVersionOf('pluginVersion: "1.0.0-rc.1",'), "1.0.0-rc.1");
  assert.equal(pluginVersionOf("no version here"), "");
});
