import test from "node:test";
import assert from "node:assert/strict";
import { sessionScopedBranch } from "../dist/orchestrator/lead.js";
import { registerHarnessTools } from "../dist/tools/registration.js";
import { evaluatePrReadiness } from "../dist/control/readiness.js";

function surface(){const tools=[],commands=[];registerHarnessTools({logger:{info(){},warn(){},error(){}},registerTool(d){tools.push(typeof d==="function"?d({requesterSenderId:"U",conversationId:"C"}):d);return()=>{}},registerCommand(d){commands.push(d);return()=>{}}},{});return{tools,commands};}
const head="d".repeat(40),route="e".repeat(64);
const ready=(over={})=>({finalVerdict:"pass",blockingFindings:0,reviewCompleted:true,verificationProbes:{completed:2,required:2,indeterminate:0},candidateSha:head,publication:{sha:head,observedAt:100},pullRequest:{repository:"o/r",baseRef:"main",headSha:head,open:true,number:1},expectedRepository:"o/r",expectedBaseRef:"main",requiredCi:{registered:true,requiredChecks:["test"],successfulChecks:["test"],sha:head,status:"success"},runtimeEvidence:{status:"not_required"},securityEvidence:{status:"pass"},elapsedTimeMs:10,timeLimitMs:1000,changedPaths:["src/a.ts"],allowedScope:["src/**"],excludedScope:["secrets/**"],operationsPerformed:["implement","test"],allowedOperations:["implement","test"],credentialRouteDigest:route,expectedCredentialRouteDigest:route,secretExposure:{detected:false,evidence:"pass"},spendUsd:1,budgetUsd:2,...over});

test("beta108: ordinary catalog is exactly the four canonical operations",()=>{const {tools,commands}=surface();assert.deepEqual(tools.map(t=>t.name).sort(),["harness_change_result","harness_confirm_change","harness_merge_change","harness_prepare_change"]);assert.deepEqual(commands,[]);});

test("beta108: public metadata exposes no interactive protocol",()=>{const text=JSON.stringify(surface().tools);assert.doesNotMatch(text,/clarification|resume|revise|progress|sub-?task|poll|worktree|harness_(answer|run)/i);});

test("beta108: branch names stay isolated by session",()=>{const a=sessionScopedBranch("harness/feature","21c9c44e-4177");const b=sessionScopedBranch("harness/feature","06b91509-239d");assert.notEqual(a,b);assert.equal(sessionScopedBranch(a,"21c9c44e-4177"),a);});

test("beta108: changed paths are bounded by allowed and excluded scope",()=>{assert.equal(evaluatePrReadiness(ready(),101).ready,true);const outside=evaluatePrReadiness(ready({changedPaths:["docs/a.md"]}),101);assert.equal(outside.ready,false);assert.ok(outside.failures.includes("scope_exceeded"));const excluded=evaluatePrReadiness(ready({changedPaths:["src/a.ts","secrets/key.txt"],allowedScope:["src/**","secrets/**"]}),101);assert.equal(excluded.ready,false);assert.ok(excluded.failures.includes("scope_exceeded"));});

test("beta108: an operation outside the confirmed authority is terminal non-readiness",()=>{const r=evaluatePrReadiness(ready({operationsPerformed:["implement","force_push"]}),101);assert.equal(r.state,"failed");assert.ok(r.failures.includes("operation_not_authorized"));});
