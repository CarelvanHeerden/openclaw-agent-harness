/**
 * Adapters over `@anthropic-ai/claude-agent-sdk`.
 *
 * These wrap the SDK so callers get a stable, testable shape:
 *   - `runWorker()`: single-turn worker with canUseTool + tools.
 *   - `runReviewer()`: single-turn adversary with JSON-only output.
 *   - `runClassifier()`: single-turn intent classifier.
 *   - `runLead()`: single-turn planner returning a strict LeadPlan.
 *
 * All wrappers convert the streaming AsyncIterator into a single terminal
 * result and count usage. The SDK's `canUseTool` callback signature is a
 * function `(toolName, toolInput) => { behavior: "allow" | "deny", ... }`.
 * We adapt our internal `{ allow, reason }` shape to that.
 *
 * NOTE (2026-07-13): This module lazy-imports the SDK so tests can run
 * without the real SDK installed. Production code will error clearly if
 * the SDK is missing.
 */

import type {
  ClassifierResult,
  CrystallisedBrief,
} from "../crystallise/prompt-refiner.js";
import type { LeadPlan, LeadPlanSubTask } from "../orchestrator/fable5-lead.js";
import {
  AdversaryResultSchema,
  ClassifierResultSchema,
  CrystallisedBriefSchema,
  LeadPlanSchema,
  parseAndValidate,
} from "./sdk-schemas.js";
import type { z } from "zod";

let sdkCache: unknown;
async function loadSdk(): Promise<any> {
  if (sdkCache) return sdkCache;
  try {
    sdkCache = await import("@anthropic-ai/claude-agent-sdk");
  } catch (err) {
    throw new Error(
      `@anthropic-ai/claude-agent-sdk is required at runtime but failed to load: ${String(err)}`,
    );
  }
  return sdkCache;
}

export interface RunWorkerParams {
  worktreePath: string;
  systemPrompt: string;
  userMessage: string;
  model: string;
  permissionMode: "acceptEdits" | "bypassPermissions" | "plan";
  resumeSessionId?: string;
  timeoutSeconds: number;
  canUseTool: (toolName: string, toolInput: unknown) => Promise<{ allow: boolean; reason?: string }>;
}

export interface RunWorkerResult {
  sdkSessionId: string;
  stopReason: "end_turn" | "max_tokens" | "tool_error" | "timeout" | "canceled";
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  logsExcerpt: string;
}

