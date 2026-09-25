// beta.55 restored: mid-run interaction states are retired; confirmation is the sole human boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTerminalReport } from "../dist/control/report.js";
import { allowedControlTransitions } from "../dist/control/state-machine.js";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const reg=readFileSync(resolve(root,"src/tools/registration.ts"),"utf8");

test("beta55: the only pre-execution human boundary is exact authenticated confirmation",()=>{
  assert.deepEqual(allowedControlTransitions("awaiting_confirmation"),["autonomous_run","failed","cancelled"]);
  assert.match(reg,/current authenticated user message plainly approves/);
  assert.match(reg,/matching fresh raw host event/);
  assert.doesNotMatch(reg,/awaiting_clarification|clarification_answer|harness_answer/);
});

test("beta55: an execution problem returns a terminal safe result rather than a resumable question",()=>{
  const report=buildTerminalReport({runId:"chg_abcdefghijkl",state:"failed",code:"execution_failed",question:"secret",subtask:"secret"});
  assert.equal(report.kind,"terminal");assert.equal(report.state,"failed");assert.equal(report.code,"execution_failed");
  assert.doesNotMatch(JSON.stringify(report),/question|subtask|secret/i);
});

test("beta55: terminal states expose no continuation transitions",()=>{
  for(const state of ["done","failed","cancelled"]) assert.deepEqual(allowedControlTransitions(state),[]);
});
