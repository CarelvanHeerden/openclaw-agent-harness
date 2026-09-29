import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStoreSync } from "../dist/state/store.js";
import { HostTurnAuthorityBroker, registerHostTurnHook } from "../dist/control/host-turn-broker.js";
import { registerHarnessTools } from "../dist/tools/registration.js";

const CHANGE = "chg_abcdefghijkl";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "host-turn-broker-"));
  const store = openStateStoreSync(join(dir, "state.db"));
  let now = 2_200_000_000_000;
  let hook;
  const calls = [];
  const target = {
    changeId: CHANGE,
    targetDigest: "review-1",
    updatedAt: now - 10_000,
    expiresAt: now + 900_000,
    budgetUsd: 12,
    timeLimitSeconds: 900,
    scope: ["README.md"],
    excludedScope: ["secrets/**"],
  };
  const service = {
    attestationTarget(operation, actor, conversation, changeId) {
      if (actor !== "U1" || conversation !== "user:U1" || changeId !== CHANGE) throw new Error("not found");
      return { ...target, targetDigest: `${operation}:${target.targetDigest}` };
    },
    attestationBindingDigest(changeId, attestation) {
      return createHash("sha256").update(JSON.stringify({ changeId, target: this.attestationTarget(attestation.operation, attestation.actorIdentity, attestation.conversationIdentity, changeId).targetDigest, attestation })).digest("hex");
    },
    async confirm(changeId, context) {
      calls.push({ operation: "confirm", changeId, context });
      return { ok: true, state: "running" };
    },
    async merge(changeId, context) {
      calls.push({ operation: "merge", changeId, context });
      return { ok: true, state: "merged" };
    },
    async prepare() { return { ok: true, changeId: CHANGE, state: "prepared" }; },
    result() { return { ok: true, changeId: CHANGE, state: "prepared" }; },
  };
  const broker = new HostTurnAuthorityBroker(service, store.db, () => now, 60_000);
  const tools = new Map();
  const api = {
    on(name, handler) { assert.equal(name, "message_received"); hook = handler; return () => { hook = undefined; }; },
    registerTool(factory, options) { tools.set(options.name, factory); return () => tools.delete(options.name); },
  };
  const disposeHook = registerHostTurnHook(api, broker);
  registerHarnessTools(api, { controlPlane: service, hostTurnAuthorityBroker: broker, authorisedUsers: ["U1"] });
  const toolContext = (overrides = {}) => ({
    requesterSenderId: "U1",
    hostEventId: "M1",
    sessionKey: "agent:main:slack:direct:U1",
    nativeChannelId: "D1",
    conversationId: "user:U1",
    messageChannel: "slack",
    agentAccountId: "default",
    deliveryContext: { channel: "slack", to: "user:U1", accountId: "default" },
    ...overrides,
  });
  const emit = (content, overrides = {}, contextOverrides = {}) => hook?.({
    content,
    timestamp: now - 100,
    messageId: "M1",
    senderId: "U1",
    sessionKey: "agent:main:slack:direct:U1",
    metadata: {
      provider: "slack", surface: "slack", originatingChannel: "slack",
      originatingTo: "user:U1", messageId: "M1", senderId: "U1",
    },
    ...overrides,
  }, {
    channelId: "slack",
    accountId: "default",
    conversationId: "user:U1",
    senderId: "U1",
    messageId: overrides.messageId ?? "M1",
    sessionKey: "agent:main:slack:direct:U1",
    ...contextOverrides,
  });
  const invoke = (name, changeId = CHANGE, context = toolContext()) =>
    tools.get(name)(context).execute({ changeId });
  return {
    store, service, broker, tools, calls, target, emit, invoke, toolContext,
    tick(ms) { now += ms; },
    reload() { return new HostTurnAuthorityBroker(service, store.db, () => now, 60_000); },
    close() { disposeHook(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("natural user language is host evidence; OpenClaw supplies the typed operation", async () => {
  const f = fixture();
  try {
    f.emit("That interpretation is right — keep every restriction and continue.");
    assert.equal(f.calls.length, 0, "a user turn alone never executes");
    const out = await f.invoke("harness_confirm_change");
    assert.equal(out.state, "running");
    assert.equal(f.calls.length, 1);
    const attestation = f.calls[0].context.trustedControlAttestation;
    assert.equal(attestation.provenance, "host_verified");
    assert.equal(attestation.operation, "confirm_change");
    assert.equal(attestation.actorIdentity, "U1");
    assert.equal(attestation.conversationIdentity, "user:U1");
    assert.equal(attestation.hostEventId, "M1");
  } finally { f.close(); }
});

test("preparation tells OpenClaw to keep approval in the conversation", async () => {
  const f = fixture();
  try {
    const prepare = f.tools.get("harness_prepare_change")(f.toolContext());
    const out = await prepare.execute({
      request: "Update only README.md, create a draft PR, and do not merge or deploy.",
      repository: "acme/repo",
    });
    assert.equal(out.state, "prepared");
    assert.equal(out.approval.mode, "openclaw_conversation");
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("tool input or invented context cannot authorize without a fresh host turn", async () => {
  const f = fixture();
  try {
    const out = await f.invoke("harness_confirm_change", CHANGE, f.toolContext({
      trustedControlAttestation: { provenance: "host_verified" },
    }));
    assert.equal(out.code, "confirmation_attestation_required");
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("one host turn authorizes at most one typed operation", async () => {
  const f = fixture();
  try {
    f.emit("Yes, proceed with the prepared work.");
    assert.equal((await f.invoke("harness_confirm_change")).ok, true);
    assert.equal((await f.invoke("harness_confirm_change")).code, "confirmation_attestation_required");
    assert.equal((await f.invoke("harness_merge_change")).code, "merge_attestation_required");
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test("a model-selected different change burns but cannot redirect the host turn", async () => {
  const f = fixture();
  try {
    f.emit("Proceed with the prepared README change.");
    assert.equal((await f.invoke("harness_confirm_change", "chg_otherpending12")).code, "confirmation_attestation_required");
    assert.equal((await f.invoke("harness_confirm_change")).code, "confirmation_attestation_required");
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("actor, session, account, conversation and thread are bound", async () => {
  for (const context of [
    { requesterSenderId: "U2" },
    { sessionKey: "agent:main:slack:direct:other", hostEventId: undefined },
    { agentAccountId: "other", deliveryContext: { channel: "slack", to: "user:U1", accountId: "other" } },
    { conversationId: "user:U2", deliveryContext: { channel: "slack", to: "user:U2", accountId: "default" } },
    { deliveryContext: { channel: "slack", to: "user:U1", accountId: "default", threadId: "other" } },
  ]) {
    const f = fixture();
    try {
      f.emit("Proceed.");
      const out = await f.invoke("harness_confirm_change", CHANGE, f.toolContext(context));
      assert.equal(out.ok, false);
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  }
});

test("changed target, stale events and internal turns fail closed", async () => {
  const changed = fixture();
  try {
    changed.emit("Proceed.");
    changed.target.targetDigest = "review-2";
    changed.target.updatedAt += 20_000;
    assert.equal((await changed.invoke("harness_confirm_change")).code, "stale_confirmation");
  } finally { changed.close(); }

  const stale = fixture();
  try {
    stale.emit("Proceed.", { timestamp: stale.target.updatedAt });
    assert.equal((await stale.invoke("harness_confirm_change")).code, "stale_confirmation");
  } finally { stale.close(); }

  const internal = fixture();
  try {
    internal.emit("Proceed.", {}, { callDepth: 1 });
    assert.equal((await internal.invoke("harness_confirm_change")).code, "confirmation_attestation_required");
  } finally { internal.close(); }
});

test("unclaimed host turns survive plugin reload and are consumed once", async () => {
  const f = fixture();
  try {
    f.emit("Proceed after reload.");
    const reloaded = f.reload();
    const attestation = reloaded.consume("confirm_change", CHANGE, f.toolContext());
    assert.equal(attestation.hostEventId, "M1");
    assert.throws(() => reloaded.consume("confirm_change", CHANGE, f.toolContext()), /fresh authenticated user turn/i);
  } finally { f.close(); }
});

test("confirmation and merge require separate fresh user turns", async () => {
  const f = fixture();
  try {
    f.emit("Run the prepared change.");
    assert.equal((await f.invoke("harness_confirm_change")).ok, true);
    f.tick(1_000);
    f.emit("Merge the exact ready PR.", {
      messageId: "M2",
      timestamp: f.target.updatedAt + 1_000,
      metadata: {
        provider: "slack", surface: "slack", originatingChannel: "slack",
        originatingTo: "user:U1", messageId: "M2", senderId: "U1",
      },
    });
    assert.equal((await f.invoke("harness_merge_change", CHANGE, f.toolContext({ hostEventId: "M2" }))).ok, true);
    assert.deepEqual(f.calls.map((call) => call.operation), ["confirm", "merge"]);
  } finally { f.close(); }
});
