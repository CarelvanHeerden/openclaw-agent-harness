import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlAttestationBroker, parseControlIntent, registerControlAttestationHook } from "../dist/control/attestation-broker.js";
import { ControlPlaneService } from "../dist/control/service.js";
import { ControlRepository } from "../dist/control/repository.js";
import { AutonomousControlEngine } from "../dist/control/engine.js";
import { InternalMergeService } from "../dist/control/merge.js";
import { openStateStoreSync } from "../dist/state/store.js";
import { registerHarnessTools } from "../dist/tools/registration.js";

const CHANGE = "chg_abcdefghijkl";

function fixture({ ambiguous = false } = {}) {
  let now = 2_000_000_000_000;
  const target = {
    changeId: CHANGE,
    targetDigest: "review-digest-1",
    updatedAt: now - 10_000,
    expiresAt: now + 900_000,
    budgetUsd: 12,
    timeLimitSeconds: 3600,
    scope: ["src/**"],
    excludedScope: ["secrets/**"],
  };
  const calls = [];
  const service = {
    attestationTarget(operation, actor, conversation, requested) {
      if (actor !== "U1" || conversation !== "D1" || (requested && requested !== CHANGE)) throw new Error("not found");
      return { ...target, targetDigest: `${operation}:${target.targetDigest}` };
    },
    attestationTargetForEvent(operation, actor, conversation, issuedAt, requested) {
      if (ambiguous && !requested) throw new Error("latest pending change is tied");
      return this.attestationTarget(operation, actor, conversation, requested ?? CHANGE);
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
  };
  const broker = new ControlAttestationBroker(service, () => now, 60_000);
  const tools = new Map();
  let messageHook;
  const api = {
    on(name, handler) {
      assert.equal(name, "message_received");
      messageHook = handler;
      return () => { messageHook = undefined; };
    },
    registerTool(factory, options) {
      tools.set(options.name, factory);
      return () => tools.delete(options.name);
    },
  };
  registerControlAttestationHook(api, broker);
  registerHarnessTools(api, { controlPlane: service, controlAttestationBroker: broker, authorisedUsers: ["U1"] });
  const toolContext = (overrides = {}) => ({
    requesterSenderId: "U1",
    hostEventId: "M1",
    sessionKey: "agent:main:slack:direct:U1",
    nativeChannelId: "D1",
    messageChannel: "slack",
    agentAccountId: "A1",
    deliveryContext: { channel: "slack", to: "D1", accountId: "A1", threadId: "T1" },
    ...overrides,
  });
  const emit = (content, overrides = {}, ctxOverrides = {}) => messageHook?.({
    content,
    timestamp: now - 100,
    threadId: "T1",
    messageId: "M1",
    senderId: "U1",
    metadata: { provider: "slack", surface: "slack", originatingChannel: "slack", originatingTo: "D1", threadId: "T1", messageId: "M1", senderId: "U1" },
    ...overrides,
  }, {
    channelId: "slack",
    accountId: "A1",
    conversationId: "D1",
    senderId: "U1",
    messageId: overrides.messageId ?? "M1",
    sessionKey: "agent:main:slack:direct:U1",
    ...ctxOverrides,
  });
  const invoke = (name, context = toolContext(), changeId = CHANGE) => tools.get(name)(context).execute({ changeId });
  return { target, service, broker, calls, emit, invoke, toolContext, tick(ms) { now += ms; } };
}

test("actual Slack DM hook and tool contexts bind bare Confirm to the latest pending change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attestation-live-"));
  const store = openStateStoreSync(join(dir, "state.db"));
  const repository = new ControlRepository(store.db);
  let now = 2_000_000_000_000;
  const engine = new AutonomousControlEngine({ repository, ownerId: "worker", leaseTtlMs: 60_000, now: () => now });
  const mergeService = new InternalMergeService(store.db, repository, { inspect: async () => { throw new Error("unused"); }, merge: async () => { throw new Error("unused"); }, verifyMerged: async () => false }, () => now);
  const service = new ControlPlaneService({
    db: store.db, repository, engine, mergeService, now: () => now,
    crystallise: async () => ({ kind: "brief", brief: { title: "Exact live confirmation", motivation: "exercise the host path", acceptanceCriteria: ["tested"], filesLikelyTouched: ["src/**"], outOfScope: [], repoHint: "o/r", riskLevel: "medium" } }),
    resolveRepository: async () => ({ repositoryIdentity: "o/r", baseRef: "main", baseRevision: "a".repeat(40), credentialRoute: "route", policyDigest: "b".repeat(64), securityClass: "medium" }),
    executeEngine: async () => { throw new Error("stop after durable confirmation"); },
  });
  try {
    await service.prepare({ request: "Keep an older pending change.", repository: "o/r" }, { requesterSenderId: "U1", conversationId: "user:U1" });
    now += 10;
    const prepared = await service.prepare({ request: "Make the latest exact bounded change.", repository: "o/r" }, { requesterSenderId: "U1", conversationId: "user:U1" });
    const broker = new ControlAttestationBroker(service, () => now, 60_000);
    const tools = new Map();
    let hook;
    const api = {
      on(name, handler) { assert.equal(name, "message_received"); hook = handler; return () => {}; },
      registerTool(factory, options) { tools.set(options.name, factory); return () => {}; },
    };
    registerControlAttestationHook(api, broker);
    registerHarnessTools(api, { controlPlane: service, controlAttestationBroker: broker, authorisedUsers: ["U1"] });
    now += 100;
    const slackMessageId = String(now / 1000);
    hook({
      from: "slack:U1", content: "Confirm", timestamp: now, messageId: slackMessageId, senderId: "U1",
      sessionKey: "agent:main:slack:direct:u1",
      metadata: { provider: "slack", surface: "slack", originatingChannel: "slack", originatingTo: "user:U1", messageId: slackMessageId, senderId: "U1" },
    }, {
      channelId: "slack", accountId: "default", conversationId: "user:U1", senderId: "U1", messageId: slackMessageId,
      sessionKey: "agent:main:slack:direct:u1",
    });
    const out = await tools.get("harness_confirm_change")({ requesterSenderId: "U1", sessionKey: "agent:main:slack:direct:u1", nativeChannelId: "D0123456789", messageChannel: "slack", agentAccountId: "default", deliveryContext: { channel: "slack", to: "user:U1", accountId: "default" } }).execute({ changeId: prepared.changeId });
    assert.equal(out.state, "running");
    const durable = store.db.prepare("SELECT host_event_id,actor_identity,conversation_identity,operation_kind FROM control_host_attestations").get();
    assert.deepEqual({ ...durable }, { host_event_id: slackMessageId, actor_identity: "U1", conversation_identity: "user:U1", operation_kind: "confirm_change" });
  } finally {
    service.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("documented message_received hook mints and tool consumes an exact host attestation", async () => {
  const f = fixture();
  f.emit(`I confirm the exact prepared change ${CHANGE}.`);
  assert.deepEqual(await f.invoke("harness_confirm_change"), { ok: true, state: "running" });
  assert.equal(f.calls.length, 1);
  const att = f.calls[0].context.trustedControlAttestation;
  assert.equal(att.provenance, "host_verified");
  assert.equal(att.operation, "confirm_change");
  assert.equal(att.actorIdentity, "U1");
  assert.equal(att.conversationIdentity, "D1");
  assert.equal(att.hostEventId, "M1");
  assert.match(att.nonce, /^[A-Za-z0-9_-]+$/);
  assert.match(att.bindingDigest, /^[a-f0-9]{64}$/);
});

test("ordinary conversational approvals and Markdown labels authorize the unique pending change", async () => {
  for (const wording of [
    "Confirm Smoke",
    "Yes",
    "Approved",
    "Go for it.",
    "Please got for it",
    "Let's do it.",
    "yes, run that README smoke",
    "**Looks good — go ahead with the `README` smoke.**",
    "```text\nPlease confirm Smoke\n```",
  ]) {
    const f = fixture();
    f.emit(wording);
    assert.equal((await f.invoke("harness_confirm_change")).ok, true, wording);
    assert.equal(f.calls.length, 1, wording);
  }
});

test("the tool call must belong to the same raw host event that expressed approval", async () => {
  const f = fixture();
  f.emit("Confirm Smoke");
  assert.equal((await f.invoke("harness_confirm_change", f.toolContext({ hostEventId: "M-other" }))).code, "confirmation_attestation_required");
  assert.equal(f.calls.length, 0);
});

test("the public OpenClaw tool context consumes by exact originating session when no host event id is projected", async () => {
  const f = fixture();
  f.emit("Confirm Smoke");
  assert.equal((await f.invoke("harness_confirm_change", f.toolContext({ hostEventId: undefined }))).ok, true);
  assert.equal(f.calls[0].context.trustedControlAttestation.hostEventId, "M1");
});

test("a raw confirmation cannot cross OpenClaw sessions when the tool context omits host event id", async () => {
  const f = fixture();
  f.emit("Confirm Smoke");
  assert.equal((await f.invoke("harness_confirm_change", f.toolContext({ hostEventId: undefined, sessionKey: "agent:main:slack:direct:other" }))).code, "confirmation_attestation_required");
  assert.equal(f.calls.length, 0);
});

test("a conversational approval cannot select among multiple pending changes", async () => {
  const f = fixture({ ambiguous: true });
  f.emit("yes, run that README smoke");
  assert.equal((await f.invoke("harness_confirm_change")).code, "confirmation_attestation_required");
  assert.equal(f.calls.length, 0);
});

test("re-delivery of the same Slack event cannot mint a second authorization", async () => {
  const f = fixture();
  f.emit("Confirm Smoke");
  assert.equal((await f.invoke("harness_confirm_change")).ok, true);
  f.emit("Confirm Smoke");
  assert.equal((await f.invoke("harness_confirm_change")).code, "confirmation_attestation_required");
  assert.equal(f.calls.length, 1);
});

test("real Slack hook shape derives freshness from the numeric-string message id", async () => {
  const f = fixture();
  const slackTs = String((f.target.updatedAt + 1_000) / 1000);
  f.emit(`confirm ${CHANGE}`, {
    timestamp: undefined,
    messageId: slackTs,
    metadata: {
      provider: "slack",
      surface: "slack",
      originatingChannel: "slack",
      originatingTo: "D1",
      threadId: "T1",
      messageId: slackTs,
      senderId: "U1",
    },
  }, { messageId: slackTs });
  assert.equal((await f.invoke("harness_confirm_change", f.toolContext({ hostEventId: slackTs }))).ok, true);
  assert.equal(f.calls[0].context.trustedControlAttestation.issuedAt, f.target.updatedAt + 1_000);
});

test("broker authorization is one-time and replay fails closed", async () => {
  const f = fixture();
  f.emit(`confirm ${CHANGE}`);
  assert.equal((await f.invoke("harness_confirm_change")).ok, true);
  assert.deepEqual(await f.invoke("harness_confirm_change"), {
    ok: false,
    code: "confirmation_attestation_required",
    summary: "A fresh raw-user confirmation event is required.",
  });
  assert.equal(f.calls.length, 1);
});

test("a model-selected different change cannot redirect and burns the raw-event capability", async () => {
  const f = fixture();
  f.emit("Confirm Smoke");
  assert.equal((await f.invoke("harness_confirm_change", f.toolContext(), "chg_otherpending12")).code, "confirmation_attestation_required");
  assert.equal((await f.invoke("harness_confirm_change")).code, "confirmation_attestation_required");
  assert.equal(f.calls.length, 0);
});

test("changed reviewed state, stale events, and expired broker records are rejected", async () => {
  const changed = fixture();
  changed.emit(`confirm ${CHANGE}`);
  changed.target.targetDigest = "review-digest-2";
  assert.equal((await changed.invoke("harness_confirm_change")).code, "stale_confirmation");

  const stale = fixture();
  stale.emit(`confirm ${CHANGE}`, { timestamp: stale.target.updatedAt });
  assert.equal((await stale.invoke("harness_confirm_change")).code, "confirmation_attestation_required");

  const expired = fixture();
  expired.emit(`confirm ${CHANGE}`);
  expired.tick(60_001);
  assert.equal((await expired.invoke("harness_confirm_change")).code, "confirmation_attestation_required");
});

test("wrong actor, conversation, channel, account, and thread cannot consume", async () => {
  for (const override of [
    { requesterSenderId: "U2" },
    { nativeChannelId: "D2", deliveryContext: { channel: "slack", to: "D2", accountId: "A1", threadId: "T1" } },
    { messageChannel: "discord", deliveryContext: { channel: "discord", to: "D1", accountId: "A1", threadId: "T1" } },
    { agentAccountId: "A2", deliveryContext: { channel: "slack", to: "D1", accountId: "A2", threadId: "T1" } },
    { deliveryContext: { channel: "slack", to: "D1", accountId: "A1", threadId: "T2" } },
  ]) {
    const f = fixture();
    f.emit(`confirm ${CHANGE}`);
    assert.equal((await f.invoke("harness_confirm_change", f.toolContext(override))).ok, false);
    assert.equal(f.calls.length, 0);
  }
});

test("material modifiers are rejected unless they exactly match prepared state", async () => {
  const mismatch = fixture();
  mismatch.emit(`confirm ${CHANGE}, budget $50`);
  assert.equal((await mismatch.invoke("harness_confirm_change")).code, "confirmation_attestation_required");

  const exact = fixture();
  exact.emit(`confirm ${CHANGE}, budget $12; time limit 3600 seconds; scope [src/**]; excluded scope [secrets/**]`);
  assert.equal((await exact.invoke("harness_confirm_change")).ok, true);
});

test("no raw-user event, ambiguous prose, and internal runtime/subagent events mint nothing", async () => {
  const cases = [
    undefined,
    ["confirm or merge this", {}, {}],
    [`confirm ${CHANGE}?`, {}, {}],
    [`do not confirm ${CHANGE}`, {}, {}],
    ["yes, maybe run that smoke", {}, {}],
    ["run the smoke, but increase the budget", {}, {}],
    ["run the smoke with an increased budget", {}, {}],
    ["run the smoke after the docs land", {}, {}],
    ["confirm the smoke and merge the PR", {}, {}],
    ["maybe", {}, {}],
    [`confirm ${CHANGE}\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`, {}, {}],
    [`confirm ${CHANGE}`, {}, { callDepth: 1 }],
    [`confirm ${CHANGE}`, { metadata: {} }, {}],
    [`confirm ${CHANGE}`, { sessionKey: "agent:main:subagent:child" }, { sessionKey: "agent:main:subagent:child" }],
    [`confirm ${CHANGE}`, { senderId: undefined, metadata: { provider: "slack", surface: "slack", originatingChannel: "slack", originatingTo: "D1", messageId: "M1" } }, { senderId: undefined }],
    [`confirm ${CHANGE}`, { messageId: undefined, metadata: { provider: "slack", surface: "slack", originatingChannel: "slack", originatingTo: "D1", senderId: "U1" } }, { messageId: "" }],
  ];
  for (const entry of cases) {
    const f = fixture();
    if (entry) f.emit(...entry);
    assert.equal((await f.invoke("harness_confirm_change")).code, "confirmation_attestation_required");
    assert.equal(f.calls.length, 0);
  }
});

test("external inbound run correlation is not mistaken for internal provenance", async () => {
  const f = fixture();
  f.emit(`confirm ${CHANGE}`, { runId: "run-correlated" }, { runId: "run-correlated" });
  assert.equal((await f.invoke("harness_confirm_change")).ok, true);
});

test("merge intent is independently parsed and operation-bound", async () => {
  const f = fixture();
  f.emit(`I authorize the merge of this ready pull request ${CHANGE}.`);
  assert.equal((await f.invoke("harness_merge_change")).ok, true);
  assert.equal(f.calls[0].context.trustedControlAttestation.operation, "merge_change");
});

test("intent grammar stays narrow", () => {
  assert.equal(parseControlIntent("please think about confirming"), undefined);
  assert.equal(parseControlIntent("confirm, but increase scope"), undefined);
  assert.equal(parseControlIntent(`confirm ${CHANGE} and merge ${CHANGE}`), undefined);
  assert.equal(parseControlIntent(`confirm ${CHANGE}`).operation, "confirm_change");
  assert.equal(parseControlIntent(`merge ${CHANGE}`).operation, "merge_change");
  assert.equal(parseControlIntent("Confirm Smoke").operation, "confirm_change");
  assert.equal(parseControlIntent("Approved").operation, "confirm_change");
  assert.equal(parseControlIntent("yes, run that README smoke").operation, "confirm_change");
  assert.equal(parseControlIntent("**Looks good — go ahead with the `README` smoke.**").operation, "confirm_change");
  assert.equal(parseControlIntent("Yes").operation, "confirm_change");
  assert.equal(parseControlIntent("Go for it.").operation, "confirm_change");
  assert.equal(parseControlIntent("Please got for it").operation, "confirm_change");
  assert.equal(parseControlIntent("Let's do it.").operation, "confirm_change");
});
