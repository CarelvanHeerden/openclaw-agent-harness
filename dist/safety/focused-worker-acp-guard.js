/**
 * Adds worker-specific policy to the generic ACP guard.
 *
 * The generic guard must fail closed on unknown tool kinds. OpenCode's
 * in-session checklist is one known, side-effect-free `other` tool, while its
 * nested `task` agent is known to turn a bounded worker into an unbounded one.
 */
export function focusedWorkerAcpGuard(base) {
    return async (call) => {
        const raw = call.rawInput && typeof call.rawInput === "object"
            ? call.rawInput
            : {};
        if (call.kind === "other" && call.title === "todowrite") {
            return { allow: true };
        }
        if (call.kind === "think" &&
            (call.title === "task" || typeof raw["subagent_type"] === "string")) {
            return {
                allow: false,
                reason: "focused worker may not launch nested agents; use direct read/edit/bash tools",
            };
        }
        return base(call);
    };
}
//# sourceMappingURL=focused-worker-acp-guard.js.map