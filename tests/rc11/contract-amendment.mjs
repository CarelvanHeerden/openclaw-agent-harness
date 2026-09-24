import test from "node:test";
import assert from "node:assert/strict";
import { controlDigest, CONFIRM_DOMAIN } from "../../dist/control/service.js";
const base={changeId:"chg_abcdefghijkl",version:1,repository:"o/r",baseRef:"main",baseRevision:"a".repeat(40),briefDigest:"b".repeat(64),policyDigest:"c".repeat(64),scope:'["src/**"]',excludedScope:'[".env*"]',credentialRouteDigest:"d".repeat(64),budgetUsd:20,timeLimitMs:3600000,proposalExpiresAt:9999};
test("confirmation binds the complete immutable contract",()=>{const a=controlDigest(CONFIRM_DOMAIN,base);for(const [k,v] of [["scope",'["docs/**"]'],["excludedScope","[]"],["budgetUsd",21],["timeLimitMs",3600001],["briefDigest","e".repeat(64)]])assert.notEqual(controlDigest(CONFIRM_DOMAIN,{...base,[k]:v}),a,k);});
test("binding is deterministic independent of object key order",()=>{const reversed=Object.fromEntries(Object.entries(base).reverse());assert.equal(controlDigest(CONFIRM_DOMAIN,base),controlDigest(CONFIRM_DOMAIN,reversed));});
