import test from "node:test";
import assert from "node:assert/strict";
const { controlDigest, CONFIRM_DOMAIN } = await import("../dist/control/service.js");
test("credential routing is bound hierarchically into confirmation digests",()=>{const base={changeId:"c",repository:"o/r",credentialRouteDigest:"a".repeat(64)};assert.notEqual(controlDigest(CONFIRM_DOMAIN,base),controlDigest(CONFIRM_DOMAIN,{...base,credentialRouteDigest:"b".repeat(64)}));});
test("provider labels cannot substitute for the resolved credential route",()=>{assert.notEqual(controlDigest(CONFIRM_DOMAIN,{route:"github"}),controlDigest(CONFIRM_DOMAIN,{route:"vault://github/o/r/U1"}));});
