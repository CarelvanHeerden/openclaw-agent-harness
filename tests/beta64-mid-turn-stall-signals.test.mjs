import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { CONTROL_RECOVERY_CONTRACT } = await import("../dist/orchestrator/loop.js");
test("canonical recovery exposes durable lease and checkpoint signals instead of public mid-turn polling",()=>{assert.equal(CONTROL_RECOVERY_CONTRACT.verified_checkpoint,true);assert.equal(CONTROL_RECOVERY_CONTRACT.lease_owner,true);assert.equal(CONTROL_RECOVERY_CONTRACT.lease_expires_at,true);assert.equal(CONTROL_RECOVERY_CONTRACT.lease_generation,true);});
test("ordinary registration contains no progress or resume interaction",()=>{const s=readFileSync(new URL("../src/tools/registration.ts",import.meta.url),"utf8");assert.doesNotMatch(s,/name:\s*["']harness_(progress|resume)["']/);assert.match(s,/harness_change_result/);});
