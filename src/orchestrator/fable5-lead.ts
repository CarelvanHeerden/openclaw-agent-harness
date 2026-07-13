/**
 * Fable-5 lead orchestrator.
 *
 * Plans the work as a DAG of sub-tasks, spawns Sonnet workers via the
 * Claude Agent SDK, assembles their outputs. Does NOT write code itself.
 *
 * PHASE 0 SCAFFOLD.
 */

export interface LeadInput {
  crystallisedPrompt: string;
  repoPath: string;
  budgetUsd: number;
}

export interface LeadPlan {
  subTasks: Array<{
    ordinal: number;
    description: string;
    workerModel: string;
    allowedPaths: string[];
  }>;
}

export interface LeadOutput {
  plan: LeadPlan;
  workerResults: unknown[]; // typed in phase 2
  assembledDiffPath: string;
  costUsd: number;
}

export async function runLead(_input: LeadInput): Promise<LeadOutput> {
  // TODO(phase-2): use @anthropic-ai/claude-agent-sdk with model=claude-fable-5,
  // system prompt = "planner + assembler", tools = spawn_worker/read_repo/write_summary.
  throw new Error("runLead: not implemented (phase-0 scaffold)");
}
