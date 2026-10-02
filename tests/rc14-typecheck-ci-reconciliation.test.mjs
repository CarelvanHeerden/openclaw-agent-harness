import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildTypecheckFinding, buildTypecheckUnavailableFinding, buildUnparsedTypecheckFailure, typecheckExecutionIsUnavailable } from "../dist/orchestrator/typecheck-gate.js";
import { classifyFinding, blocksMerge } from "../dist/orchestrator/finding-classify.js";
import { persistVerificationResolutions, reconcileBoundLocalVerificationWithRemoteCi, reconcileLocalVerificationWithRemoteCi, verificationResolutionDigest } from "../dist/control/verification-reconciliation.js";
import { evaluatePrReadiness } from "../dist/control/readiness.js";
import { openStateStoreSync } from "../dist/state/store.js";
import { testReviewEvidence } from "./helpers/review-evidence.mjs";

const sha=(c,n=40)=>c.repeat(n),candidate=sha("c"),route=sha("d",64);
const unavailable={...buildTypecheckUnavailableFinding({script:"typecheck",exitCode:null,reason:"no_trustworthy_exit_or_diagnostics"}),fingerprint:"typecheck-unavailable"};
const boundReview=testReviewEvidence(candidate,"pass",{findings:[unavailable]});
const resign=(resolution)=>{const {evidenceDigest:_,...unsigned}=resolution;return{...unsigned,evidenceDigest:verificationResolutionDigest(unsigned)}};

function reconcile(over={}){
  return reconcileLocalVerificationWithRemoteCi({
    findings:[unavailable],repository:"o/r",pullRequestNumber:1292,candidateSha:candidate,ciSha:candidate,
    policyStatus:"readable",policyChecks:["TypeScript Check","CI"],successfulChecks:["TypeScript Check","CI"],observedAt:110,
    reviewDigest:boundReview.recordDigest,
    ...over,
  });
}

function ready(resolutions){
  return {
    finalVerdict:"pass",blockingFindings:0,reviewBlockingFindings:1,findingClassificationContext:{repoHasTestScript:true,hasDeclaredGenerators:false},reviewCompleted:true,reviewFindings:[unavailable],
    reviewEvidence:boundReview,
    verificationResolutions:resolutions,
    verificationProbes:{completed:1,required:1,indeterminate:0},
    candidateSha:candidate,publication:{sha:candidate,observedAt:100},
    pullRequest:{repository:"o/r",baseRef:"main",headSha:candidate,open:true,number:1292},
    expectedRepository:"o/r",expectedBaseRef:"main",
    requiredCi:{registered:true,requiredChecks:["TypeScript Check","CI"],successfulChecks:["TypeScript Check","CI"],sha:candidate,status:"success"},
    runtimeEvidence:{status:"not_required"},securityEvidence:{status:"pass",sha:candidate,observedAt:110},
    elapsedTimeMs:1,timeLimitMs:1000,changedPaths:["README.md"],allowedScope:["README.md"],excludedScope:[],
    operationsPerformed:["test"],operationReceipts:[{operation:"test",observedAt:110,sha:candidate,source:"fixture"}],allowedOperations:["test"],
    credentialRouteDigest:route,expectedCredentialRouteDigest:route,secretExposure:{detected:false,evidence:"pass"},spendUsd:1,budgetUsd:5,
  };
}

test("PR #1292 null/blank local typecheck resolves only through equivalent exact-SHA repository CI",()=>{
  assert.match(unavailable.detail,/Local typecheck unavailable/);
  assert.equal(unavailable.localVerification.state,"unavailable");
  assert.equal(blocksMerge(unavailable,classifyFinding(unavailable)),true);
  const result=reconcile();
  assert.deepEqual(result.unresolvedFindings,[]);
  assert.equal(result.resolutions.length,1);
  assert.equal(result.resolutions[0].kind,"resolved_by_remote_ci");
  assert.equal(result.resolutions[0].candidateSha,candidate);
  assert.equal(result.resolutions[0].remoteCheck,"TypeScript Check");
  assert.match(result.resolutions[0].evidenceDigest,/^[a-f0-9]{64}$/);
  assert.equal(evaluatePrReadiness(ready(result.resolutions),120).ready,true);
});

