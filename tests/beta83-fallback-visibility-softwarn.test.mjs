import test from "node:test";
import assert from "node:assert/strict";
const { buildTerminalReport } = await import("../dist/control/report.js");
const { TERMINAL_AUTHORITY_CODES } = await import("../dist/control/engine.js");
test("canonical failures are terminal and visible rather than soft-warning fallbacks",()=>{for(const c of ["budget_exceeded","time_exceeded","scope_escalation","path_violation"])assert.ok(TERMINAL_AUTHORITY_CODES.includes(c));const r=buildTerminalReport({runId:"r",state:"failed",code:"authority_violation"});assert.equal(r.kind,"terminal");assert.match(r.message,/ended without completing/);});
