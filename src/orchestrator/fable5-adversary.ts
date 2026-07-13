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
  vercelLogs?: string;
  model: string;
  timeoutSeconds: number;
}

export async function runAdversary(_input: AdversaryInput): Promise<ReviewReport> {
  // TODO(phase-3): @anthropic-ai/claude-agent-sdk with model=claude-fable-5,
  // system prompt = paranoid reviewer, tools = read_repo + read_diff only.
  throw new Error("runAdversary: not implemented (phase-0 scaffold)");
}
