// beta.43 restored: every indeterminate structured signal is a strict terminal readiness failure.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePrReadiness } from "../dist/control/readiness.js";
const sha=(c,n=64)=>c.repeat(n);
const base={ finalVerdict:"pass",blockingFindings:0,reviewCompleted:true,verificationProbes:{completed:2,required:2,indeterminate:0},candidateSha:sha("c",40),publication:{sha:sha("c",40),observedAt:1},pullRequest:{repository:"a/r",baseRef:"main",headSha:sha("c",40),open:true},expectedRepository:"a/r",expectedBaseRef:"main",requiredCi:{registered:true,requiredChecks:["test"],successfulChecks:["test"],sha:sha("c",40),status:"success"},runtimeEvidence:{status:"pass",sha:sha("c",40),observedAt:1},securityEvidence:{status:"pass",sha:sha("c",40),observedAt:1},elapsedTimeMs:10,timeLimitMs:100,changedPaths:["src/x"],allowedScope:["src"],excludedScope:[],operationsPerformed:["test"],operationReceipts:[{operation:"test",observedAt:1,source:"test-fixture"}],allowedOperations:["test"],credentialRouteDigest:sha("d"),expectedCredentialRouteDigest:sha("d"),secretExposure:{detected:false,evidence:"pass"},spendUsd:1,budgetUsd:2 };

test("beta43: a crashed or incomplete review cannot become ready",()=>{
  const out=evaluatePrReadiness({...base,finalVerdict:"crashed",reviewCompleted:false});
  assert.equal(out.ready,false); assert.ok(out.failures.includes("review_crash")); assert.ok(out.failures.includes("review_not_passed"));
});

test("beta43: indeterminate runtime or security evidence fails closed",()=>{
  const out=evaluatePrReadiness({...base,runtimeEvidence:{status:"indeterminate"},securityEvidence:{status:"indeterminate"}});
  assert.equal(out.ready,false); assert.ok(out.failures.includes("runtime_evidence_indeterminate")); assert.ok(out.failures.includes("security_evidence_indeterminate"));
});

test("beta43: incomplete verification probes fail closed",()=>{
  const out=evaluatePrReadiness({...base,verificationProbes:{completed:1,required:2,indeterminate:1}});
  assert.equal(out.ready,false); assert.ok(out.failures.includes("missing_probes"));
});
