/**
 * Prompt crystalliser.
 *
 * Multi-turn refinement of the user's initial task prompt into a structured
 * "crystallised prompt" document, negotiated over 2-3 Slack replies.
 *
 * Output shape (Markdown):
 *
 *   # Task: <title>
 *   ## Repo
 *   ## Acceptance criteria
 *   ## Constraints
 *   ## Budget override
 *   ## Notes
 *
 * PHASE 0 SCAFFOLD.
 */

export interface CrystalliseInput {
  initialPrompt: string;
  requester: string;
  slackThread: string;
}

export interface CrystalliseOutput {
  crystallised: string;
  targetRepo: string;
  budgetOverrideUsd?: number;
  turns: number;
}

export async function crystallisePrompt(
  _input: CrystalliseInput,
): Promise<CrystalliseOutput> {
  // TODO(phase-1): Haiku/Sonnet round-trip. Extract slots from user replies.
  //                Short-circuit on ":rocket:" reaction.
  throw new Error("crystallisePrompt: not implemented (phase-0 scaffold)");
}
