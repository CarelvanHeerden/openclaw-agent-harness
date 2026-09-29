// beta.41 restored: auto-feedback/poll directives are retired in favor of safe result reads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registration = readFileSync(resolve(root, "src/tools/registration.ts"), "utf8");

test("beta41: public registration contains the four canonical operations", () => {
  for (const name of ["harness_prepare_change", "harness_confirm_change", "harness_change_result", "harness_merge_change"]) assert.match(registration, new RegExp(`"${name}"`));
});

test("beta41: no tool asks the caller to poll or relay progress", () => {
  assert.doesNotMatch(registration, /details\.feedback|AUTOMATIC PROGRESS|intervalSeconds|relayField|harness_progress|fire-and-forget/i);
  assert.match(registration, /Read the safe current or final outcome of a change/);
});

test("beta41: unknown internal errors collapse to a safe stable failure", () => {
  assert.match(registration, /code: "control_unavailable"/);
  assert.match(registration, /The change service is temporarily unavailable/);
  assert.doesNotMatch(registration, /stack:\s*error|String\(error\).*summary/);
});
