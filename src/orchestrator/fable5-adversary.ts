/**
 * Fable-5 adversarial reviewer.
 *
 * Reads (spec, diff, repo view, optional Vercel logs). Emits a ReviewReport
 * with severity-tagged findings. Fresh session per cycle. Never edits code.
 *
 * PHASE 0 SCAFFOLD.
 */

export type ReviewVerdict = "pass" | "fixes_required" | "reject_and_replan";

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category:
    | "spec_fidelity"
    | "codebase_fit"
    | "security"
    | "quality"
    | "runtime";
  path?: string;
  message: string;
  suggestion?: string;
}

export interface ReviewReport {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  costUsd: number;
}

export interface AdversaryInput {
  crystallisedPrompt: string;
  diffPath: string;
  repoPath: string;
  runtime?: {
    provider: "vercel";
    status: "ok" | "no_deploy_yet" | "build_failed" | "unavailable";
    deploymentUrl?: string;
    logsExcerpt?: string;
    errorCount?: number;
  };
  model: string;
  timeoutSeconds: number;
}

/**
 * Adversary prompt-preamble helper. The orchestrator injects this string
 * verbatim into the adversary's system prompt so the reviewer never silently
 * skips the runtime dimension.
 */
export function runtimeBanner(input: AdversaryInput): string {
  if (!input.runtime) return "NO RUNTIME DATA AVAILABLE (runtime bridge disabled).";
  switch (input.runtime.status) {
    case "ok":
      return `RUNTIME DATA: Vercel preview ${input.runtime.deploymentUrl ?? "(unknown url)"} - ${input.runtime.errorCount ?? 0} error(s) in logs.`;
    case "no_deploy_yet":
      return "NO RUNTIME DATA AVAILABLE: preview deploy has not completed within the wait window. Do NOT sign off on runtime concerns.";
    case "build_failed":
      return `RUNTIME DATA: build FAILED for preview ${input.runtime.deploymentUrl ?? "(unknown url)"}. Treat as a critical finding unless the diff intentionally breaks the build.`;
    case "unavailable":
      return "NO RUNTIME DATA AVAILABLE: Vercel bridge returned an error. Do NOT sign off on runtime concerns.";
  }
}

export async function runAdversary(_input: AdversaryInput): Promise<ReviewReport> {
  // TODO(phase-3): @anthropic-ai/claude-agent-sdk with model=claude-fable-5,
  // system prompt = paranoid reviewer, tools = read_repo + read_diff only.
  throw new Error("runAdversary: not implemented (phase-0 scaffold)");
}
