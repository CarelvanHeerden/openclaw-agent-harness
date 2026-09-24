import test from "node:test";
import assert from "node:assert/strict";
const { buildReadinessReport, buildTerminalReport } = await import("../dist/control/report.js");
test("terminal feedback is always non-empty and reason coded",()=>{for(const [state,code] of [["done","completed"],["failed","execution_failed"],["cancelled","cancelled_by_requester"]]){const r=buildTerminalReport({runId:"r",state,code});assert.equal(r.kind,"terminal");assert.ok(r.message.length>0);assert.equal(r.code,code);}});
test("publication readiness feedback contains only safe aggregate checks",()=>{const run={id:"r",state:"pr_ready",pullRequestUrl:"https://example/pr/1"};const r=buildReadinessReport({run,checksPassed:4,checksTotal:4});assert.deepEqual(r.checks,{passed:4,total:4});assert.equal(r.pullRequestUrl,run.pullRequestUrl);assert.doesNotMatch(JSON.stringify(r),/prompt|subtask|worktree/i);});
