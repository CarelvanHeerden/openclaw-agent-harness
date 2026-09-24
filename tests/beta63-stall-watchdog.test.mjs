import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { openStateStoreSync } = await import("../dist/state/store.js");
const { ControlRepository } = await import("../dist/control/repository.js");
const { createAuthorityEnvelope } = await import("../dist/control/authority.js");
const sha=c=>c.repeat(64);
const envelope=()=>createAuthorityEnvelope({version:1,requesterId:"U1",conversationId:"C1",repository:"acme/repo",baseRef:"main",briefDigest:sha("a"),policyDigest:sha("b"),scope:{paths:["src"]},allowedActions:["implement","repair"],limits:{budgetUsd:10,activeTimeMs:1000,cycles:2,retries:1},issuedAt:1,expiresAt:10000,nonce:"n"});
function store(fn){const d=mkdtempSync(join(tmpdir(),"stall-control-"));const s=openStateStoreSync(join(d,"state.db"));try{return fn(s)}finally{s.close();rmSync(d,{recursive:true,force:true})}}
test("expired executors are recovered by a monotonically fenced lease, never by a public resume interaction",()=>store(({db})=>{const r=new ControlRepository(db);let run=r.createRun({id:"r",authority:envelope()});run=r.transition({runId:"r",expectedVersion:0,to:"awaiting_confirmation",actor:"system",reason:"prepared"});run=r.transition({runId:"r",expectedVersion:1,to:"autonomous_run",actor:"host",reason:"confirmed"});const old=r.acquireLease("r","dead",10,100);assert.equal(r.acquireLease("r","other",10,105),null);const recovered=r.acquireLease("r","other",10,111,old.authorityHash);assert.equal(recovered.fence,2);assert.equal(r.validateLease(old,112),false);assert.equal(r.validateLease(recovered,112),true);}));
test("terminal control states cannot wedge back into execution",async()=>{const {allowedControlTransitions}=await import("../dist/control/state-machine.js");for(const s of ["done","failed","cancelled"])assert.deepEqual(allowedControlTransitions(s),[]);});
