import test from "node:test";
import assert from "node:assert/strict";
import { CONTROL_STATES } from "../dist/control/types.js";
import { allowedControlTransitions, canTransitionControlState } from "../dist/control/state-machine.js";
import { sessionScopedBranch } from "../dist/orchestrator/lead.js";
import { decideEngineAuthority } from "../dist/control/engine.js";
import { createAuthorityEnvelope } from "../dist/control/authority.js";
const d=c=>c.repeat(64);
const authority=createAuthorityEnvelope({version:1,requesterId:"U",conversationId:"C",repository:"o/r",baseRef:"main",briefDigest:d("a"),policyDigest:d("b"),scope:{paths:["src"]},allowedActions:["implement","test"],limits:{budgetUsd:5,activeTimeMs:1000,cycles:1,retries:1},issuedAt:1,expiresAt:100,nonce:"n"});
const run={id:"chg",state:"autonomous_run",version:2,requesterId:"U",conversationId:"C",repository:"o/r",baseRef:"main",briefDigest:d("a"),policyDigest:d("b"),authorityEnvelope:authority,createdAt:1,updatedAt:2};
const request=(over={})=>({requesterId:"U",conversationId:"C",repository:"o/r",baseRef:"main",briefDigest:d("a"),policyDigest:d("b"),nonce:"n",action:"implement",paths:["src/x.ts"],projectedBudgetUsd:1,projectedActiveTimeMs:10,projectedCycles:1,projectedRetries:0,now:3,...over});

test("beta122: canonical state vocabulary contains no clarification, pause or resume state",()=>{assert.deepEqual(CONTROL_STATES,["draft","awaiting_confirmation","autonomous_run","pr_ready","awaiting_merge","done","failed","cancelled"]);assert.ok(!CONTROL_STATES.some(x=>/clarif|pause|resume|input/i.test(x)));});

test("beta122: running can only become ready, failed or cancelled",()=>{assert.deepEqual([...allowedControlTransitions("autonomous_run")],["pr_ready","failed","cancelled"]);assert.equal(canTransitionControlState("autonomous_run","awaiting_confirmation"),false);});

test("beta122: an in-envelope repair continues autonomously",()=>{const decision=decideEngineAuthority(run,{kind:"repair",request:request()});assert.deepEqual(decision,{outcome:"continue",kind:"repair",auditCode:"autonomous_in_envelope"});});

test("beta122: broader scope becomes terminal escalation, not a question",()=>{const decision=decideEngineAuthority(run,{kind:"replan",request:request({paths:["docs/x.md"]})});assert.deepEqual(decision,{outcome:"terminate",code:"path_violation",reason:"path_out_of_scope"});});

test("beta122: branch identity is stable and session-isolated",()=>{const one=sessionScopedBranch("harness/change","abc12345-rest");assert.equal(sessionScopedBranch(one,"abc12345-rest"),one);assert.notEqual(one,sessionScopedBranch("harness/change","def67890-rest"));});
