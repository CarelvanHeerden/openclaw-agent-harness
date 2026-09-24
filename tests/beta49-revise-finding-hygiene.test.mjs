// beta.49 restored: retain pure finding hygiene; interaction-specific revise parameters are retired.
import test from "node:test";
import assert from "node:assert/strict";
import { isConditionalFinding, findingText, CONDITIONAL_FINDING_RE } from "../dist/orchestrator/finding-hygiene.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");

test("beta49: unresolved-premise findings are detected without changing definite findings",()=>{
  for(const message of ["If no other callers exist, remove the helper.","Unless this is established, rename it.","Assuming the flag is unused elsewhere, delete it."]) assert.equal(isConditionalFinding({message}),true,message);
  for(const message of ["The dropdown renders placeholders.","Remove the unused import on line 12."]) assert.equal(isConditionalFinding({message}),false,message);
});

test("beta49: loose finding text variants and regex remain stable",()=>{
  assert.equal(findingText({message:"m"}),"m");assert.equal(findingText({finding:"f"}),"f");assert.equal(findingText({detail:"d"}),"d");assert.equal(findingText(null),"");
  assert.ok(CONDITIONAL_FINDING_RE instanceof RegExp);assert.ok(CONDITIONAL_FINDING_RE.flags.includes("i"));
});

test("beta49: no dropFindings interaction can mutate a confirmed authority envelope",()=>{
  const reg=readFileSync(resolve(root,"src/tools/registration.ts"),"utf8");
  assert.doesNotMatch(reg,/dropFindings|harness_revise|needsSelection/);
  assert.match(reg,/Confirm the exact prepared change in the authenticated conversation/);
});
