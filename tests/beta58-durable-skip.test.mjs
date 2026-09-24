// beta.58 restored: keep pure finding-line hygiene; scope decisions are immutable authority, not skip interactions.
import test from "node:test";
import assert from "node:assert/strict";
import { removeOwningFindingLines } from "../dist/orchestrator/finding-hygiene.js";
import { createAuthorityEnvelope, evaluateAuthority } from "../dist/control/authority.js";
const sha=(c)=>c.repeat(64);

test("beta58: removeOwningFindingLines drops only the strongly owned numbered finding",()=>{
  const lines=["Address each adversary finding","6. [medium] Add response validation","10. [low] Rename grc directories to governance-risk naming -- CONDITIONAL PREMISE","--- original criteria ---","The dropdown shows values"];
  const {kept,dropped}=removeOwningFindingLines(lines,"Consolidate module dirs to governance-risk naming (finding 10 rename)","Rename src/lib/grc to src/lib/governance-risk");
  assert.equal(dropped.length,1);assert.match(dropped[0],/^10\./);assert.ok(kept.some(x=>x.startsWith("6.")));assert.ok(kept.some(x=>x.includes("original criteria")));
});

test("beta58: weak overlap and empty paused content never delete unrelated criteria",()=>{
  const lines=["3. [high] Add validation","7. [medium] Wire ErrorState"];
  assert.deepEqual(removeOwningFindingLines(lines,"aria label","accessible select").dropped,[]);
  assert.deepEqual(removeOwningFindingLines(lines,"","").kept,lines);
});

test("beta58: an out-of-scope path terminates instead of opening a skip dialogue",()=>{
  const env=createAuthorityEnvelope({version:1,requesterId:"U1",conversationId:"C1",repository:"a/r",baseRef:"main",briefDigest:sha("a"),policyDigest:sha("b"),scope:{paths:["src/allowed"]},allowedActions:["repair"],limits:{budgetUsd:2,activeTimeMs:100,cycles:1,retries:1},issuedAt:1,expiresAt:1000,nonce:"n"});
  const out=evaluateAuthority(env,{requesterId:"U1",conversationId:"C1",repository:"a/r",baseRef:"main",briefDigest:sha("a"),policyDigest:sha("b"),nonce:"n",action:"repair",paths:["src/other/x.ts"],projectedBudgetUsd:1,projectedActiveTimeMs:10,projectedCycles:1,projectedRetries:0,now:10});
  assert.deepEqual(out,{outcome:"terminate",reason:"path_out_of_scope"});
});
