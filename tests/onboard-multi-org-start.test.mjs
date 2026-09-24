import test from "node:test";
import assert from "node:assert/strict";
const { controlDigest, CONFIRM_DOMAIN } = await import("../dist/control/service.js");
test("distinct org credential routes produce distinct confirmation bindings",()=>{const a=controlDigest(CONFIRM_DOMAIN,{repository:"acme/a",credentialRouteDigest:"1".repeat(64)});const b=controlDigest(CONFIRM_DOMAIN,{repository:"other/a",credentialRouteDigest:"2".repeat(64)});assert.notEqual(a,b);});
test("the canonical public surface does not expose a DM onboarding start action",async()=>{const {registerHarnessTools}=await import("../dist/tools/registration.js");const defs=[];registerHarnessTools({registerTool:d=>{defs.push(d);return()=>{}}},{});assert.equal(defs.some(d=>d.name==="harness_onboard"),false);});