test("local verifier process outcomes distinguish unavailable from definite failure",()=>{
  assert.equal(typecheckExecutionIsUnavailable({exitCode:null,ran:true}),true);
  assert.equal(typecheckExecutionIsUnavailable({exitCode:2,ran:true}),false);
  assert.equal(typecheckExecutionIsUnavailable({exitCode:2,ran:false,unrunnable:true}),true);
});

test("stale or unbound reviews cannot reconcile or persist lifecycle changes",()=>{
  const input={
    findings:[unavailable],repository:"o/r",pullRequestNumber:1292,candidateSha:candidate,ciSha:candidate,
    policyStatus:"readable",policyChecks:["TypeScript Check"],successfulChecks:["TypeScript Check"],observedAt:110,
    reviewDigest:boundReview.recordDigest,
  };
  const result=reconcileBoundLocalVerificationWithRemoteCi(false,input);
  assert.deepEqual(result.resolutions,[]);
  assert.deepEqual(result.unresolvedFindings,[unavailable]);
});

test("unavailable local typecheck remains blocking without trusted successful equivalent policy",()=>{
  const cases=[
    {policyChecks:["CI"],successfulChecks:["CI"]},
    {policyChecks:["TypeScript Lint"],successfulChecks:["TypeScript Lint"]},
    {policyChecks:["TypeScript Check"],successfulChecks:[]},
    {policyChecks:["TypeScript Check"],successfulChecks:["TypeScript Check"],ciSha:sha("e")},
    {policyStatus:"denied",policyChecks:["TypeScript Check"],successfulChecks:["TypeScript Check"]},
    {policyStatus:"indeterminate",policyChecks:["TypeScript Check"],successfulChecks:["TypeScript Check"]},
  ];
  for(const changed of cases){
    const result=reconcile(changed);
    assert.equal(result.unresolvedFindings.length,1,JSON.stringify(changed));
    assert.deepEqual(result.resolutions,[],JSON.stringify(changed));
  }
});

test("planner-invented or generic green check names cannot resolve local typecheck",()=>{
  for(const policyChecks of [["CI"],["TruffleHog"],["Tests"]]){
    const result=reconcile({policyChecks,successfulChecks:policyChecks,plannerChecks:["TypeScript Check"]});
    assert.equal(result.unresolvedFindings.length,1);
  }
});

test("real diagnostics and definite nonzero exits never resolve through generic or typecheck CI",()=>{
  const diagnostic=buildTypecheckFinding([{file:"src/x.ts",line:1,column:1,code:"TS2322",message:"bad"}],"typecheck");
  const nonzero=buildUnparsedTypecheckFailure({script:"typecheck",exitCode:2,outputTail:"compiler failed"});
  for(const finding of [diagnostic,nonzero]){
    const result=reconcile({findings:[finding]});
    assert.equal(result.unresolvedFindings.length,1);
    assert.deepEqual(result.resolutions,[]);
  }
});

test("resolution evidence is SHA-bound, publication-fresh, and digest-bound",()=>{
  const resolution=reconcile().resolutions[0];
  for(const changed of [
    resign({...resolution,candidateSha:sha("e")}),
    resign({...resolution,observedAt:99}),
    resign({...resolution,reviewDigest:sha("e",64)}),
    resign({...resolution,findingFingerprint:"other-finding"}),
    {...resolution,evidenceDigest:sha("e",64)},
  ]){
    const out=evaluatePrReadiness(ready([changed]),120);
    assert.equal(out.ready,false);
    assert.ok(out.failures.includes("verification_resolution_invalid"));
  }
});

