import test from "node:test";
import assert from "node:assert/strict";
import { allowedControlTransitions, isTerminalControlState } from "../dist/control/state-machine.js";
import { readFileSync } from "node:fs";
const registration=readFileSync(new URL("../src/tools/registration.ts",import.meta.url),"utf8");
test("retired cancel/resume commands are absent from the four-tool surface",()=>{for(const name of ["harness_cancel","harness_resume","harness_answer","harness_progress"])assert.doesNotMatch(registration,new RegExp(`[\"']${name}[\"']`));});
test("terminal runs cannot be resumed through state transitions",()=>{for(const s of ["done","failed","cancelled"]){assert.equal(isTerminalControlState(s),true);assert.deepEqual(allowedControlTransitions(s),[]);}});
test("recovery is internal and limited to durable dispatch intents",()=>{const service=readFileSync(new URL("../src/control/service.ts",import.meta.url),"utf8");assert.match(service,/recoverDispatches/);assert.match(service,/control_dispatch_intents/);assert.match(service,/stale_dispatch/);});
