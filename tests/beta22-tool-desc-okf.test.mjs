// Public metadata exposes only natural-language translation and safe status.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHarnessTools } from "../dist/tools/registration.js";

function catalog() {
  const tools = [];
  registerHarnessTools({ logger: { info() {}, warn() {}, error() {} }, registerTool(def) { tools.push(typeof def === "function" ? def({ requesterSenderId: "U1", conversationId: "C1:T1" }) : def); return () => {}; } }, {});
  return tools;
}

test("beta22: ordinary metadata exposes exactly prepare and result", () => {
  assert.deepEqual(catalog().map((x) => x.name).sort(), ["harness_change_result", "harness_prepare_change"]);
});

test("beta22: schemas are closed and descriptions contain no retired interaction protocol", () => {
  const tools = catalog();
  for (const tool of tools) assert.equal(tool.parameters.additionalProperties, false, tool.name);
  const metadata = JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
  assert.doesNotMatch(metadata, /OKF|relevantConcepts|clarification|poll|sub-?task|worktree|harness_(run|start_session|progress|answer|resume|revise|onboard)/i);
});

test("beta22: prepare owns the bounded request while status accepts only changeId", () => {
  const byName = new Map(catalog().map((x) => [x.name, x]));
  assert.deepEqual(byName.get("harness_prepare_change").parameters.required, ["request", "repository"]);
  assert.deepEqual(byName.get("harness_change_result").parameters.required, ["changeId"]);
});
