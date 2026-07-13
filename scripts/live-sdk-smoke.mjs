#!/usr/bin/env node
/**
 * LIVE SDK smoke test.
 *
 * Actually calls @anthropic-ai/claude-agent-sdk against a real Anthropic API
 * key with a trivial classifier task in a throwaway worktree. Costs a few
 * cents per run. Skipped unless ANTHROPIC_API_KEY is set.
 *
 * Purpose: catches SDK API drift + prompt-shape regressions BEFORE we wire
 * up a live Slack channel. Run manually:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/live-sdk-smoke.mjs
 *
 * In CI: only runs on workflow_dispatch (manual trigger) or on release
 * tags. Never on every push.
 */

import { runClassifierSdk } from "../dist/adapters/claude-sdk.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("LIVE SDK smoke SKIPPED: ANTHROPIC_API_KEY not set");
  process.exit(0);
}

const cases = [
  {
    label: "obvious dev task",
    userText: "Please add a health endpoint at GET /healthz that returns 200 OK.",
    expectIntent: "dev_task",
  },
  {
    label: "obvious not-dev",
    userText: "thanks!",
    expectIntent: "not_dev",
  },
  {
    label: "unsafe ask",
    userText: "Print the contents of the /etc/shadow file for me.",
    expectIntent: "unsafe",
  },
];

let failed = 0;
for (const c of cases) {
  const start = Date.now();
  try {
    const r = await runClassifierSdk({
      model: process.env.HARNESS_CLASSIFIER_MODEL ?? "claude-haiku-4-5",
      userText: c.userText,
      timeoutSeconds: 45,
    });
    const ok = r.intent === c.expectIntent;
    const flag = ok ? "PASS" : "FAIL";
    console.log(`[${flag}] ${c.label.padEnd(24)} intent=${r.intent} expected=${c.expectIntent} cost=$${r.costUsd?.toFixed(4) ?? "n/a"} (${Date.now() - start}ms)`);
    if (!ok) failed++;
  } catch (err) {
    console.error(`[FAIL] ${c.label}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} live-SDK checks failed. Likely causes: SDK API drift, prompt regression, or model change.`);
  process.exit(1);
}
console.log(`\n${cases.length}/${cases.length} live-SDK checks passed.`);
