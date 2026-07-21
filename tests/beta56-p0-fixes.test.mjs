/**
 * beta.56: the five P0 fixes from the full-code review.
 *
 * P0-1  Revise cycles carry the adversary's findings to the workers.
 *       Before: on `adversary_revise` the loop re-dispatched the SAME
 *       sub-task prompts verbatim (no findings anywhere in the dispatch),
 *       so cycle 2 was cycle 1 replayed and the loop could not converge.
 * P0-2  The adversary sees the full brief (title, motivation, acceptance
 *       criteria). Before: `crystallisedPrompt` was brief.title only, AND
 *       buildAdversarySystemPrompt never included it in the prompt at all.
 * P0-3  harness_answer's disposer is registered. Before: the toDispose()
 *       result was discarded, so the tool leaked across every re-register.
 * P0-4  sanitizeRemoteSubTasks coerces contractScope='local' even when the
 *       field is ABSENT, so regex inference can no longer produce
 *       unsatisfiable push/PR checks on an unlabelled sub-task.
 * P0-5  Worker-path verification removed; the loop is the single
 *       verification site. Before: the worker path verified with an empty
 *       branch context (false pass/fail) and pre-failed results, bypassing
 *       the beta.53/54/55 retry/refusal/clarification machinery.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const S = (p) => readFileSync(resolve(repoRoot, p), "utf8");

let loopMod = null;
let adversaryMod = null;
let leadMod = null;
try {
  loopMod = await import("../dist/orchestrator/loop.js");
  adversaryMod = await import("../dist/orchestrator/fable5-adversary.js");
  leadMod = await import("../dist/orchestrator/fable5-lead.js");
} catch {
  loopMod = adversaryMod = leadMod = null;
}
const skipAll = { skip: loopMod === null };

// ---------------------------------------------------------------------------
// P0-1: buildReviseDispatchHint + loop wiring
// ---------------------------------------------------------------------------

test("P0-1: buildReviseDispatchHint renders verdict, summary, and findings", skipAll, () => {
  const hint = loopMod.buildReviseDispatchHint({
    verdict: "revise",
    summary: "aria-label missing on the toggle button",
    findings: [
      { dimension: "spec", severity: "high", title: "Missing aria-label", detail: "Button in nav.tsx has no accessible name", file: "src/nav.tsx", line: 42 },
      { dimension: "quality", severity: "info", title: "Nit", detail: "prefer const" },
    ],
    costUsd: 0, tokensIn: 0, tokensOut: 0,
  });
  assert.match(hint, /REVISION CYCLE/);
  assert.match(hint, /"revise"/);
  assert.match(hint, /aria-label missing on the toggle button/);
  assert.match(hint, /\[high\/spec\] Missing aria-label \(src\/nav\.tsx:42\)/);
  // info findings are filtered out when actionable findings exist
  assert.doesNotMatch(hint, /prefer const/);
  // the beta.35 legal-no-op escape hatch must be preserved verbatim-ish
  assert.match(hint, /make NO changes and end your turn/);
});

test("P0-1: info-only reviews still render (not an empty findings block)", skipAll, () => {
  const hint = loopMod.buildReviseDispatchHint({
    verdict: "revise",
    summary: "only nits",
    findings: [{ dimension: "quality", severity: "info", title: "Nit", detail: "prefer const" }],
    costUsd: 0, tokensIn: 0, tokensOut: 0,
  });
  assert.match(hint, /prefer const/);
});

test("P0-1: loop dispatch passes the revise hint on cycle > 1 (integration)", skipAll, async () => {
  // Minimal in-memory state double matching what the loop touches.
  const rows = new Map();
  rows.set("s1", {
    id: "s1", requester: "U1", cost_usd: 0, budget_usd: 100, cycles_ran: 0, status: "planning",
    last_checkpoint_at: null, updated_at: Date.now(), repo: "o/r", worktree_path: "/tmp/wt",
  });
  const subTaskRows = new Map();
  const db = {
    prepare(sql) {
      return {
        get: (id) => rows.get(id),
        run: (...args) => {
          if (sql.includes("UPDATE sessions")) {
            const id = args[args.length - 1];
            const row = rows.get(id);
            if (row) row.updated_at = Date.now();
          }
          if (sql.includes("INSERT OR REPLACE INTO sub_tasks")) subTaskRows.set(args[0], args);
          return { changes: 1 };
        },
        all: () => [],
      };
    },
  };
  const state = { db, audit: () => {} };
  const config = {
    loop: {
      max_cycles: 3, worker_timeout_seconds: 30, adversary_timeout_seconds: 30,
      lead_timeout_seconds: 30, session_hard_timeout_seconds: 300, subtask_concurrency: 1,
    },
    models: { worker: "claude-sonnet-5" },
  };
  const dispatchHints = [];
  let reviews = 0;
  const loop = new loopMod.OrchestratorLoop({
    config, state,
    budget: { recordSpend: async () => {} },
    pat: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runLead: async () => ({
      repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt", riskLevel: "low",
      reviewChecklist: ["c1"],
      subTasks: [{ seq: 1, title: "edit file", intent: "edit", filesLikelyTouched: [], successCriteria: ["done"], estimatedTokens: 10, contractScope: "local", taskMode: "observe", verify: [] }],
    }),
    runWorker: async ({ dispatchHint }) => {
      dispatchHints.push(dispatchHint);
      return { status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done" };
    },
    runAdversary: async () => {
      reviews += 1;
      return reviews === 1
        ? { verdict: "revise", findings: [{ dimension: "spec", severity: "high", title: "Fix the label", detail: "missing aria-label" }], summary: "needs a fix", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }
        : { verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 };
    },
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
  });
  const outcome = await loop.run("s1", { title: "t", motivation: "m", acceptanceCriteria: ["a"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" });
  assert.equal(outcome.status, "shipped", JSON.stringify(outcome));
  assert.equal(dispatchHints.length, 2, "two cycles -> two worker dispatches");
  assert.equal(dispatchHints[0], undefined, "cycle 1 carries no revise hint");
  assert.ok(dispatchHints[1], "cycle 2 MUST carry the revise hint");
  assert.match(dispatchHints[1], /Fix the label/);
  assert.match(dispatchHints[1], /needs a fix/);
});

// ---------------------------------------------------------------------------
// P0-2: adversary sees the brief
// ---------------------------------------------------------------------------

test("P0-2: buildAdversarySystemPrompt includes the crystallised brief", skipAll, () => {
  const p = adversaryMod.buildAdversarySystemPrompt({
    crystallisedPrompt: "Title: add hello endpoint\nAcceptance criteria:\n- GET /hello returns 200",
    diffPath: "/tmp/x.diff", repoPath: "/tmp/wt",
    reviewChecklist: ["hello endpoint exists"],
    model: "m", timeoutSeconds: 30,
  });
  assert.match(p, /SOURCE OF TRUTH for spec fidelity/);
  assert.match(p, /add hello endpoint/);
  assert.match(p, /GET \/hello returns 200/);
});

test("P0-2: index.ts passes the full brief (not just the title) to the adversary", () => {
  const src = S("src/index.ts");
  assert.match(src, /`Title: \$\{brief\.title\}`/);
  assert.match(src, /`Motivation: \$\{brief\.motivation\}`/);
  assert.match(src, /brief\.acceptanceCriteria\.map/);
  assert.doesNotMatch(src, /crystallisedPrompt: brief\.title,/);
});

// ---------------------------------------------------------------------------
// P0-3: every registered tool's disposer is captured
// ---------------------------------------------------------------------------

test("P0-3: registration.ts pushes a disposer for EVERY registerTool call", () => {
  const src = S("src/tools/registration.ts");
  // `({` distinguishes an actual call from prose mentions in comments.
  const registered = (src.match(/api\.registerTool\(\{/g) ?? []).length;
  const pushed = (src.match(/disposers\.push\(/g) ?? []).length;
  assert.equal(pushed, registered, `every registerTool must be wrapped in disposers.push (${pushed}/${registered})`);
});

// ---------------------------------------------------------------------------
// P0-4: sanitiser coerces ABSENT contractScope to 'local'
// ---------------------------------------------------------------------------

test("P0-4: an unlabelled sub-task with push wording gets contractScope='local' (no unsatisfiable remote contract)", skipAll, async () => {
  const plan = await leadMod.runLeadPlanner(
    { title: "t", motivation: "m", acceptanceCriteria: ["a"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" },
    {
      config: { repos: { allowed: ["o/r"] } },
      logger: { info: () => {} },
      callLeadModel: async () => ({
        repo: "o/r", branch: "harness/x", riskLevel: "low", reviewChecklist: ["c"],
        subTasks: [
          // NO contractScope, NO verify, but wording that regex-infers a push.
          { seq: 1, title: "Commit the change so it can be pushed", intent: "commit docs/x.md so the branch can be pushed to origin", filesLikelyTouched: ["docs/x.md"], successCriteria: ["committed"], estimatedTokens: 10 },
        ],
      }),
      allocateWorktree: async () => "/tmp/wt",
      estimateCost: () => 0.1,
    },
  );
  assert.equal(plan.subTasks[0].contractScope, "local", "absent contractScope must be coerced to local");
  // And the inferred contract must therefore contain no remote kinds.
  const { inferVerifyContract } = await import("../dist/orchestrator/verify-contract.js");
  const contract = inferVerifyContract(plan.subTasks[0]);
  const remote = new Set(["branch_pushed", "remote_branch_exists", "commit_sha_matches", "pr_opened", "pr_state", "file_pushed", "file_in_pr"]);
  for (const c of contract) {
    assert.ok(!remote.has(c.kind), `unsatisfiable remote kind '${c.kind}' inferred on a worker sub-task`);
  }
});

// ---------------------------------------------------------------------------
// P0-5: single verification site (loop), worker path removed
// ---------------------------------------------------------------------------

test("P0-5: sonnet-worker no longer verifies (loop is the single verification site)", () => {
  const src = S("src/orchestrator/sonnet-worker.ts");
  assert.doesNotMatch(src, /buildVerifyProbes/, "worker deps must not carry verify probes");
  assert.doesNotMatch(src, /verifySubTaskOutput/, "worker must not run verification itself");
  assert.doesNotMatch(src, /wastedSpend/, "wastedSpend bookkeeping moved out with the verifier");
});

test("P0-5: loop still verifies every sub-task via inferVerifyContract (unchanged)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /const contract = inferVerifyContract\(st\)/);
  assert.match(src, /verifySubTaskOutput\(/);
});

test("P0-5: worker result status comes from the SDK stop reason only", skipAll, async () => {
  const worker = await import("../dist/orchestrator/sonnet-worker.js");
  const res = await worker.runWorker(
    "/tmp/wt",
    { title: "t", motivation: "m", acceptanceCriteria: ["a"] },
    // explicit verify present -- previously this triggered the buggy
    // worker-path verification; now it must be ignored here (loop owns it).
    { seq: 1, title: "x", intent: "i", filesLikelyTouched: [], successCriteria: ["s"], estimatedTokens: 10, verify: [{ kind: "pr_opened" }] },
    { name: "n", email: "e" },
    {
      config: { models: { worker: "claude-sonnet-5" }, safety: { worker_permission_mode: "acceptEdits" }, loop: { worker_timeout_seconds: 30 } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      runWorkerModel: async () => ({ sdkSessionId: "sdk1", stopReason: "end_turn", costUsd: 0.01, tokensIn: 1, tokensOut: 1, logsExcerpt: "", finalMessage: "done" }),
      gitCommit: async () => null,
      gitListChangedFiles: async () => [],
      gitBaseSha: async () => "abc",
      buildCanUseTool: () => async () => ({ allow: true }),
    },
  );
  assert.equal(res.status, "completed", "SDK end_turn -> completed; no worker-path verification to flip it");
});
