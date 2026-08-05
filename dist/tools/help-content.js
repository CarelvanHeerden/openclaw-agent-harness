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
const CAPABILITIES = {
    starting: [
        {
            what: "Build a change end to end: plan it, write it, review it adversarially, and open a pull request.",
            say: [
                "add a continuity-exercises page with list and detail views",
                "the upload route should persist the file kind and title",
            ],
            tools: ["harness_run"],
        },
        {
            what: "Say roughly what a change will cost before committing to it. Every run reports an estimate and a cap up front.",
            say: ["how much would it cost to add audit logging?"],
            tools: ["harness_run"],
        },
    ],
    during: [
        {
            what: "Show what the run is doing right now — which sub-task, what it has committed, what it has spent.",
            say: ["how's it going?", "what's it working on?"],
            tools: ["harness_progress"],
        },
        {
            what: "Answer a question the harness got stuck on. It pauses and asks rather than guessing when a plan and the repository disagree.",
            say: ["use the (portal) route group, not (app)"],
            tools: ["harness_answer"],
        },
        {
            what: "Stop a run, or restart one that was interrupted.",
            say: ["stop that", "pick that back up"],
            tools: ["harness_cancel", "harness_resume"],
        },
    ],
    after: [
        {
            what: "Keep working on a pull request the review did not sign off on. It addresses the outstanding findings and updates the SAME pull request rather than opening another.",
            say: ["fix the findings on that PR", "keep going on 932"],
            tools: ["harness_revise", "harness_list_revisable"],
        },
        {
            what: "List the pull requests the harness opened that are not yet ready to merge.",
            say: ["what's still outstanding?"],
            tools: ["harness_list_revisable"],
        },
        {
            what: "Merge a pull request and verify the deployment. Refused unless the review signed off — the refusal explains what is still wrong.",
            say: ["merge it"],
            tools: ["harness_merge_pr"],
        },
        {
            what: "Explain why a run ended where it did, and what it found.",
            say: ["why did it stop?", "what did the review say?"],
            tools: ["harness_session_get", "harness_logs"],
        },
    ],
    budget: [
        {
            what: "Each run has a cost cap, and each person has a daily one. Crossing the run's cap warns and carries on; the daily cap stops the work.",
            say: ["what have I spent today?"],
            tools: ["harness_status", "harness_telemetry"],
        },
        {
            what: "Raise a cap mid-run by adding a :moneybag: reaction to the thread.",
            say: [],
            tools: [],
        },
    ],
};
const LIMITS = [
    "It opens pull requests. It does not push to main.",
    "It will not merge a pull request its own review did not sign off on — ask it why, or ask it to revise.",
    "A run that hits the cycle ceiling while still improving will say so and offer to continue; that is not a failure.",
    "It works on one repository per run, and each Slack thread is one independent run.",
];
const ALL_TOOLS = [
    "harness_run",
    "harness_start_session",
    "harness_progress",
    "harness_status",
    "harness_session_get",
    "harness_logs",
    "harness_health",
    "harness_telemetry",
    "harness_upload_logs",
    "harness_cancel",
    "harness_resume",
    "harness_answer",
    "harness_merge_pr",
    "harness_list_revisable",
    "harness_revise",
    "harness_onboard",
    "harness_retention_prune",
    "harness_bootstrap_test_repo",
    "harness_help",
];
export function buildHarnessHelp(topic = "all") {
    const wanted = topic === "all" || !(topic in CAPABILITIES) ? Object.keys(CAPABILITIES) : [topic];
    const capabilities = {};
    for (const k of wanted)
        capabilities[k] = CAPABILITIES[k];
    return {
        summary: "I can take a change you describe in plain English, plan it against the actual repository, write it, review it adversarially, and open a pull request — then keep working on that pull request until the review signs off.",
        capabilities,
        limits: LIMITS,
        tools: ALL_TOOLS,
    };
}
//# sourceMappingURL=help-content.js.map