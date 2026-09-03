// beta.81 (consolidated): Track A budget transparency + Track B CI-verification
// shift + Track C retry/deadline/recovery fixes. Carel: "fold everything open
// into the next beta release."

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const S = (p) => readFileSync(join(ROOT, p), "utf8");

let ciwf;
try { ciwf = await import("../dist/adapters/ci-workflow.js"); } catch { ciwf = null; }
let recovery;
try { recovery = await import("../dist/state/recovery.js"); } catch { recovery = null; }
let cfg;
try { cfg = await import("../dist/config.js"); } catch { cfg = null; }

// ---- Track B: ci-workflow (pure) ----

test("beta81/B: detectCheckScripts reads package.json scripts", { skip: ciwf === null }, () => {
  const dir = mkdtempSync(join(tmpdir(), "b81-ciwf-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", build: "next build", dev: "next dev" },
  }));
  const scripts = ciwf.detectCheckScripts(dir);
  assert.ok(scripts.includes("typecheck"));
  assert.ok(scripts.includes("lint"));
  assert.ok(scripts.includes("test"));
  // `dev` is not a check script -> excluded
  assert.ok(!scripts.includes("dev"));
});

test("beta81/B: hasExistingWorkflow detects .github/workflows/*.yml", { skip: ciwf === null }, () => {
  const dir = mkdtempSync(join(tmpdir(), "b81-wf-"));
  assert.equal(ciwf.hasExistingWorkflow(dir), false);
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: ci\non: [push]\n");
  assert.equal(ciwf.hasExistingWorkflow(dir), true);
});

test("beta81/B: renderCiWorkflowYaml runs the detected check scripts on push", { skip: ciwf === null }, () => {
  const yaml = ciwf.renderCiWorkflowYaml(["typecheck", "lint", "test"]);
  assert.match(yaml, /on:/);
  assert.match(yaml, /push/);
  assert.match(yaml, /npm run typecheck/);
  assert.match(yaml, /npm run lint/);
  assert.match(yaml, /npm run test/);
  // installs deps first
  assert.match(yaml, /npm (ci|install)/);
});

test("beta81/B: renderCiWorkflowYaml with no scripts still emits a valid install-only workflow", { skip: ciwf === null }, () => {
  const yaml = ciwf.renderCiWorkflowYaml([]);
  assert.match(yaml, /on:/);
  assert.match(yaml, /npm (ci|install)/);
});

// ---- Track C: recovery circuit breaker (C4) ----

// Signature: recordResumeAndCheckBreaker(sessionId, maxResumes, windowSeconds, now)
test("beta81/C4: recordResumeAndCheckBreaker trips after MORE than maxResumes in window", { skip: recovery === null }, () => {
  recovery.__resetRecoveryResumeLedger();
  const sid = "sess-c4";
  const now = 1_000_000;
  // 3 within window -> not tripped (strictly MORE than max trips)
  assert.equal(recovery.recordResumeAndCheckBreaker(sid, 3, 60, now + 0).tripped, false);
  assert.equal(recovery.recordResumeAndCheckBreaker(sid, 3, 60, now + 1000).tripped, false);
  assert.equal(recovery.recordResumeAndCheckBreaker(sid, 3, 60, now + 2000).tripped, false);
  // 4th within the 60s window -> tripped
  assert.equal(recovery.recordResumeAndCheckBreaker(sid, 3, 60, now + 3000).tripped, true);
});

test("beta81/C4: resumes OUTSIDE the window do not trip (sliding window)", { skip: recovery === null }, () => {
  recovery.__resetRecoveryResumeLedger();
  const sid = "sess-c4b";
  const t = 5_000_000;
  recovery.recordResumeAndCheckBreaker(sid, 3, 60, t);
  recovery.recordResumeAndCheckBreaker(sid, 3, 60, t + 61_000); // outside window -> old entry dropped
  recovery.recordResumeAndCheckBreaker(sid, 3, 60, t + 62_000);
  const r = recovery.recordResumeAndCheckBreaker(sid, 3, 60, t + 63_000);
  assert.equal(r.tripped, false, "only 3 within the latest window");
});

test("beta81/C4: breaker disabled when maxResumes <= 0", { skip: recovery === null }, () => {
  recovery.__resetRecoveryResumeLedger();
  for (let i = 0; i < 20; i++) {
    assert.equal(recovery.recordResumeAndCheckBreaker("sess-off", 0, 60, 1000 + i * 100).tripped, false);
  }
});

// ---- config defaults + clamps ----

