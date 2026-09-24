import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePrReadiness } from "../dist/control/readiness.js";
const head="a".repeat(40),route="b".repeat(64);
const input=(over={})=>({finalVerdict:"pass",blockingFindings:0,reviewCompleted:true,verificationProbes:{completed:1,required:1,indeterminate:0},candidateSha:head,publication:{sha:head,observedAt:10},pullRequest:{repository:"o/r",baseRef:"main",headSha:head,open:true},expectedRepository:"o/r",expectedBaseRef:"main",requiredCi:{registered:true,requiredChecks:["test"],successfulChecks:["test"],sha:head,status:"success"},runtimeEvidence:{status:"not_required"},securityEvidence:{status:"pass",sha:head,observedAt:1},elapsedTimeMs:10,timeLimitMs:100,changedPaths:["src/x.ts"],allowedScope:["src/**"],excludedScope:[],operationsPerformed:["test"],operationReceipts:[{operation:"test",observedAt:1,source:"test-fixture"}],allowedOperations:["test"],credentialRouteDigest:route,expectedCredentialRouteDigest:route,secretExposure:{detected:false,evidence:"pass"},spendUsd:1,budgetUsd:2,...over});

test("beta109: readiness requires an exact pass, not a recommendation",()=>{for(const verdict of ["revise","block","crashed","indeterminate"]){const r=evaluatePrReadiness(input({finalVerdict:verdict}),11);assert.equal(r.ready,false,verdict);assert.ok(r.failures.includes("review_not_passed"));}});

test("beta109: any positive blocking count fails closed",()=>{for(const n of [1,2,99]){const r=evaluatePrReadiness(input({blockingFindings:n}),11);assert.equal(r.state,"failed");assert.ok(r.failures.includes("blocking_findings"));}});

test("beta109: malformed or unknown blocking counts also fail",()=>{for(const n of [-1,1.5,NaN]){const r=evaluatePrReadiness(input({blockingFindings:n}),11);assert.equal(r.ready,false);assert.ok(r.failures.includes("blocking_findings"));}});

test("beta109: pass plus zero blockers still needs complete determinate probes",()=>{for(const probes of [{completed:0,required:1,indeterminate:0},{completed:1,required:2,indeterminate:0},{completed:1,required:1,indeterminate:1}]){const r=evaluatePrReadiness(input({verificationProbes:probes}),11);assert.equal(r.ready,false);assert.ok(r.failures.includes("missing_probes"));}});

test("beta109: only the fully proven candidate becomes pr_ready",()=>{const r=evaluatePrReadiness(input(),11);assert.equal(r.ready,true);assert.equal(r.state,"pr_ready");assert.equal(r.verifiedSha,head);});
