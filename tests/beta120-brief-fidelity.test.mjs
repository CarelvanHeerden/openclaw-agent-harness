import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorityEnvelope, authorityEnvelopeDigest, evaluateAuthority } from "../dist/control/authority.js";
import { controlDigest, CONFIRM_DOMAIN } from "../dist/control/service.js";
const digest=c=>c.repeat(64);
const envelope=()=>createAuthorityEnvelope({version:1,requesterId:"U1",conversationId:"W:C:T",repository:"o/r",baseRef:"main",briefDigest:digest("a"),policyDigest:digest("b"),scope:{paths:["src","tests"]},allowedActions:["implement","test","commit","push_feature_branch","open_pull_request"],limits:{budgetUsd:12,activeTimeMs:3600000,cycles:3,retries:2},issuedAt:100,expiresAt:1000,nonce:"n-1"});
const request=(over={})=>({requesterId:"U1",conversationId:"W:C:T",repository:"o/r",baseRef:"main",briefDigest:digest("a"),policyDigest:digest("b"),nonce:"n-1",action:"test",paths:["tests/x.test.ts"],projectedBudgetUsd:1,projectedActiveTimeMs:100,projectedCycles:1,projectedRetries:0,now:200,...over});

test("beta120: canonical proposal bindings are order-stable and domain-separated",()=>{const a=controlDigest(CONFIRM_DOMAIN,{repository:"o/r",baseRevision:"1",scope:["src/**"],timeLimitMs:1000});const b=controlDigest(CONFIRM_DOMAIN,{timeLimitMs:1000,scope:["src/**"],baseRevision:"1",repository:"o/r"});assert.equal(a,b);assert.notEqual(a,controlDigest("other-domain",{repository:"o/r",baseRevision:"1",scope:["src/**"],timeLimitMs:1000}));});

test("beta120: the authority envelope is immutable after creation",()=>{const e=envelope();assert.ok(Object.isFrozen(e));assert.ok(Object.isFrozen(e.scope));assert.ok(Object.isFrozen(e.scope.paths));assert.ok(Object.isFrozen(e.limits));assert.equal(authorityEnvelopeDigest(e).length,64);});

test("beta120: changing base, brief or policy invalidates the confirmed envelope",()=>{for(const [field,value,reason] of [["baseRef","release","base_ref_mismatch"],["briefDigest",digest("c"),"brief_digest_mismatch"],["policyDigest",digest("d"),"policy_digest_mismatch"]]){assert.deepEqual(evaluateAuthority(envelope(),request({[field]:value})),{outcome:"terminate",reason});}});

test("beta120: scope, budget and time cannot expand after confirmation",()=>{const cases=[[{paths:["docs/x.md"]},"path_out_of_scope"],[{projectedBudgetUsd:12.01},"budget_expansion"],[{projectedActiveTimeMs:3600001},"time_expansion"]];for(const [over,reason] of cases)assert.deepEqual(evaluateAuthority(envelope(),request(over)),{outcome:"terminate",reason});});

test("beta120: the exact bounded request remains authorized",()=>{assert.deepEqual(evaluateAuthority(envelope(),request()),{outcome:"approve",reason:"in_envelope"});});
