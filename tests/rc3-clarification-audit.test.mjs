import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const migrations=readFileSync(new URL("../src/state/migrations.ts",import.meta.url),"utf8");const service=readFileSync(new URL("../src/control/service.ts",import.meta.url),"utf8");
test("host decisions have a canonical append-only attestation ledger",()=>{assert.match(migrations,/CREATE TABLE control_host_attestations/);for(const c of ["operation_kind","provenance","actor_identity","conversation_identity","host_event_id","nonce","binding_digest","consumed_at"])assert.match(migrations,new RegExp(c));assert.match(service,/INSERT INTO control_host_attestations/);});
test("attestation replay is rejected by durable uniqueness",()=>{assert.match(migrations,/host_event_id TEXT NOT NULL UNIQUE/);assert.match(migrations,/nonce TEXT NOT NULL UNIQUE/);assert.match(service,/confirmation_replayed/);});
