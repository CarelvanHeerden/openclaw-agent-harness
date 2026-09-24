import test from "node:test";
import assert from "node:assert/strict";
import { registerHarnessTools } from "../dist/tools/registration.js";
test("public catalog contains no clarification protocol",()=>{const defs=[];registerHarnessTools({registerTool(d){defs.push(typeof d==="function"?d({}):d);return()=>{};}},{});const text=JSON.stringify(defs.map(({name,description,parameters})=>({name,description,parameters})));assert.doesNotMatch(text,/clarification|answer|resume|poll|sub-?task/i);assert.deepEqual(defs.map(x=>x.name).sort(),["harness_change_result","harness_confirm_change","harness_merge_change","harness_prepare_change"]);});
