/**
 * Live Claude Agent SDK integration smoke test.
 *
 * Gated behind `HARNESS_LIVE_TEST=1` and skipped in CI. Run manually before
 * a release to catch SDK breakage that the mocked unit tests can't see:
 *
 *   HARNESS_LIVE_TEST=1 ANTHROPIC_API_KEY=sk-ant-... node --test tests/live-sdk.test.mjs
 *
 * Cost: one worker turn on Sonnet (~$0.02 at 2026-07-13 prices). The test
 * spins up a throwaway git worktree in a tmpdir, asks the SDK to add a
 * one-line comment to README.md, and asserts that:
 *   - the SDK returned a well-formed `result` event,
 *   - `total_cost_usd` was reported,
 *   - the worktree actually got a modified file.
 *
 * Contract: this test intentionally uses the SAME `runWorkerSdk` entry point
 * that production uses. If the SDK's stream shape drifts, this fails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const LIVE = process.env.HARNESS_LIVE_TEST === "1";
const skip = !LIVE || !process.env.ANTHROPIC_API_KEY;

test("live-sdk: worker SDK completes a trivial edit end-to-end",
  { skip, timeout: 180_000 }, async () => {
    // Import from dist so we're running the shipped compiled code.
    const { runWorkerSdk } = await import("../dist/adapters/claude-sdk.js");

    const dir = await mkdtemp(join(tmpdir(), "oah-live-"));
    try {
      // Set up a minimal git repo so any tool the worker uses (Read, Edit)
      // has a real filesystem to touch.
      execSync("git init -q", { cwd: dir });
      execSync("git config user.email 'live-test@example.com'", { cwd: dir });
      execSync("git config user.name 'live-test'", { cwd: dir });
      await writeFile(join(dir, "README.md"), "# Test repo\n\nHello world.\n", "utf8");
      execSync("git add . && git commit -q -m init", { cwd: dir });

      const model = process.env.HARNESS_LIVE_MODEL ?? "claude-sonnet-5";

      const result = await runWorkerSdk({
        worktreePath: dir,
        systemPrompt: "You are a test worker. Edit the README to add a top-of-file HTML comment '<!-- edited by live-sdk test -->' on its own line. Do not touch anything else. Report success in one sentence.",
        userMessage: "Add the comment to README.md now.",
        model,
        permissionMode: "acceptEdits",
        timeoutSeconds: 120,
        canUseTool: async () => ({ allow: true }),
      });

      assert.ok(result.sdkSessionId, "sdkSessionId returned");
      assert.equal(result.stopReason, "end_turn", `stopReason should be end_turn, got ${result.stopReason}`);
      assert.ok(result.costUsd > 0, `total_cost_usd should be reported, got ${result.costUsd}`);
      assert.ok(result.tokensIn > 0, "tokensIn > 0");
      assert.ok(result.tokensOut > 0, "tokensOut > 0");

      const readme = await readFile(join(dir, "README.md"), "utf8");
      assert.match(readme, /<!-- edited by live-sdk test -->/, "worker actually edited README.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test("live-sdk: structured classifier returns a validated ClassifierResult",
  { skip, timeout: 60_000 }, async () => {
    const { runClassifierSdk } = await import("../dist/adapters/claude-sdk.js");
    const r = await runClassifierSdk({
      model: process.env.HARNESS_LIVE_CLASSIFIER ?? "claude-haiku-4-5",
      userText: "please add a null check to the loginHandler in src/auth.ts",
      timeoutSeconds: 60,
    });
    assert.ok(["dev_task", "clarify"].includes(r.intent), `intent should be dev_task/clarify, got ${r.intent}`);
    assert.ok(r.reason.length > 0, "reason present");
  });
