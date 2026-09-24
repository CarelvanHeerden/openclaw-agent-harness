import test from "node:test";
import assert from "node:assert/strict";
import { controlDigest, CONFIRM_DOMAIN } from "../dist/control/service.js";
const att={actorIdentity:"U1",conversationIdentity:"W:C:T",hostEventId:"E1",nonce:"N1",issuedAt:20,expiresAt:40};const proposal={changeId:"chg_abcdefghijkl",version:1,repository:"o/r",baseRef:"main",baseRevision:"a".repeat(40),briefDigest:"b".repeat(64),policyDigest:"c".repeat(64),scope:'["src/**"]',excludedScope:"[]",credentialRouteDigest:"d".repeat(64),budgetUsd:60,timeLimitMs:36000000,proposalExpiresAt:100,...att};
test("typed host approval binds exact budget and time",()=>{const expected=controlDigest(CONFIRM_DOMAIN,proposal);assert.notEqual(controlDigest(CONFIRM_DOMAIN,{...proposal,budgetUsd:50}),expected);assert.notEqual(controlDigest(CONFIRM_DOMAIN,{...proposal,timeLimitMs:18000000}),expected);});
test("typed approval also binds actor conversation event and nonce",()=>{const expected=controlDigest(CONFIRM_DOMAIN,proposal);for(const k of ["actorIdentity","conversationIdentity","hostEventId","nonce"])assert.notEqual(controlDigest(CONFIRM_DOMAIN,{...proposal,[k]:"other"}),expected,k);});
