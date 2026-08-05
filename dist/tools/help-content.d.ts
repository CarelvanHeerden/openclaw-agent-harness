/**
 * beta.108: the harness's answer to "what can you do?".
 *
 * Written for the person in the Slack thread, not for the agent holding the
 * tools. Two rules kept it honest:
 *
 *   1. Describe outcomes, not tool names. Nobody types `harness_list_revisable`.
 *      They say "which PRs still need work", and the agent maps that to a call.
 *   2. Say what the harness will NOT do. The costliest misunderstandings so far
 *      have been about merging: the harness opens pull requests and refuses to
 *      merge one it has not signed off on, and a user who assumes otherwise
 *      waits for something that is never going to happen.
 *
 * `tools` is included so the agent can bridge a phrase to a call, but the
 * tool's own description tells it to relay the capabilities instead.
 */
export interface HelpCapability {
    what: string;
    say: string[];
    tools: string[];
}
export interface HarnessHelp {
    summary: string;
    capabilities: Record<string, HelpCapability[]>;
    limits: string[];
    tools: string[];
}
export declare function buildHarnessHelp(topic?: string): HarnessHelp;
//# sourceMappingURL=help-content.d.ts.map