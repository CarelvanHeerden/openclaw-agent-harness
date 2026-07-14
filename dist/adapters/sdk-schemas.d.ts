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
export declare const ClassifierResultSchema: z.ZodObject<{
    intent: z.ZodEnum<{
        dev_task: "dev_task";
        clarify: "clarify";
        not_dev: "not_dev";
        unsafe: "unsafe";
    }>;
    reason: z.ZodString;
    suggestedClarification: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type ClassifierResultParsed = z.infer<typeof ClassifierResultSchema>;
export declare const CrystallisedBriefSchema: z.ZodObject<{
    title: z.ZodString;
    motivation: z.ZodString;
    acceptanceCriteria: z.ZodArray<z.ZodString>;
    filesLikelyTouched: z.ZodArray<z.ZodString>;
    outOfScope: z.ZodArray<z.ZodString>;
    repoHint: z.ZodOptional<z.ZodString>;
    branchHint: z.ZodOptional<z.ZodString>;
    riskLevel: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>;
}, z.core.$strip>;
export type CrystallisedBriefParsed = z.infer<typeof CrystallisedBriefSchema>;
export declare const LeadPlanSchema: z.ZodObject<{
    repo: z.ZodString;
    branch: z.ZodString;
    subTasks: z.ZodArray<z.ZodObject<{
        seq: z.ZodNumber;
        title: z.ZodString;
        intent: z.ZodString;
        filesLikelyTouched: z.ZodArray<z.ZodString>;
        successCriteria: z.ZodArray<z.ZodString>;
        estimatedTokens: z.ZodNumber;
        dependsOn: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
    }, z.core.$strip>>;
    reviewChecklist: z.ZodArray<z.ZodString>;
    riskLevel: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>;
}, z.core.$strip>;
export type LeadPlanParsed = z.infer<typeof LeadPlanSchema>;
export declare const AdversaryFindingSchema: z.ZodObject<{
    dimension: z.ZodOptional<z.ZodString>;
    severity: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    detail: z.ZodOptional<z.ZodString>;
    file: z.ZodOptional<z.ZodString>;
    line: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
export declare const AdversaryResultSchema: z.ZodObject<{
    verdict: z.ZodEnum<{
        pass: "pass";
        revise: "revise";
        block: "block";
    }>;
    findings: z.ZodArray<z.ZodObject<{
        dimension: z.ZodOptional<z.ZodString>;
        severity: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        detail: z.ZodOptional<z.ZodString>;
        file: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    summary: z.ZodString;
}, z.core.$strip>;
export type AdversaryResultParsed = z.infer<typeof AdversaryResultSchema>;
/**
 * Parse a JSON string and validate against a Zod schema. Throws with a
 * helpful message including the raw input (truncated) on any failure.
 */
export declare function parseAndValidate<T>(jsonText: string, schema: z.ZodType<T>, rawOutput: string, callerLabel: string): T;
//# sourceMappingURL=sdk-schemas.d.ts.map