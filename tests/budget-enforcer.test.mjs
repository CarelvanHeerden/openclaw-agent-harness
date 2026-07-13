import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let openStateStore, BudgetEnforcer;
try {
  ({ openStateStore } = await import("../dist/state/store.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
} catch {
  openStateStore = null;
  BudgetEnforcer = null;
}

const cfg = {
  monthly_per_user_usd: 1000,
  session_default_usd: 50,
  session_hard_ceiling_usd: 200,
  daily_warn_usd: 100,
  monthly_warn_ratio: 0.8,
};

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "oah-test-"));
  const path = join(dir, "state.db");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("BudgetEnforcer: fresh user can start default session",
  { skip: openStateStore === null },
  async () => {
    const { path, cleanup } = makeStore();
    const store = await openStateStore(path);
    const be = new BudgetEnforcer(cfg, store);
    const check = await be.canStartSession("U_TEST", 0);
    assert.equal(check.ok, true);
    assert.equal(check.remainingSessionUsd, 50);
    assert.equal(check.remainingMonthlyUsd, 1000);
    store.close();
    cleanup();
  });

test("BudgetEnforcer: requested budget is clamped by session ceiling",
  { skip: openStateStore === null },
  async () => {
    const { path, cleanup } = makeStore();
    const store = await openStateStore(path);
    const be = new BudgetEnforcer(cfg, store);
    const check = await be.canStartSession("U_TEST", 500); // above 200 ceiling
    assert.equal(check.ok, true);
    assert.equal(check.remainingSessionUsd, 200);
    store.close();
    cleanup();
  });

test("BudgetEnforcer: monthly cap refusal",
  { skip: openStateStore === null },
  async () => {
    const { path, cleanup } = makeStore();
    const store = await openStateStore(path);
    const be = new BudgetEnforcer(cfg, store);
    await be.recordSpend("U_TEST", 1000, "S1");
    const check = await be.canStartSession("U_TEST", 50);
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /Monthly budget exhausted/);
    store.close();
    cleanup();
  });

test("BudgetEnforcer: recordSpend is additive across calls",
  { skip: openStateStore === null },
  async () => {
    const { path, cleanup } = makeStore();
    const store = await openStateStore(path);
    const be = new BudgetEnforcer(cfg, store);
    await be.recordSpend("U_TEST", 10, "S1");
    await be.recordSpend("U_TEST", 15, "S1");
    const check = await be.canStartSession("U_TEST", 0);
    assert.equal(check.remainingMonthlyUsd, 975);
    store.close();
    cleanup();
  });
