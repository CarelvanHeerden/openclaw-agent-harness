import test from "node:test";
import assert from "node:assert/strict";

test("scaffold sanity", () => {
  assert.equal(1 + 1, 2);
});

// Real tests land in phase 1+. This just ensures `pnpm test` doesn't fail
// on an empty test directory.
