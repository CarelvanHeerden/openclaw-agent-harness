export declare const PLUGIN_ID = "openclaw-agent-harness";
export declare const PLUGIN_NAME = "OpenClaw Agent Harness";
export declare const PLUGIN_DESCRIPTION = "Multi-agent development harness: crystallise -> plan -> execute -> adversarial review -> PR.";
/**
 * rc.3: the version of the clarification-answer policy that `harness_answer`
 * enforces and `harness-clarification-steward` follows. Recorded on every
 * answer audit, because "was this allowed at the time" is a question about the
 * rules in force then, not the rules in force when somebody reads the log.
 *
 * Bump this whenever what may be answered automatically changes. It moves
 * independently of `pluginVersion`, which changes for reasons that have nothing
 * to do with the policy.
 *
 * rc.6: a budget-extension pause may not be answered by an agent under any
 * configuration. The steward's own rules already said so ("Budget approval or
 * any increase"), but only the delegation flag was enforced, so a delegated
 * deployment would have taken the grant. The version moves because that is the
 * difference between "the docs asked nicely" and "the harness refused" -- an
 * answer audited under rc.3 could have raised a ceiling; one audited under
 * rc.6 could not.
 */
export declare const CLARIFICATION_POLICY_VERSION = "clarification-policy/2026-09-rc.6";
export declare const PLUGIN_VERSION: {
    readonly pluginVersion: "2.0.0-rc.6";
    readonly schemaVersion: 1;
    readonly claudeSdkVersion: "0.3.207";
};
//# sourceMappingURL=version.d.ts.map