import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const service=readFileSync(new URL("../src/control/service.ts",import.meta.url),"utf8");
test("prepare is the only proposal operation and never dispatches",()=>{const start=service.indexOf("async prepare(");const end=service.indexOf("async confirm(",start);const body=service.slice(start,end);assert.match(body,/control_proposals/);assert.doesNotMatch(body,/this\.dispatch\(/);assert.match(body,/confirmable/);});
test("unresolved crystallisation is durable but not confirmable",()=>{assert.match(service,/crystallised\.kind===\"brief\"/);assert.match(service,/No implementation may start until the unresolved decision is supplied/);assert.match(service,/proposal_not_confirmable/);});
test("proposal limits are bounded before publication",()=>{assert.match(service,/Math\.min\(input\.budgetUsd/);assert.match(service,/Math\.min\(input\.timeLimitSeconds/);assert.match(service,/budget:\{currency:\"USD\",maximum:budget\.toFixed\(2\)\}/);});
