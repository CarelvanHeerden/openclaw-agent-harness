import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const registrationSource = read("src/tools/registration.ts");
const schemaSource = read("src/state/schema.sql");
const loopSource = read("src/orchestrator/loop.ts");
const progressSource = read("src/orchestrator/progress.ts");
const mergeRecommendationSource = read("src/orchestrator/merge-recommendation.ts");
const indexSource = read("src/index.ts");
const configSchemaSource = read("src/config.schema.json");

const EXPECTED_ORDINARY_TOOLS = [
  "harness_change_result",
  "harness_confirm_change",
  "harness_merge_change",
  "harness_prepare_change",
];

const RETIRED_ORDINARY_NAMES = [
  "harness_answer",
  "harness_progress",
  "harness_resume",
  "harness_revise",
  "harness_list_revisable",
];

async function collectPackagedSurface() {
  const { registerHarnessTools } = await import(
    pathToFileURL(resolve(root, "dist/tools/registration.js"))
  );
  const tools = [];
  const commands = [];
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool(definition) {
      const ordinaryContext = {
        requesterSenderId: "U-ordinary",
        conversationId: "C-ordinary:T-ordinary",
        senderIsOwner: false,
      };
      const resolved = typeof definition === "function"
        ? definition(ordinaryContext)
        : definition;
      tools.push(resolved);
      return () => {};
    },
    registerCommand(definition) {
      commands.push(definition);
      return () => {};
    },
  };
  const dispose = registerHarnessTools(api, {});
  dispose();
  return { tools, commands };
}

function names(items) {
  return items.map((item) => item.name).sort();
}

function assertHasAll(source, patterns, component) {
  for (const pattern of patterns) {
    assert.ok(pattern.test(source), `${component} must implement ${pattern}`);
  }
}

function assertHasNone(source, pattern, message) {
  assert.ok(!pattern.test(source), message);
}

test("control plane: ordinary packaged catalog exposes exactly prepare/confirm/result/merge", async () => {
  const { tools } = await collectPackagedSurface();
  assert.deepEqual(
    names(tools),
    EXPECTED_ORDINARY_TOOLS,
    "src/tools/registration.ts and packaged dist/tools/registration.js still expose the rc.13 operator/session catalog",
  );
});

test("control plane: ordinary packaged surface has no direct commands or retired operations", async () => {
  const { tools, commands } = await collectPackagedSurface();
  const publicNames = names(tools);
  assert.deepEqual(commands, [], "src/tools/registration.ts still registers a direct /harness-answer command");
  for (const retired of RETIRED_ORDINARY_NAMES) {
    assert.equal(publicNames.includes(retired), false, `${retired} must not be ordinary-user discoverable`);
  }
});

test("control plane: confirmation is the final human decision; no post-confirmation clarification state exists", () => {
  const postConfirmationControl = [registrationSource, loopSource, progressSource, configSchemaSource].join("\n");
  assertHasNone(
    postConfirmationControl,
    /awaiting_clarification|clarification_(?:question|answer|id|seq)|harness_answer|isBudgetExtensionPause|isTimeExtensionPause/,
    "src/tools/registration.ts, src/orchestrator/loop.ts, src/orchestrator/progress.ts, and src/config.schema.json retain post-confirmation question/resume paths",
  );
  assertHasAll(
    schemaSource,
    [
      /control_change_state[^\n]*prepared[^\n]*accepted[^\n]*running[^\n]*pr_ready[^\n]*failed[^\n]*merged[^\n]*merge_failed/i,
      /CHECK\s*\([^)]*state[^)]*\)/i,
    ],
    "src/state/schema.sql",
  );
});

test("control plane: one host-attested confirmation binds the complete immutable authority envelope", () => {
  assertHasAll(
    schemaSource,
    [
      /CREATE TABLE\s+control_changes/i,
      /actor_identity/i,
      /conversation_identity/i,
      /repository_identity/i,
      /base_(?:sha|revision)/i,
      /brief_digest/i,
      /policy_digest/i,
      /budget_(?:usd|digest|maximum)/i,
      /scope_digest/i,
      /credential_route/i,
      /security_(?:class|digest|classification)/i,
      /generation/i,
    ],
    "src/state/schema.sql",
  );
  assertHasAll(
    registrationSource,
    [
      /harness_confirm_change/,
      /control-plane-confirm\/v1/,
      /requesterSenderId/,
      /conversationId/,
      /stale_confirmation/,
      /wrong_actor/,
      /wrong_conversation/,
    ],
    "src/tools/registration.ts",
  );
  assertHasNone(
    registrationSource,
    /name:\s*["']harness_confirm_change["'][\s\S]{0,2500}\binvokedBy\b/,
    "confirmation authority must come from trusted host context, never a caller-supplied invokedBy field",
  );
});

test("control plane: confirmation receipts are one-use CAS records and survive restart without double dispatch", () => {
  assertHasAll(
    schemaSource,
    [
      /CREATE TABLE\s+control_attestations/i,
      /operation_kind/i,
      /host_event_id/i,
      /nonce/i,
      /binding_digest/i,
      /expires_at/i,
      /consumed_at/i,
      /UNIQUE\s*\([^)]*(?:host_event_id|nonce)[^)]*\)/i,
      /CREATE TABLE\s+control_execution_intents/i,
      /UNIQUE\s*\([^)]*change_id[^)]*\)/i,
    ],
    "src/state/schema.sql",
  );
  assertHasAll(
    registrationSource + "\n" + loopSource,
    [
      /already_confirmed/,
      /confirmation_replayed/,
      /UPDATE[\s\S]{0,500}WHERE[\s\S]{0,200}(?:generation|state)/i,
    ],
    "confirmation controller",
  );
});

