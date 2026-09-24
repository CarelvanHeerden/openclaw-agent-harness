import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStoreSync } from "../dist/state/store.js";
import { ControlRepository } from "../dist/control/repository.js";
import { createAuthorityEnvelope, authorityEnvelopeDigest } from "../dist/control/authority.js";
import { evaluatePrReadiness } from "../dist/control/readiness.js";
const d=(c,n=64)=>c.repeat(n);const roots=[];test.after(()=>roots.forEach(x=>rmSync(x,{recursive:true,force:true})));
function repo(){const dir=mkdtempSync(join(tmpdir(),"b129-"));roots.push(dir);const store=openStateStoreSync(join(dir,"state.db"));return{store,repository:new ControlRepository(store.db)};}
function envelope(){return createAuthorityEnvelope({version:1,requesterId:"U",conversationId:"C",repository:"o/r",baseRef:"main",briefDigest:d("a"),policyDigest:d("b"),scope:{paths:["src"]},allowedActions:["implement","test","commit"],limits:{budgetUsd:5,activeTimeMs:1000,cycles:2,retries:2},issuedAt:1,expiresAt:10000,nonce:"n"});}

test("beta129: a verified checkpoint survives repository reopen",()=>{const {store,repository}=repo();let run=repository.createRun({id:"chg",authority:envelope(),createdAt:10});run=repository.transition({runId:"chg",expectedVersion:run.version,to:"awaiting_confirmation",actor:"test",reason:"prepared",at:11});run=repository.transition({runId:"chg",expectedVersion:run.version,to:"autonomous_run",actor:"test",reason:"confirmed",at:12});const lease=repository.acquireLease("chg","worker",1000,13,authorityEnvelopeDigest(run.authorityEnvelope));repository.writeVerifiedCheckpoint("chg",lease,d("c",40),d("d"),14);const row=store.db.prepare("SELECT checkpoint_sha,authority_hash,payload_digest FROM control_verified_checkpoints WHERE run_id='chg'").get();assert.equal(row.checkpoint_sha,d("c",40));assert.equal(row.authority_hash,authorityEnvelopeDigest(run.authorityEnvelope));assert.equal(row.payload_digest,d("d"));store.close();});

test("beta129: stale lease fences cannot write recovery checkpoints",()=>{const {store,repository}=repo();let run=repository.createRun({id:"chg2",authority:envelope(),createdAt:10});run=repository.transition({runId:"chg2",expectedVersion:0,to:"awaiting_confirmation",actor:"t",reason:"p",at:11});run=repository.transition({runId:"chg2",expectedVersion:1,to:"autonomous_run",actor:"t",reason:"c",at:12});const hash=authorityEnvelopeDigest(run.authorityEnvelope);const old=repository.acquireLease("chg2","one",10,13,hash);repository.acquireLease("chg2","two",100,24,hash);assert.throws(()=>repository.writeVerifiedCheckpoint("chg2",old,d("c",40),d("d"),25),/stale_write/);store.close();});

const ready=(over={})=>{const h=d("e",40),r=d("f");return{finalVerdict:"pass",blockingFindings:0,reviewCompleted:true,verificationProbes:{completed:1,required:1,indeterminate:0},candidateSha:h,publication:{sha:h,observedAt:10},pullRequest:{repository:"o/r",baseRef:"main",headSha:h,open:true},expectedRepository:"o/r",expectedBaseRef:"main",requiredCi:{registered:true,requiredChecks:["test"],successfulChecks:["test"],sha:h,status:"success"},runtimeEvidence:{status:"not_required"},securityEvidence:{status:"pass",sha:h,observedAt:1},elapsedTimeMs:100,timeLimitMs:100,changedPaths:["src/x.ts"],allowedScope:["src/**"],excludedScope:[],operationsPerformed:["test"],operationReceipts:[{operation:"test",observedAt:1,source:"test-fixture"}],allowedOperations:["test"],credentialRouteDigest:r,expectedCredentialRouteDigest:r,secretExposure:{detected:false,evidence:"pass"},spendUsd:1,budgetUsd:2,...over};};

test("beta129: exact time limit is allowed but one millisecond over is terminal",()=>{assert.equal(evaluatePrReadiness(ready(),11).ready,true);const late=evaluatePrReadiness(ready({elapsedTimeMs:101}),11);assert.equal(late.state,"failed");assert.ok(late.failures.includes("elapsed_time_exceeded"));});

test("beta129: indeterminate recovery evidence cannot mint readiness",()=>{const r=evaluatePrReadiness(ready({runtimeEvidence:{status:"indeterminate"}}),11);assert.equal(r.ready,false);assert.ok(r.failures.includes("runtime_evidence_indeterminate"));});
