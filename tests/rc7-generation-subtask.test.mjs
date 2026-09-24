import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const service=readFileSync(new URL("../src/control/service.ts",import.meta.url),"utf8");const migrations=readFileSync(new URL("../src/state/migrations.ts",import.meta.url),"utf8");
test("one durable dispatch intent replaces public generation/subtask controls",()=>{assert.match(migrations,/CREATE TABLE control_dispatch_intents/);assert.match(migrations,/lease_fence INTEGER NOT NULL DEFAULT 0/);assert.match(migrations,/attempts INTEGER NOT NULL DEFAULT 0/);assert.match(service,/lease_fence=lease_fence\+1/);});
test("only the current fenced dispatch may publish readiness",()=>{assert.match(service,/assertCurrent\(\)/);assert.match(service,/stale_dispatch/);assert.match(service,/control_readiness_attestations/);assert.match(service,/generation=p\.generation\+1/);});
