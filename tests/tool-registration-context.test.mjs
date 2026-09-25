import test from "node:test";
import assert from "node:assert/strict";
import { ControlError } from "../dist/control/service.js";
import { registerHarnessTools } from "../dist/tools/registration.js";

function openClawRegistrationHost() {
  const registrations = new Map();
  return {
    api: {
      registerTool(factory, options) {
        // Match OpenClaw's function-registration contract: names come from
        // options and factories are materialized later with the live context.
        assert.equal(typeof factory, "function");
        const names = [...(options?.names ?? []), ...(options?.name ? [options.name] : [])];
        assert.equal(names.length, 1);
        registrations.set(names[0], factory);
        return () => registrations.delete(names[0]);
      },
    },
    materialize(name, context) {
      const factory = registrations.get(name);
      assert.ok(factory, `missing registration for ${name}`);
      return factory(context);
    },
    names() {
      return [...registrations.keys()].sort();
    },
  };
}

test("OpenClaw contextual registration binds live requester and native conversation", async () => {
  const calls = [];
  const host = openClawRegistrationHost();
  registerHarnessTools(host.api, {
    controlPlane: {
      prepare: async (input, context) => (calls.push({ operation: "prepare", input, context }), { ok: true }),
      confirm: async (changeId, context) => (calls.push({ operation: "confirm", changeId, context }), { ok: true }),
    },
  });

  assert.deepEqual(host.names(), [
    "harness_change_result",
    "harness_confirm_change",
    "harness_merge_change",
    "harness_prepare_change",
  ]);

  const liveContext = { requesterSenderId: "U-live", nativeChannelId: "D-live" };
  await host.materialize("harness_prepare_change", liveContext).execute({
    request: "Make a bounded repository change.",
    repository: "owner/repo",
  });
  await host.materialize("harness_confirm_change", liveContext).execute(
    "call-id",
    { changeId: "chg_abcdefghijkl" },
    { requesterSenderId: "U-attacker", conversationId: "C-attacker" },
  );

  assert.deepEqual(calls.map(({ operation, context }) => ({ operation, context })), [
    {
      operation: "prepare",
      context: {
        requesterSenderId: "U-live",
        conversationId: "D-live",
        workspaceId: undefined,
        trustedControlAttestation: undefined,
      },
    },
    {
      operation: "confirm",
      context: {
        requesterSenderId: "U-live",
        conversationId: "D-live",
        workspaceId: undefined,
        trustedControlAttestation: undefined,
      },
    },
  ]);
});

test("contextual tools still fail closed without trusted host turn context", async () => {
  const host = openClawRegistrationHost();
  registerHarnessTools(host.api, {
    controlPlane: {
      prepare: async (_input, context) => {
        if (!context.requesterSenderId) {
          throw new ControlError("trusted_actor_required", "An authenticated requester is required.");
        }
        if (!context.conversationId) {
          throw new ControlError("trusted_conversation_required", "A trusted conversation is required.");
        }
        assert.fail("execution arguments must not supply trusted identity");
      },
    },
  });

  const attackerInput = {
    request: "Make a bounded repository change.",
    repository: "owner/repo",
    requesterSenderId: "U-attacker",
    conversationId: "C-attacker",
  };
  assert.deepEqual(await host.materialize("harness_prepare_change", {}).execute(attackerInput), {
    ok: false,
    code: "trusted_actor_required",
    summary: "An authenticated requester is required.",
  });
  assert.deepEqual(
    await host.materialize("harness_prepare_change", { requesterSenderId: "U-live" }).execute(attackerInput),
    {
      ok: false,
      code: "trusted_conversation_required",
      summary: "A trusted conversation is required.",
    },
  );
});
