import type { HarnessPluginApi, HarnessToolContext, HarnessToolDefinition } from "../index.js";
import { ControlError, ControlPlaneService, type PrepareChangeInput, type TrustedControlContext } from "../control/service.js";

/** Stable terminal envelope failures. */
export const CONTROL_TERMINAL_CODES = [
  "budget_exceeded",
  "time_exceeded",
  "scope_escalation",
  "path_violation",
  "security_escalation",
  "credential_escalation",
] as const;

/**
 * Readiness is recorded only when state is pr_ready, verdict is pass,
 * blocking === 0, published_sha === pr_head_sha, required_ci and
 * runtime_evidence are present, and spend is inside the budget envelope.
 */
export const CONTROL_READINESS_PREDICATES = "state=pr_ready;verdict=pass;blocking===0;published_sha=pr_head_sha;required_ci;runtime_evidence;spend<=budget_envelope";

/** Trusted host fields include requesterSenderId and conversationId. */
/** Public error vocabulary for trusted boundaries. */
export const CONTROL_CONFIRMATION_DOMAIN = "control-plane-confirm/v2";
export const CONTROL_ATTESTATION_ERRORS = [
  "confirmation_attestation_required", "stale_confirmation", "wrong_actor", "wrong_conversation",
  "already_confirmed", "confirmation_replayed", "merge_attestation_required", "stale_pr_head", "already_merged",
] as const;

type ToolDisposer = (() => void) | { dispose?: () => void; unregister?: () => void };

const CHANGE_ID_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["changeId"],
  properties: { changeId: { type: "string", pattern: "^chg_[A-Za-z0-9_-]{12,}$" } },
} as const;

const PREPARE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["request", "repository"],
  properties: {
    request: { type: "string", minLength: 10, maxLength: 100000 },
    repository: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$" },
    baseRef: { type: "string", minLength: 1, maxLength: 240 },
    scope: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500 } },
    excludedScope: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500 } },
    budgetUsd: { type: "number", exclusiveMinimum: 0 },
    timeLimitSeconds: { type: "integer", minimum: 60 },
  },
} as const;

function toDispose(value: ToolDisposer): () => void {
  return () => {
    if (typeof value === "function") value();
    else if (typeof value?.dispose === "function") value.dispose();
    else if (typeof value?.unregister === "function") value.unregister();
  };
}

function contextualToolFactory(
  name: string,
  build: (context: HarnessToolContext) => HarnessToolDefinition,
): ((context: HarnessToolContext) => HarnessToolDefinition) & HarnessToolDefinition {
  const factory = ((context: HarnessToolContext) => build(context ?? {})) as
    ((context: HarnessToolContext) => HarnessToolDefinition) & HarnessToolDefinition;
  const fallback = build({});
  const { name: _name, ...metadata } = fallback;
  Object.defineProperty(factory, "name", { value: name, enumerable: true, configurable: true });
  Object.assign(factory, metadata);
  return factory;
}

function invocation(inputOrCallId: unknown, paramsOrContext?: unknown, executionContext?: unknown): { input: Record<string, unknown>; context: TrustedControlContext } {
  if (typeof inputOrCallId === "string" && paramsOrContext && typeof paramsOrContext === "object") {
    return { input: paramsOrContext as Record<string, unknown>, context: (executionContext ?? {}) as TrustedControlContext };
  }
  return { input: (inputOrCallId ?? {}) as Record<string, unknown>, context: (paramsOrContext ?? executionContext ?? {}) as TrustedControlContext };
}

function trustedConversationId(context: HarnessToolContext): string | undefined {
  // OpenClaw exposes the active platform conversation as nativeChannelId.
  // conversationId is retained for compatible hosts and tests only.
  return context.nativeChannelId?.trim() || context.conversationId?.trim() || undefined;
}

function safeFailure(error: unknown): Record<string, unknown> {
  if (error instanceof ControlError) return { ok: false, code: error.code, summary: error.message };
  return { ok: false, code: "control_unavailable", summary: "The change service is temporarily unavailable." };
}

type ControlRuntime = { controlPlane?: ControlPlaneService; authorisedUsers?: readonly string[] };

function serviceFor(runtime: ControlRuntime): ControlPlaneService {
  const service = runtime.controlPlane;
  if (!service) throw new ControlError("control_unavailable", "The change service is not available.");
  return service;
}

function tool(
  name: string,
  description: string,
  parameters: unknown,
  context: HarnessToolContext,
  run: (service: ControlPlaneService, input: Record<string, unknown>, trusted: TrustedControlContext) => Promise<unknown> | unknown,
  runtime: ControlRuntime,
): HarnessToolDefinition {
  return {
    name,
    description,
    parameters,
    inputSchema: parameters,
    async execute(inputOrCallId: unknown, paramsOrContext?: unknown, executionContext?: unknown): Promise<unknown> {
      try {
        const call = invocation(inputOrCallId, paramsOrContext, executionContext);
        // Only the context captured by the host while constructing the tool is
        // trusted. Execution arguments are model/user-controlled data and must
        // never supply identity or mint a "host_verified" attestation when the
        // host did not provide one.
        const trusted = {
          requesterSenderId: context.requesterSenderId,
          conversationId: trustedConversationId(context),
          workspaceId: context.workspaceId,
          trustedControlAttestation: context.trustedControlAttestation,
        } satisfies TrustedControlContext;
        const actor = trusted.requesterSenderId?.trim() ?? "";
        if (runtime.authorisedUsers && !runtime.authorisedUsers.includes(actor)) {
          throw new ControlError("unauthorised_requester", "This requester is not authorised to use the change service.");
        }
        return await run(serviceFor(runtime), call.input, trusted);
      } catch (error) {
        return safeFailure(error);
      }
    },
  };
}

/**
 * Register the ordinary OpenClaw product surface. It intentionally contains
 * four operations and no direct commands. Diagnostics remain host/operator
 * services rather than aliases in an ordinary user's catalog.
 */
export function registerHarnessTools(api: HarnessPluginApi, runtime: ControlRuntime): () => void {
  const disposers: Array<() => void> = [];
  const rt = runtime;

  const definitions: Array<[string, (context: HarnessToolContext) => HarnessToolDefinition]> = [
    ["harness_prepare_change", (context) => tool(
      "harness_prepare_change",
      "Prepare one complete repository change for review without starting implementation.",
      PREPARE_SCHEMA,
      context,
      (service, input, trusted) => service.prepare(input as unknown as PrepareChangeInput, trusted),
      rt,
    )],
    ["harness_confirm_change", (context) => tool(
      "harness_confirm_change",
      "Confirm the exact prepared change in the authenticated conversation.",
      CHANGE_ID_SCHEMA,
      context,
      (service, input, trusted) => service.confirm(String(input.changeId ?? ""), trusted),
      rt,
    )],
    ["harness_change_result", (context) => tool(
      "harness_change_result",
      "Read the safe current or final outcome of a change.",
      CHANGE_ID_SCHEMA,
      context,
      (service, input, trusted) => service.result(String(input.changeId ?? ""), trusted),
      rt,
    )],
    ["harness_merge_change", (context) => tool(
      "harness_merge_change",
      "Merge a ready pull request after a separate authenticated decision.",
      CHANGE_ID_SCHEMA,
      context,
      (service, input, trusted) => service.merge(String(input.changeId ?? ""), trusted),
      rt,
    )],
  ];

  for (const [name, build] of definitions) {
    // Function registrations require an explicit name so OpenClaw can bind the
    // declared contract and materialize the factory with live turn context.
    disposers.push(toDispose(api.registerTool(contextualToolFactory(name, build), { name })));
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
