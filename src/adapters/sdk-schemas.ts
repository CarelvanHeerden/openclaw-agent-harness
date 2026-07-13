/**
 * Zod schemas for structured outputs returned by Claude via the Agent SDK.
 *
 * Round-3 (2026-07-13): `extractJson()` previously handed the first JSON
 * object found straight back to the caller. If the model responded with
 * a plausible-looking but wrong-shape object, downstream code would then
 * blow up in a distant place with a confusing error. These schemas gate
 * that at the adapter boundary — every structured call now round-trips
 * through Zod so any drift shows up with a clear "schema mismatch" error
 * including the raw output for debugging.
 */

import { z } from "zod";

// ---- Classifier ----

export const ClassifierResultSchema = z.object({
  intent: z.enum(["dev_task", "clarify", "not_dev", "unsafe"]),
  reason: z.string().min(1),
  suggestedClarification: z.string().optional(),
});

export type ClassifierResultParsed = z.infer<typeof ClassifierResultSchema>;

// ---- Crystalliser ----

export const CrystallisedBriefSchema = z.object({
  title: z.string().min(1),
  motivation: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  filesLikelyTouched: z.array(z.string()),
  outOfScope: z.array(z.string()),
  repoHint: z.string().optional(),
  branchHint: z.string().optional(),
  riskLevel: z.enum(["low", "medium", "high"]),
});

export type CrystallisedBriefParsed = z.infer<typeof CrystallisedBriefSchema>;

// ---- Lead planner ----

const LeadSubTaskSchema = z.object({
  seq: z.number().int().nonnegative(),
  title: z.string().min(1),
  intent: z.string().min(1),
  filesLikelyTouched: z.array(z.string()),
  successCriteria: z.array(z.string().min(1)).min(1),
  estimatedTokens: z.number().int().positive(),
  dependsOn: z.array(z.number().int().nonnegative()).optional(),
});

export const LeadPlanSchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/repo"),
  branch: z.string().regex(/^harness\//, "branch must start with harness/"),
  subTasks: z.array(LeadSubTaskSchema).min(1).max(20),
  reviewChecklist: z.array(z.string().min(1)).min(1),
  riskLevel: z.enum(["low", "medium", "high"]),
});

export type LeadPlanParsed = z.infer<typeof LeadPlanSchema>;

// ---- Adversary ----

export const AdversaryFindingSchema = z.object({
  dimension: z.string().optional(),
  severity: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
}).passthrough();

export const AdversaryResultSchema = z.object({
  verdict: z.enum(["pass", "revise", "block"]),
  findings: z.array(AdversaryFindingSchema),
  summary: z.string(),
});

export type AdversaryResultParsed = z.infer<typeof AdversaryResultSchema>;

/**
 * Parse a JSON string and validate against a Zod schema. Throws with a
 * helpful message including the raw input (truncated) on any failure.
 */
export function parseAndValidate<T>(
  jsonText: string,
  schema: z.ZodType<T>,
  rawOutput: string,
  callerLabel: string,
): T {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `[${callerLabel}] model returned invalid JSON: ${String(err)}. Raw output (first 500 chars): ${rawOutput.slice(0, 500)}`,
    );
  }
  const result = schema.safeParse(obj);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `[${callerLabel}] model output failed schema validation (${issues}). Raw output (first 500 chars): ${rawOutput.slice(0, 500)}`,
    );
  }
  return result.data;
}
