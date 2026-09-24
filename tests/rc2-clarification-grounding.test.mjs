import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const service=readFileSync(new URL("../src/control/service.ts",import.meta.url),"utf8");
test("prepare never exposes or persists an unresolved proposal pause",()=>{assert.doesNotMatch(service,/The request has an unresolved product decision and must be prepared again/);assert.doesNotMatch(service,/proposal_not_confirmable/);assert.doesNotMatch(service,/kind === "clarify"/);assert.match(service,/confirmable:\s*true/);});
test("result surface never returns unresolved question or brief bodies",()=>{const start=service.indexOf("result(changeId");const end=service.indexOf("async merge(",start);const body=service.slice(start,end);assert.doesNotMatch(body,/brief_json|assumptions_json|question|prompt/);assert.match(body,/change_not_found/);});