export async function runWorkerSdk(params: RunWorkerParams): Promise<RunWorkerResult> {
  const sdk = await loadSdk();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), params.timeoutSeconds * 1000);

  let stopReason: RunWorkerResult["stopReason"] = "end_turn";
  let sdkSessionId = "";
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const logLines: string[] = [];

  try {
    const stream = sdk.query({
      prompt: params.userMessage,
      options: {
        model: params.model,
        systemPrompt: params.systemPrompt,
        cwd: params.worktreePath,
        permissionMode: params.permissionMode,
        resume: params.resumeSessionId,
        canUseTool: async (toolName: string, toolInput: unknown) => {
          const decision = await params.canUseTool(toolName, toolInput);
          if (decision.allow) return { behavior: "allow", updatedInput: toolInput };
          return {
            behavior: "deny",
            message: decision.reason ?? "denied by harness guard",
          };
        },
        abortSignal: abort.signal,
      },
    });

    for await (const message of stream) {
      logLines.push(JSON.stringify(message).slice(0, 300));
      if (message.type === "system" && message.subtype === "init") {
        sdkSessionId = message.session_id;
      }
      if (message.type === "result") {
        stopReason = message.subtype === "success" ? "end_turn" : "tool_error";
        costUsd = message.total_cost_usd ?? 0;
        tokensIn = message.usage?.input_tokens ?? 0;
        tokensOut = message.usage?.output_tokens ?? 0;
      }
    }
  } catch (err) {
    if (abort.signal.aborted) stopReason = "timeout";
    else stopReason = "tool_error";
    logLines.push(`ERROR: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  return {
    sdkSessionId,
    stopReason,
    costUsd,
    tokensIn,
    tokensOut,
    logsExcerpt: logLines.slice(-25).join("\n"),
  };
}

// ---- Structured-output helpers (classifier, crystalliser, lead, adversary) ----

async function structuredCall<T>(params: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  timeoutSeconds: number;
  /** Zod schema used to validate the parsed JSON. Optional (kept optional
   *  so existing tests that don't stub a schema still compile), but every
   *  first-party caller in this file passes one. */
  schema?: z.ZodType<T>;
  /** Human-readable caller label included in schema-error messages. */
  callerLabel?: string;
}): Promise<{ parsed: T; sdkSessionId: string; costUsd: number; tokensIn: number; tokensOut: number; raw: string }> {
  const sdk = await loadSdk();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), params.timeoutSeconds * 1000);

  let sdkSessionId = "";
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const textChunks: string[] = [];

  try {
    const stream = sdk.query({
      prompt: params.userMessage,
      options: {
        model: params.model,
        systemPrompt: params.systemPrompt,
        permissionMode: "plan" as const, // no tool use
        abortSignal: abort.signal,
      },
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sdkSessionId = message.session_id;
      }
      if (message.type === "assistant" && Array.isArray(message.message?.content)) {
        for (const c of message.message.content) {
          if (c.type === "text") textChunks.push(c.text);
        }
      }
      if (message.type === "result") {
        costUsd = message.total_cost_usd ?? 0;
        tokensIn = message.usage?.input_tokens ?? 0;
        tokensOut = message.usage?.output_tokens ?? 0;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const raw = textChunks.join("");
  const json = extractJson(raw);
  // Round-3: never hand back the first JSON blob blindly. If the caller
  // provided a Zod schema, validate; otherwise fall back to raw JSON.parse
  // (only reached from tests that pre-date the schema wiring).
  const parsed = params.schema
    ? parseAndValidate<T>(json, params.schema, raw, params.callerLabel ?? "structuredCall")
    : (JSON.parse(json) as T);
  return { parsed, sdkSessionId, costUsd, tokensIn, tokensOut, raw };
}

/**
 * Extracts the first well-formed top-level JSON object or array from a
 * string. Handles the common case where the model wraps output in prose
 * or a fenced code block despite instructions.
 */
export function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) throw new Error(`no JSON in output: ${text.slice(0, 200)}`);
  const opening = text[start]!;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === opening) depth++;
    else if (ch === closing) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced JSON in output");
}

export async function runClassifierSdk(params: {
  model: string;
  userText: string;
  timeoutSeconds: number;
}): Promise<ClassifierResult & { costUsd: number; tokensIn: number; tokensOut: number }> {
  const systemPrompt = [
    "You classify a single Slack message from a developer channel.",
    "Return STRICT JSON: { intent: 'dev_task' | 'clarify' | 'not_dev' | 'unsafe', reason: string, suggestedClarification?: string }",
    "- dev_task: the user wants code written, refactored, tested, or a config changed. Include ambiguous but clearly technical asks here.",
    "- clarify: the ask is dev-shaped but missing the ONE thing you'd need to act (which repo, which branch, what file).",
    "- not_dev: chat, thanks, jokes, non-technical questions. No action needed.",
    "- unsafe: asks that would exfiltrate secrets, delete data, disable safeguards, or violate policy.",
    "Output the JSON and nothing else.",
  ].join("\n");

  const r = await structuredCall<ClassifierResult>({
    model: params.model,
    systemPrompt,
    userMessage: params.userText,
    timeoutSeconds: params.timeoutSeconds,
    schema: ClassifierResultSchema as unknown as z.ZodType<ClassifierResult>,
    callerLabel: "classifier",
  });
  return { ...r.parsed, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}

export async function runCrystalliserSdk(params: {
  model: string;
  userText: string;
  timeoutSeconds: number;
}): Promise<CrystallisedBrief & { costUsd: number; tokensIn: number; tokensOut: number }> {
  const systemPrompt = [
    "You are a senior engineer refining a rough dev request into a well-scoped brief.",
    "Return STRICT JSON matching CrystallisedBrief:",
    "  { title: string, motivation: string, acceptanceCriteria: string[],",
    "    filesLikelyTouched: string[], outOfScope: string[],",
    "    repoHint?: string, branchHint?: string, riskLevel: 'low'|'medium'|'high' }",
    "Rules:",
    "- title: concise imperative sentence",
    "- motivation: 1-3 sentences",
    "- acceptanceCriteria: observable, testable outcomes (min 1)",
    "- riskLevel: high if touches auth/secrets/payment code or db schema; medium if user-facing behavior changes; low otherwise.",
    "Output the JSON and nothing else.",
  ].join("\n");

  const r = await structuredCall<CrystallisedBrief>({
    model: params.model,
    systemPrompt,
    userMessage: params.userText,
    timeoutSeconds: params.timeoutSeconds,
    schema: CrystallisedBriefSchema as unknown as z.ZodType<CrystallisedBrief>,
    callerLabel: "crystalliser",
  });
  return { ...r.parsed, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}

export async function runLeadSdk(params: {
  model: string;
  brief: CrystallisedBrief;
  reposAllowed: string[];
  timeoutSeconds: number;
}): Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd"> & { costUsd: number; tokensIn: number; tokensOut: number }> {
  const systemPrompt = [
    "You are the lead planner. Decompose a brief into ATOMIC sub-tasks a Sonnet worker can complete in one turn.",
    "Return STRICT JSON:",
    "  { repo: string (owner/repo, must be in reposAllowed),",
    "    branch: string (must start with 'harness/'),",
    "    subTasks: SubTask[],",
    "    reviewChecklist: string[],",
    "    riskLevel: 'low'|'medium'|'high' }",
    "SubTask: { seq: number, title: string, intent: string, filesLikelyTouched: string[], successCriteria: string[], estimatedTokens: number, dependsOn?: number[] }",
    "Rules:",
    "- Prefer 3-8 sub-tasks. Hard cap 20.",
    "- Each sub-task must be independently reviewable.",
    "- reviewChecklist has one item per acceptance criterion + one for tests + one for docs.",
    `- reposAllowed: ${JSON.stringify(params.reposAllowed)}`,
    "Output the JSON and nothing else.",
  ].join("\n");

  const r = await structuredCall<Omit<LeadPlan, "worktreePath" | "approxCostUsd">>({
    model: params.model,
    systemPrompt,
    userMessage: JSON.stringify(params.brief),
    timeoutSeconds: params.timeoutSeconds,
    schema: LeadPlanSchema as unknown as z.ZodType<Omit<LeadPlan, "worktreePath" | "approxCostUsd">>,
    callerLabel: "lead-planner",
  });
  return { ...r.parsed, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}

/** Max characters of diff passed to the adversary. Anything above is truncated
 *  with an explicit banner so the reviewer can flag incomplete coverage. */
export const ADVERSARY_DIFF_CAP = 200_000;

/**
 * Truncate a diff to {@link ADVERSARY_DIFF_CAP} characters and prepend a
 * human-readable banner if truncation happened. Adversary prompts are
 * instructed to treat that banner as a signal that runtime/coverage claims
 * cannot be complete.
 */
export function prepareAdversaryDiff(diffText: string, cap: number = ADVERSARY_DIFF_CAP): string {
  if (diffText.length <= cap) return diffText;
  const totalKb = Math.ceil(diffText.length / 1024);
  const capKb = Math.ceil(cap / 1024);
  const banner = `[TRUNCATED: showing first ${capKb}KB of ${totalKb}KB diff - reviewer must flag incomplete coverage]\n\n`;
  return banner + diffText.slice(0, cap - banner.length);
}

export async function runAdversarySdk(params: {
  model: string;
  systemPrompt: string;
  diffText: string;
  timeoutSeconds: number;
}): Promise<{
  parsed: { verdict: "pass" | "revise" | "block"; findings: unknown[]; summary: string };
  sdkSessionId: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  diffTruncated: boolean;
  diffTotalBytes: number;
}> {
  const diffTotalBytes = params.diffText.length;
  const diffTruncated = diffTotalBytes > ADVERSARY_DIFF_CAP;
  const bounded = prepareAdversaryDiff(params.diffText);
  const r = await structuredCall<{ verdict: "pass" | "revise" | "block"; findings: unknown[]; summary: string }>({
    model: params.model,
    systemPrompt: params.systemPrompt,
    userMessage: `Here is the diff to review:\n\n${bounded}`,
    timeoutSeconds: params.timeoutSeconds,
    schema: AdversaryResultSchema as unknown as z.ZodType<{ verdict: "pass" | "revise" | "block"; findings: unknown[]; summary: string }>,
    callerLabel: "adversary",
  });
  return {
    parsed: r.parsed,
    sdkSessionId: r.sdkSessionId,
    costUsd: r.costUsd,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    diffTruncated,
    diffTotalBytes,
  };
}

/**
 * Default cost estimation table (USD per M tokens) as of 2026-07-13.
 *
 * Round-3 (2026-07-13): pricing drifts as Anthropic updates their catalogue.
 * These are DEFAULTS only — they can be overridden via `models.pricing` in
 * the plugin config. Prefer editing config over touching this table.
 */
export const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface PricingOptions {
  /** Model → { input, output } USD per M tokens. Merged over DEFAULT_PRICES. */
  override?: Record<string, { input: number; output: number }>;
  /** Fallback model used when the requested model isn't priced. */
  fallbackModel?: string;
}

/** Resolve the price row for a model, applying overrides then falling back. */
export function resolvePrice(
  model: string,
  opts: PricingOptions = {},
): { input: number; output: number } {
  const merged = { ...DEFAULT_PRICES, ...(opts.override ?? {}) };
  return merged[model] ?? merged[opts.fallbackModel ?? "claude-sonnet-5"] ?? { input: 3, output: 15 };
}

export function estimateSubTaskCost(model: string, tokens: number, opts: PricingOptions = {}): number {
  const p = resolvePrice(model, opts);
  // Rough 20/80 in/out split for planning purposes
  return (tokens * 0.2 * p.input + tokens * 0.8 * p.output) / 1_000_000;
}

/**
 * Compare the SDK's reported total_cost_usd against our estimate and return
 * a warning string if the drift exceeds `ratio` (default 0.2 = 20%). Returns
 * `null` when within tolerance, when estimated is 0, or when actual is missing.
 */
export function detectCostDrift(
  actualCostUsd: number | undefined,
  estimatedCostUsd: number,
  ratio = 0.2,
): string | null {
  if (actualCostUsd == null || actualCostUsd <= 0 || estimatedCostUsd <= 0) return null;
  const drift = Math.abs(actualCostUsd - estimatedCostUsd) / estimatedCostUsd;
  if (drift <= ratio) return null;
  const direction = actualCostUsd > estimatedCostUsd ? "UNDER" : "OVER";
  return `[cost-drift] estimate was ${direction}: est=$${estimatedCostUsd.toFixed(4)} actual=$${actualCostUsd.toFixed(4)} drift=${(drift * 100).toFixed(1)}% (threshold ${(ratio * 100).toFixed(0)}%). Consider updating models.pricing in plugin config.`;
}