test("strict readiness cannot drop a reviewed blocker without bound resolution evidence",()=>{
  const missing=evaluatePrReadiness(ready([]),120);
  assert.equal(missing.ready,false);
  assert.ok(missing.failures.includes("verification_resolution_invalid"));
  const resolution=reconcile().resolutions[0];
  const wrongCheck=resign({...resolution,remoteCheck:"CI"});
  const wrong=evaluatePrReadiness(ready([wrongCheck]),120);
  assert.equal(wrong.ready,false);
  assert.ok(wrong.failures.includes("verification_resolution_invalid"));
  const low={dimension:"quality",severity:"low",title:"aside",detail:"note",fingerprint:"unrelated-low"};
  const alternateReview=testReviewEvidence(candidate,"pass",{findings:[unavailable,low]});
  const unrelated=resign({...resolution,findingFingerprint:low.fingerprint,reviewDigest:alternateReview.recordDigest});
  const unrelatedInput={...ready([unrelated]),reviewEvidence:alternateReview,reviewFindings:[unavailable,low]};
  const unrelatedResult=evaluatePrReadiness(unrelatedInput,120);
  assert.equal(unrelatedResult.ready,false);
  assert.ok(unrelatedResult.failures.includes("verification_resolution_invalid"));
  const codeBlocker={...buildTypecheckFinding([{file:"src/x.ts",line:1,column:1,code:"TS2322",message:"bad"}],"typecheck"),fingerprint:"real-code-blocker"};
  const mixedReview=testReviewEvidence(candidate,"pass",{findings:[unavailable,codeBlocker]});
  const mixedResolution=resign({...resolution,reviewDigest:mixedReview.recordDigest});
  const underreported={...ready([mixedResolution]),reviewEvidence:mixedReview,reviewFindings:[unavailable,codeBlocker],reviewBlockingFindings:1};
  const underreportedResult=evaluatePrReadiness(underreported,120);
  assert.equal(underreportedResult.ready,false);
  assert.ok(underreportedResult.failures.includes("verification_resolution_invalid"));
});

test("remote-CI resolution is persisted as durable finding lifecycle evidence",()=>{
  const dir=mkdtempSync(join(tmpdir(),"verification-resolution-")),store=openStateStoreSync(join(dir,"state.db"));
  try{
    store.db.prepare(`INSERT INTO sessions (id,slack_thread,slack_channel,requester,requester_gh,repo,branch,worktree_path,status,created_at,updated_at,budget_usd,cost_usd,cycles_ran) VALUES ('S','T','C','U','u','o/r','b','/tmp/w','done',1,1,5,1,1)`).run();
    store.db.prepare(`INSERT INTO findings (session_id,fingerprint,state,severity,dimension,source,related_files,title,detail,first_seen_cycle,last_seen_cycle,created_at,updated_at) VALUES ('S',?,'environment_blocked','high','runtime','harness_env','[]',?,'unavailable',1,1,1,1)`).run(unavailable.fingerprint,unavailable.title);
    const resolution=reconcile().resolutions[0];
    persistVerificationResolutions(store.db,"S",[resolution]);
    assert.equal(store.db.prepare("SELECT state FROM findings WHERE session_id='S' AND fingerprint=?").get(unavailable.fingerprint).state,"resolved_by_remote_ci");
    const persisted=store.db.prepare("SELECT candidate_sha,evidence_json FROM verification_resolutions WHERE session_id='S'").get();
    assert.equal(persisted.candidate_sha,candidate);
    assert.equal(JSON.parse(persisted.evidence_json).evidenceDigest,resolution.evidenceDigest);
    const newer=resign({...resolution,observedAt:111});
    persistVerificationResolutions(store.db,"S",[newer]);
    const refreshed=store.db.prepare("SELECT evidence_digest,evidence_json FROM verification_resolutions WHERE session_id='S'").get();
    assert.equal(refreshed.evidence_digest,newer.evidenceDigest);
    assert.equal(JSON.parse(refreshed.evidence_json).observedAt,111);
    assert.equal(blocksMerge({...unavailable,lifecycleState:"resolved_by_remote_ci"},classifyFinding(unavailable)),false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("production reconciles findings before counting merge blockers and strict readiness",()=>{
  const index=readFileSync(resolve(import.meta.dirname,"../dist/index.js"),"utf8");
  const loop=readFileSync(resolve(import.meta.dirname,"../dist/orchestrator/legacy-loop.js"),"utf8");
  const reconcileAt=index.indexOf("reconcileBoundLocalVerificationWithRemoteCi(reviewBound, {");
  const blockingAt=index.indexOf("const blockingFindings = unresolvedFindings.filter",reconcileAt);
  const returnAt=index.indexOf("verificationResolutions: verificationReconciliation.resolutions",blockingAt);
  assert.ok(reconcileAt>0&&blockingAt>reconcileAt&&returnAt>blockingAt);
  assert.match(index,/findings: unresolvedFindings/);
  assert.match(loop,/return typecheckExecutionIsUnavailable\(r\)/);
});