test("beta81: config carries all new track keys with defaults", { skip: cfg === null }, () => {
  const c = cfg.parseHarnessConfig({ slack: { authorised_users: ["U1"] }, repos: { allowed: ["o/*"] } });
  // Track C
  assert.equal(c.loop.recovery_max_resumes, 3);
  assert.equal(c.loop.recovery_resume_window_seconds, 60);
  assert.equal(c.loop.recovery_resume_at_subtask, true);
  assert.equal(c.loop.lead_json_retry_enabled, true);
  // Track B
  assert.equal(c.ci.wait_timeout_seconds, 900);
});

test("beta81/B: ci.wait_timeout_seconds is clamped to [30, 7200]", { skip: cfg === null }, () => {
  const lo = cfg.parseHarnessConfig({ slack: { authorised_users: ["U1"] }, repos: { allowed: ["o/*"] }, ci: { wait_timeout_seconds: 5 } });
  assert.equal(lo.ci.wait_timeout_seconds, 30);
  const hi = cfg.parseHarnessConfig({ slack: { authorised_users: ["U1"] }, repos: { allowed: ["o/*"] }, ci: { wait_timeout_seconds: 99999 } });
  assert.equal(hi.ci.wait_timeout_seconds, 7200);
});

// ---- source assertions: wiring ----

test("beta81/A: registration emits UNCONDITIONAL tool.run.budget_estimate + surfaces an estimate line", () => {
  const src = S("src/tools/registration.ts");
  assert.match(src, /tool\.run\.budget_estimate/);
  assert.match(src, /Estimated ~\$\$\{res\.estimatedUsd/);
  // persisted on the session row
  assert.match(src, /estimated_usd/);
});

test("beta81/A: progress snapshot carries estimatedUsd + pctOfCap", () => {
  const src = S("src/orchestrator/progress.ts");
  assert.match(src, /estimatedUsd/);
  assert.match(src, /pctOfCap/);
});

test("beta81/B: worker prompt forbids running tests/build/lint locally to green (CI verifies)", () => {
  const src = S("src/orchestrator/worker.ts");
  assert.match(src, /DO NOT run the test suite, a build, or lint "to green"/i);
  assert.match(src, /GitHub CI runs the repo's declared checks AFTER the/i);
  assert.match(src, /CI does the verifying|CI verifies/i);
});

test("beta81/B: loop polls CI after push and branches on success/failure/none/timeout", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /pollCiStatus/);
  assert.match(src, /loop\.ci_success/);
  assert.match(src, /loop\.ci_failure/);
  assert.match(src, /loop\.ci_none/);
  assert.match(src, /loop\.ci_wait_timeout/);
  // authors a workflow when the repo has none
  assert.match(src, /loop\.ci_workflow_authored/);
});

test("beta81/B: github adapter can fetch failing check logs to drive revise", () => {
  const src = S("src/adapters/github.ts");
  assert.match(src, /export async function getFailingCheckLogs/);
});

test("beta81/C1+C2: worker-timeout retry re-fires or fails, bounded by the subtask deadline", () => {
  const src = S("src/orchestrator/loop.ts");
  // retry must actually re-invoke the worker (not log-then-noop) and the outer
  // deadline must cover the retry path.
  assert.match(src, /worker_timeout_retry|worker_timed out; retrying/i);
  assert.match(src, /subtask_deadline|subtask_deadline_exceeded/);
});

test("beta81/C3: recovery resumes at the failed sub-task instead of full re-plan", () => {
  const rec = S("src/state/recovery.ts");
  const src = S("src/orchestrator/loop.ts") + rec;
  assert.match(src + S("src/config.ts"), /recovery_resume_at_subtask/);
});

test("beta81/C4: recovery circuit breaker wired + lead JSON retry present", () => {
  const rec = S("src/state/recovery.ts");
  assert.match(rec, /recordResumeAndCheckBreaker/);
  assert.match(rec, /recovery_bounce_loop|breaker.*tripped|tripped/i);
  const sdk = S("src/adapters/claude-code.ts");
  assert.match(sdk, /anti-prose-drift|retrying ONCE with a terse output-contract/i);
  assert.match(sdk, /jsonRetryEnabled/);
});

test("beta81: manifest declares ci + new loop keys", () => {
  const man = S("openclaw.plugin.json");
  assert.match(man, /"wait_timeout_seconds"/);
  assert.match(man, /"recovery_max_resumes"/);
  assert.match(man, /"recovery_resume_at_subtask"/);
  assert.match(man, /"lead_json_retry_enabled"/);
});

test("beta81: version.ts pluginVersion matches package.json", () => {
  const ver = S("src/version.ts");
  const pkg = JSON.parse(S("package.json"));
  assert.match(ver, new RegExp(`pluginVersion: "${pkg.version.replace(/\./g, "\\.")}"`));
});
