import type { HarnessPluginApi } from "../index.js";
import { ControlPlaneService } from "../control/service.js";
import type { HostTurnAuthorityBroker } from "../control/host-turn-broker.js";
/** Stable terminal envelope failures. */
export declare const CONTROL_TERMINAL_CODES: readonly ["budget_exceeded", "time_exceeded", "scope_escalation", "path_violation", "security_escalation", "credential_escalation"];
/**
 * Readiness is recorded only when state is pr_ready, verdict is pass,
 * blocking === 0, published_sha === pr_head_sha, required_ci and
 * runtime_evidence are present, and spend is inside the budget envelope.
 */
export declare const CONTROL_READINESS_PREDICATES = "state=pr_ready;verdict=pass;blocking===0;published_sha=pr_head_sha;required_ci;runtime_evidence;spend<=budget_envelope";
/** Trusted host fields include requesterSenderId and conversationId. */
/** Public error vocabulary for trusted boundaries. */
export declare const CONTROL_CONFIRMATION_DOMAIN = "control-plane-confirm/v2";
export declare const CONTROL_ATTESTATION_ERRORS: readonly ["confirmation_attestation_required", "stale_confirmation", "wrong_actor", "wrong_conversation", "already_confirmed", "confirmation_replayed", "merge_attestation_required", "stale_pr_head", "already_merged"];
type ControlRuntime = {
    controlPlane?: ControlPlaneService;
    hostTurnAuthorityBroker?: HostTurnAuthorityBroker;
    authorisedUsers?: readonly string[];
};
/**
 * OpenClaw translates ordinary language into typed operations. A confirm or
 * merge tool call is authoritative only when paired with a fresh authenticated
 * user turn captured independently by the host hook.
 */
export declare function registerHarnessTools(api: HarnessPluginApi, runtime: ControlRuntime): () => void;
export {};
//# sourceMappingURL=registration.d.ts.map