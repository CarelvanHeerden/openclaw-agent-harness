import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { evaluatePrReadiness } from "../dist/control/readiness.js";
import { isExactReviewedPublishedHead, reviewFindingsDigest, reviewRecordDigest } from "../dist/control/review-evidence.js";
import { deriveMergeRecommendation } from "../dist/orchestrator/merge-recommendation.js";
import { openStateStoreSync } from "../dist/state/store.js";

const sha=(c,n=40)=>c.repeat(n);
const candidate=sha("c"),baseSha=sha("a"),route=sha("d",64),runId="chg_review_readiness";
const root=resolve(import.meta.dirname,"..");

function reviewEvidence({verdict="pass",findings=[],cycle=1,reviewSha=candidate,reviewBase=baseSha}={}){
  const findingsJson=JSON.stringify(findings),findingsDigest=reviewFindingsDigest(findingsJson);
  const record={runId,cycle,baseSha:reviewBase,candidateSha:reviewSha,verdict,findingsDigest,completed:true};
  return {
    recordId:`${runId}-r${cycle}`,expectedRecordId:`${runId}-r${cycle}`,
    runId,expectedRunId:runId,cycle,expectedCycle:cycle,baseSha:reviewBase,expectedBaseSha:baseSha,
    candidateSha:reviewSha,expectedCandidateSha:candidate,completed:true,verdict,
    findingsDigest,computedFindingsDigest:findingsDigest,
    recordDigest:reviewRecordDigest(record),computedRecordDigest:reviewRecordDigest(record),
  };
}

function ready(over={}){
  return {
    finalVerdict:"pass",blockingFindings:0,reviewCompleted:true,reviewEvidence:reviewEvidence(),
    verificationProbes:{completed:1,required:1,indeterminate:0},
    candidateSha:candidate,publication:{sha:candidate,observedAt:100},
    pullRequest:{repository:"o/r",baseRef:"main",headSha:candidate,open:true,number:7,url:"https://example/pr/7"},
    expectedRepository:"o/r",expectedBaseRef:"main",
    requiredCi:{registered:true,requiredChecks:["CI","Secret Scan"],successfulChecks:["CI","Secret Scan"],sha:candidate,status:"success"},
    runtimeEvidence:{status:"not_required"},securityEvidence:{status:"pass",sha:candidate,observedAt:110},
    elapsedTimeMs:10,timeLimitMs:1000,changedPaths:["README.md"],allowedScope:["README.md"],excludedScope:[],
    operationsPerformed:["test"],operationReceipts:[{operation:"test",observedAt:110,sha:candidate,source:"fixture"}],
    allowedOperations:["test"],credentialRouteDigest:route,expectedCredentialRouteDigest:route,
    secretExposure:{detected:false,evidence:"pass"},spendUsd:1,budgetUsd:5,...over,
  };
}

test("passing exact-SHA review remains pass after late CI success regardless of the earlier recommendation",()=>{
  const review={verdict:"pass",findings:[]};
  const before=deriveMergeRecommendation({review,reachedCleanPass:true,blockingFindings:0,ciStatus:"pending"});
  assert.equal(before.recommendation,"do_not_merge");
  const after=deriveMergeRecommendation({review,reachedCleanPass:true,blockingFindings:0,ciStatus:"success"});
  assert.equal(after.recommendation,"merge");
  assert.equal(evaluatePrReadiness(ready(),120).ready,true);
});

test("recommendation evidence cannot combine an old reviewed SHA with CI from a newer PR head",()=>{
  assert.equal(isExactReviewedPublishedHead(candidate,candidate,candidate),true);
  assert.equal(isExactReviewedPublishedHead(candidate,candidate,sha("e")),false);
  assert.equal(isExactReviewedPublishedHead(candidate,sha("e"),candidate),false);
});

test("passing review attributes CI failure and indeterminate CI to CI, not review",()=>{
  for(const status of ["failure","pending","indeterminate"]){
    const out=evaluatePrReadiness(ready({requiredCi:{registered:true,requiredChecks:["CI"],successfulChecks:[],sha:candidate,status}}),120);
    assert.equal(out.ready,false);
    assert.ok(out.failures.includes("required_ci_not_green"));
    assert.ok(!out.failures.includes("review_not_passed"));
  }
});

test("revise review remains a review failure even with green CI",()=>{
  const evidence=reviewEvidence({verdict:"revise"});
  const out=evaluatePrReadiness(ready({finalVerdict:"revise",reviewEvidence:evidence}),120);
  assert.equal(out.ready,false);
  assert.ok(out.failures.includes("review_not_passed"));
  assert.ok(!out.failures.includes("required_ci_not_green"));
});

