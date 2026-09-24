// beta.22 restored: public metadata now describes only the canonical four-operation control plane.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHarnessTools } from "../dist/tools/registration.js";

function catalog() {
  const tools = [];
  registerHarnessTools({ logger: { info() {}, warn() {}, error() {} }, registerTool(def) { tools.push(typeof def === "function" ? def({ requesterSenderId: "U1", conversationId: "C1:T1" }) : def); return () => {}; } }, {});
  return tools;
}

test("beta22: ordinary metadata exposes exactly prepare, confirm, result, and merge", () => {
  assert.deepEqual(catalog().map((x) => x.name).sort(), ["harness_change_result", "harness_confirm_change", "harness_merge_change", "harness_prepare_change"]);
});

test("beta22: schemas are closed and descriptions contain no retired interaction protocol", () => {
  const tools = catalog();
  for (const tool of tools) assert.equal(tool.parameters.additionalProperties, false, tool.name);
  const metadata = JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
  assert.doesNotMatch(metadata, /OKF|relevantConcepts|clarification|poll|sub-?task|worktree|harness_(run|start_session|progress|answer|resume|revise|onboard)/i);
});

test("beta22: prepare owns the bounded request while later tools accept only changeId", () => {
  const byName = new Map(catalog().map((x) => [x.name, x]));
  assert.deepEqual(byName.get("harness_prepare_change").parameters.required, ["request", "repository"]);
  for (const name of ["harness_confirm_change", "harness_change_result", "harness_merge_change"]) {
    assert.deepEqual(byName.get(name).parameters.required, ["changeId"]);
  }
});
