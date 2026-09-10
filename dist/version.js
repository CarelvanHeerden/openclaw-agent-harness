export const PLUGIN_ID = "openclaw-agent-harness";
export const PLUGIN_NAME = "OpenClaw Agent Harness";
export const PLUGIN_DESCRIPTION = "Multi-agent development harness: crystallise -> plan -> execute -> adversarial review -> PR.";
/**
 * rc.3: the version of the clarification-answer policy that `harness_answer`
 * enforces and `harness-clarification-steward` follows. Recorded on every
 * answer audit, because "was this allowed at the time" is a question about the
 * rules in force then, not the rules in force when somebody reads the log.
 *
 * Bump this whenever what may be answered automatically changes. It moves
 * independently of `pluginVersion`, which changes for reasons that have nothing
 * to do with the policy.
 */
export const CLARIFICATION_POLICY_VERSION = "clarification-policy/2026-09-rc.3";
export const PLUGIN_VERSION = {
    pluginVersion: "2.0.0-rc.5",
    schemaVersion: 1,
    claudeSdkVersion: "0.3.207",
};
//# sourceMappingURL=version.js.map