test("control plane: budget/time/scope/path/security/credential escalation is terminal, never a question", () => {
  const runtimeControl = registrationSource + "\n" + loopSource + "\n" + configSchemaSource;
  for (const code of [
    "budget_exceeded",
    "time_exceeded",
    "scope_escalation",
    "path_violation",
    "security_escalation",
    "credential_escalation",
  ]) {
    assert.ok(new RegExp(code).test(runtimeControl), `missing stable terminal code ${code}`);
  }
  assertHasNone(
    runtimeControl,
    /(?:ask|question|clarification|answer)[^\n]{0,160}(?:budget|more time|scope|path|security|credential)|(?:budget|time|scope|path|security|credential)[^\n]{0,160}(?:ask|question|clarification|answer)/i,
    "rc.13 still turns envelope exhaustion/escalation into an interactive question",
  );
});

test("control plane: PR-ready requires pass, zero blockers, exact publication/head, required CI/runtime evidence, and in-envelope spend", () => {
  assertHasNone(
    mergeRecommendationSource,
    /review\.verdict\s*!==\s*["']pass["'][\s\S]{0,2200}recommendation:\s*["']merge["']/,
    "src/orchestrator/merge-recommendation.ts currently permits a non-pass verdict to recommend merge",
  );
  assertHasNone(
    mergeRecommendationSource,
    /CI is still running[\s\S]{0,180}merge will proceed/,
    "src/orchestrator/merge-recommendation.ts currently treats pending CI as mergeable",
  );
  assertHasAll(
    registrationSource + "\n" + loopSource + "\n" + indexSource,
    [
      /state[^\n]{0,80}pr_ready/i,
      /verdict[^\n]{0,80}pass/i,
      /blocking[^\n]{0,80}(?:===|==)\s*0/i,
      /published_sha/i,
      /pr_head_sha/i,
      /required_ci/i,
      /runtime_evidence/i,
      /spend[^\n]{0,80}(?:budget|envelope)/i,
    ],
    "src/orchestrator/loop.ts, src/tools/registration.ts, and src/index.ts",
  );
});

test("control plane: merge requires a separate trusted host attestation and is exactly once", () => {
  assertHasAll(
    registrationSource + "\n" + indexSource + "\n" + schemaSource,
    [
      /harness_merge_change/,
      /merge_change/,
      /merge_attestation_required/,
      /stale_pr_head/,
      /CREATE TABLE\s+control_merge_intents/i,
      /UNIQUE\s*\([^)]*change_id[^)]*\)/i,
      /already_merged/,
    ],
    "merge boundary (src/tools/registration.ts, src/index.ts, src/state/schema.sql)",
  );
  assertHasNone(
    indexSource,
    /mergePr:\s*\(args:\s*\{[^}]*invokedBy/,
    "src/index.ts merge authority is still represented by caller-supplied invokedBy rather than host attestation",
  );
});

test("control plane: user-safe packaged output has no internal protocol, IDs, polling, or command instructions", async () => {
  const { tools } = await collectPackagedSurface();
  const publicMetadata = tools.map((tool) => JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })).join("\n");
  assertHasNone(
    publicMetadata,
    /harness_(?:answer|progress|resume|revise|list_revisable)|\/harness-|clarification(?:Id|Seq|Question)?|sub-?task|poll(?:ing)?|every ~?\d+s|retry|worktree|interaction log|prompt/i,
    "src/tools/registration.ts exposes rc.13 internals and operating instructions in ordinary-user metadata",
  );
  assertHasNone(
    progressSource,
    /clarificationId|clarificationSeq|subTasks|recentEvents|poll|worktree|harness_(?:answer|revise)/,
    "src/orchestrator/progress.ts is an internal diagnostic model, not the allow-listed harness_change_result representation",
  );
});

test("control plane: recovery and migration are versioned, idempotent, and do not reactivate rc.13 authority", () => {
  assertHasAll(
    schemaSource + "\n" + registrationSource + "\n" + loopSource,
    [
      /control_plane_contract_version/i,
      /control_plane_schema_version/i,
      /legacy_rc13/i,
      /migration[^\n]{0,120}idempotent/i,
      /verified_checkpoint/i,
      /lease_(?:owner|expires_at|generation)/i,
      /merge_provider_idempotency/i,
    ],
    "state/recovery migration components",
  );
  assertHasNone(
    registrationSource,
    /name:\s*["']harness_(?:resume|answer|revise|list_revisable)["']/,
    "legacy rc.13 authority paths must be absent before enabling the new ordinary catalog",
  );
});
