import test from "node:test";
import assert from "node:assert/strict";
import { buildReadinessReport,buildTerminalReport } from "../dist/control/report.js";
test("public reports expose bounded outcome telemetry only",()=>{const run={id:"chg_x",state:"pr_ready",pullRequestUrl:"https://example.test/pr/1"};const ready=buildReadinessReport({run,checksPassed:4,checksTotal:4,prompt:"secret",tokens:999});const terminal=buildTerminalReport({runId:"chg_x",state:"failed",code:"verification_failed",costUsd:99,provider:"secret"});const text=JSON.stringify([ready,terminal]);for(const forbidden of ["prompt","tokens","costUsd","provider","secret"])assert.doesNotMatch(text,new RegExp(forbidden));assert.equal(ready.checks.passed,4);assert.equal(Object.isFrozen(ready),true);});