test("contradictory projected and authoritative verdicts fail explicitly",()=>{
  const out=evaluatePrReadiness(ready({finalVerdict:"revise"}),120);
  assert.equal(out.ready,false);
  assert.ok(out.failures.includes("review_verdict_inconsistent"));
  assert.ok(!out.failures.includes("review_not_passed"));
});

test("a passing review with blocking findings is inconsistent and fails closed",()=>{
  const out=evaluatePrReadiness(ready({blockingFindings:1}),120);
  assert.equal(out.ready,false);
  assert.ok(out.failures.includes("review_verdict_inconsistent"));
  assert.ok(out.failures.includes("blocking_findings"));
});

test("review evidence bound to another candidate SHA is stale",()=>{
  const out=evaluatePrReadiness(ready({reviewEvidence:reviewEvidence({reviewSha:sha("e")})}),120);
  assert.equal(out.ready,false);
  assert.ok(out.failures.includes("review_evidence_stale"));
});

test("missing authoritative review evidence fails closed",()=>{
  const input=ready();delete input.reviewEvidence;
  const out=evaluatePrReadiness(input,120);
  assert.equal(out.ready,false);
  assert.ok(out.failures.includes("review_evidence_stale"));
});

test("every authoritative review binding and digest fails closed when changed",()=>{
  const cases=[
    {recordId:"other"},{runId:"other"},{cycle:2},{baseSha:sha("e")},{candidateSha:sha("e")},
    {completed:false},{findingsDigest:sha("e",64)},{recordDigest:sha("e",64)},
  ];
  for(const changed of cases){
    const out=evaluatePrReadiness(ready({reviewEvidence:{...reviewEvidence(),...changed}}),120);
    assert.equal(out.ready,false,JSON.stringify(changed));
    assert.ok(out.failures.includes("review_evidence_stale"),JSON.stringify(changed));
  }
});

test("production projection never derives review verdict from merge policy and refreshes policy from final CI",()=>{
  const index=readFileSync(resolve(root,"dist/index.js"),"utf8");
  const loop=readFileSync(resolve(root,"dist/orchestrator/legacy-loop.js"),"utf8");
  const schema=readFileSync(resolve(root,"dist/state/schema.sql"),"utf8");
  assert.match(index,/finalVerdict:\s*reviewVerdict/);
  assert.doesNotMatch(index,/finalVerdict:[^\n]*merge_recommendation/);
  assert.match(index,/control\.merge_recommendation_refreshed/);
  assert.match(index,/UPDATE sessions SET merge_recommendation=\?,merge_recommendation_reason=\?,updated_at=\?/);
  assert.match(index,/expectedCycle:\s*Number\(row\.final_review_cycle \?\? -1\)/);
  assert.match(loop,/ciStatus:\s*finalCiStatus/);
  assert.match(loop,/final_review_cycle = \?/);
  assert.match(loop,/INSERT INTO reviews \(id, session_id, cycle, verdict, findings, summary, cost_usd, sdk_session_id, base_sha, candidate_sha, findings_digest, review_digest, completed, created_at\)/);
  assert.match(loop,/worktreeHeadSha\(worktreePath\)/);
  const preReviewAuthor=loop.indexOf('stage: "pre_review"');
  const saveReview=loop.indexOf("await this.saveReview(");
  const publish=loop.indexOf("await this.publishCandidate(");
  assert.ok(preReviewAuthor>=0&&preReviewAuthor<saveReview);
  assert.ok(saveReview>=0&&saveReview<publish);
  assert.equal(loop.slice(saveReview,publish).includes("ciAuthorWorkflow"),false);
  assert.match(schema,/candidate_sha TEXT/);
  assert.match(schema,/final_review_cycle\s+INTEGER/);
});

test("review binding columns migrate durably onto existing state stores",()=>{
  const dir=mkdtempSync(join(tmpdir(),"review-evidence-"));
  const store=openStateStoreSync(join(dir,"state.db"));
  try{
    const columns=new Set(store.db.prepare("PRAGMA table_info(reviews)").all().map((row)=>row.name));
    for(const name of ["base_sha","candidate_sha","findings_digest","review_digest","completed"])assert.ok(columns.has(name),name);
    const sessionColumns=new Set(store.db.prepare("PRAGMA table_info(sessions)").all().map((row)=>row.name));
    assert.ok(sessionColumns.has("final_review_cycle"));
    assert.equal(store.db.prepare("SELECT value FROM control_metadata WHERE key='control_plane_schema_version'").get().value,"13");
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
