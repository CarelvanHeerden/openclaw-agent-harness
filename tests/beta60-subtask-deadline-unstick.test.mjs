// beta.60 restored: dead-executor recovery is durable dispatch lease recovery, not force-resume interaction.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStoreSync } from "../dist/state/store.js";
import { ControlRepository } from "../dist/control/repository.js";
import { createAuthorityEnvelope } from "../dist/control/authority.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const sha=(c)=>c.repeat(64);
const authority=()=>createAuthorityEnvelope({version:1,requesterId:"U1",conversationId:"C1",repository:"a/r",baseRef:"main",briefDigest:sha("a"),policyDigest:sha("b"),scope:{paths:["src"]},allowedActions:["implement"],limits:{budgetUsd:2,activeTimeMs:100,cycles:1,retries:1},issuedAt:1,expiresAt:1000,nonce:"n"});

test("beta60: expired ownership is replaced by a monotonically higher fence",()=>{
  const dir=mkdtempSync(join(tmpdir(),"b60-"));const store=openStateStoreSync(join(dir,"s.db"));
  try{const repo=new ControlRepository(store.db);repo.createRun({id:"r1",authority:authority()});const first=repo.acquireLease("r1","dead",10,100);assert.equal(first.fence,1);assert.equal(repo.acquireLease("r1","replacement",10,105),null);const second=repo.acquireLease("r1","replacement",10,111);assert.equal(second.fence,2);assert.equal(repo.validateLease(first,112),false);assert.equal(repo.validateLease(second,112),true);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("beta60: stale owner cannot renew, release, or write after replacement",()=>{
  const dir=mkdtempSync(join(tmpdir(),"b60-"));const store=openStateStoreSync(join(dir,"s.db"));
  try{const repo=new ControlRepository(store.db);repo.createRun({id:"r2",authority:authority()});const first=repo.acquireLease("r2","dead",10,100,sha("e"));repo.acquireLease("r2","new",10,111,sha("e"));assert.equal(repo.renewLease("r2","dead",first.fence,10,112),false);assert.equal(repo.releaseLease("r2","dead",first.fence,112),false);assert.throws(()=>repo.writeVerifiedCheckpoint("r2",first,"c".repeat(40),sha("d"),112),/stale_write/);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("beta60: service recovers pending/expired dispatches and public force-resume is gone",()=>{
  const service=readFileSync(resolve(root,"src/control/service.ts"),"utf8");const reg=readFileSync(resolve(root,"src/tools/registration.ts"),"utf8");
  assert.match(service,/status='pending' OR \(status='running' AND lease_expires_at<\?\)/);
  assert.match(service,/recoverDispatches/);assert.doesNotMatch(reg,/harness_resume|force:\s*\{\s*type:\s*"boolean"/);
});
