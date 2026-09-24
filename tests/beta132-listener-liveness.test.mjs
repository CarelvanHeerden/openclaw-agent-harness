// Restored beta.132 coverage: listener liveness is retired; durable dispatch fencing owns recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const service = readFileSync(resolve(root, "src/control/service.ts"), "utf8");
const registration = readFileSync(resolve(root, "src/tools/registration.ts"), "utf8");

test("beta132: dispatch ownership is durable, leased, and recovered without a listener heartbeat", () => {
  for (const token of ["control_dispatch_intents", "lease_owner", "lease_fence", "lease_expires_at", "recoverDispatches"]) {
    assert.match(service, new RegExp(token));
  }
  assert.match(service, /queueMicrotask\(\(\)=>\{void this\.recoverDispatches\(\);void this\.deps\.mergeService\.recoverPending\(\);\}\)/);
  assert.doesNotMatch(service, /clarification_heartbeat|listenerLooksAlive|time_extension/);
});

test("beta132: a superseded dispatch cannot publish a late completion", () => {
  assert.match(service, /const assertCurrent=/);
  assert.match(service, /stale_dispatch/);
  assert.match(service, /validateLease/);
  assert.match(service, /WHERE run_id=\? AND lease_owner=\? AND lease_fence=\?/);
});

test("beta132: retired answer/resume interactions are absent from the public catalog", () => {
  for (const retired of ["harness_answer", "harness_resume", "harness_progress"]) {
    assert.doesNotMatch(registration, new RegExp(`name:\\s*["']${retired}`));
  }
});
