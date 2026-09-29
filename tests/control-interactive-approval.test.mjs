import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStoreSync } from "../dist/state/store.js";
import { CONTROL_INTERACTIVE_NAMESPACE, InteractiveControlApprovals } from "../dist/control/interactive-approval.js";
import { registerHarnessTools } from "../dist/tools/registration.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "control-interactive-"));
  const store = openStateStoreSync(join(dir, "state.db"));
  let now = 2_100_000_000_000;
  const sent = [];
  const calls = [];
  const tools = new Map();
  let registration;
  const target = {
    changeId: "chg_interactive123",
    targetDigest: "a".repeat(64),
    updatedAt: now - 100,
    expiresAt: now + 900_000,
    budgetUsd: 12,
    timeLimitSeconds: 900,
    scope: ["README.md"],
    excludedScope: ["secrets/**"],
  };
  const run = {
    id: target.changeId,
    requesterId: "U1",
    conversationId: "user:U1",
  };
  store.db.prepare(`INSERT INTO control_runs
    (id,state,version,requester_id,conversation_id,repository,base_ref,brief_digest,policy_digest,
     authority_envelope_json,created_at,updated_at)
    VALUES (?,'awaiting_confirmation',1,'U1','user:U1','acme/widget','main',?,?,?, ?,?)`).run(
      run.id,
      "b".repeat(64),
      "c".repeat(64),
      JSON.stringify({
        version: 1,
        requesterId: "U1",
        conversationId: "user:U1",
        repository: "acme/widget",
        baseRef: "main",
        briefDigest: "b".repeat(64),
        policyDigest: "c".repeat(64),
        scope: { paths: ["README.md"] },
        allowedActions: ["implement"],
        limits: { budgetUsd: 12, activeTimeMs: 900_000, cycles: 1, retries: 0 },
        issuedAt: now - 1_000,
        expiresAt: now + 900_000,
        nonce: "fixture",
      }),
      now - 1_000,
      now - 100,
    );
  const service = {
    runForInteraction(id) { return id === run.id ? run : null; },
    attestationTarget(operation, actor, conversation, id) {
      if (id !== run.id || actor !== run.requesterId || conversation !== run.conversationId) throw new Error("not found");
      return { ...target, targetDigest: `${operation}:${target.targetDigest}` };
    },
    approvalReview(operation, id) {
      return {
        operation,
        changeId: id,
        brief: { title: "README smoke", acceptanceCriteria: ["README.md only", "draft PR", "no merge", "no deploy"] },
        scope: ["README.md"],
        excludedScope: ["secrets/**"],
        limits: { budgetUsd: 12, activeTimeMs: 900_000 },
      };
    },
    attestationBindingDigest(id, attestation) {
      return `${id}:${attestation.operation}:${attestation.hostEventId}`.padEnd(64, "0").slice(0, 64);
    },
    async confirm(id, context) {
      calls.push({ operation: "confirm", id, context });
      return { ok: true, summary: "running" };
    },
    async merge(id, context) {
      calls.push({ operation: "merge", id, context });
      return { ok: true, summary: "merged" };
    },
    async prepare() {
      return { ok: true, changeId: run.id, state: "prepared" };
    },
    result() { return { ok: true, changeId: run.id, state: "prepared" }; },
  };
  const api = {
    logger: { info() {}, warn() {}, error() {} },
    runtime: {
      gateway: {
        async request(method, params) {
          sent.push({ method, ...params, ...(params.params ?? {}) });
          return { ok: true };
        },
      },
    },
    registerInteractiveHandler(value) { registration = value; return () => { registration = undefined; }; },
    registerTool(factory, options) {
      tools.set(options.name, factory);
      return () => tools.delete(options.name);
    },
  };
  const approvals = new InteractiveControlApprovals(store.db, service, api, ["U1"], () => now);
  let dispose = approvals.register();
  const toolContext = {
    requesterSenderId: "U1",
    conversationId: "user:U1",
    nativeChannelId: "D1",
    messageChannel: "slack",
    agentAccountId: "default",
    deliveryContext: { channel: "slack", to: "user:U1", accountId: "default" },
    sessionKey: "agent:main:slack:direct:U1",
  };
  const click = async (payload, overrides = {}) => {
    const responses = [];
    const routedPayload = payload.startsWith(`${CONTROL_INTERACTIVE_NAMESPACE}:`)
      ? payload.slice(CONTROL_INTERACTIVE_NAMESPACE.length + 1)
      : payload;
    const result = await registration.handler({
      channel: "slack",
      accountId: "default",
      interactionId: `IX${calls.length + responses.length}`,
      conversationId: "user:U1",
      senderId: "U1",
      auth: { isAuthorizedSender: true },
      interaction: { kind: "button", payload: routedPayload },
      respond: {
        async acknowledge() { responses.push({ type: "ack" }); },
        async reply(value) { responses.push({ type: "reply", value }); },
        async editMessage(value) { responses.push({ type: "edit", value }); },
      },
      ...overrides,
    });
    return { result, responses };
  };
  const approvalButton = () => sent.at(-1).presentation.blocks.find((block) => block.type === "buttons").buttons[0];
  return {
    store, service, approvals, api, target, sent, calls, tools, toolContext, click, approvalButton,
    reloadApprovals() {
      dispose();
      const reloaded = new InteractiveControlApprovals(store.db, service, api, ["U1"], () => now);
      dispose = reloaded.register();
      return reloaded;
    },
    tick(ms) { now += ms; },
    close() { dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("prepared natural-language intent is rendered as a host-native approval button", async () => {
  const f = fixture();
  try {
    assert.equal(await f.approvals.presentConfirmation(f.target.changeId, f.toolContext), true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].method, "message.action");
    assert.equal(f.sent[0].action, "send");
    assert.equal(f.sent[0].sessionKey, "agent:main:slack:direct:U1");
    assert.match(f.sent[0].idempotencyKey, /^oah-control:confirm_change:/);
    assert.equal("blocks" in f.sent[0], false, "provider-native Slack blocks belong to the host renderer");
    assert.match(JSON.stringify(f.sent[0].presentation.blocks), /README\.md/);
    assert.match(JSON.stringify(f.sent[0].presentation.blocks), /900000/);
    const button = f.approvalButton();
    assert.equal(button.label, "Approve and run");
    assert.match(button.value, new RegExp(`^${CONTROL_INTERACTIVE_NAMESPACE}:approve\\.[A-Za-z0-9_-]+$`));
  } finally { f.close(); }
});

test("OpenClaw request translation prepares and presents without a magic confirmation phrase", async () => {
  const f = fixture();
  try {
    registerHarnessTools(f.api, {
      controlPlane: f.service,
      interactiveControlApprovals: f.approvals,
      authorisedUsers: ["U1"],
    });
    const prepare = f.tools.get("harness_prepare_change")(f.toolContext);
    const out = await prepare.execute({
      request: "Please update only README.md, open a draft PR, and never merge or deploy it.",
      repository: "acme/widget",
      scope: ["README.md"],
      excludedScope: ["secrets/**"],
      budgetUsd: 12,
      timeLimitSeconds: 900,
    });
    assert.equal(out.state, "prepared");
    assert.equal(out.approval.mode, "slack_interactive");
    assert.equal(out.approval.diagnostic, "presented");
    assert.equal(f.sent.length, 1);
    assert.equal(f.calls.length, 0, "preparation and interpretation never authorize execution");
  } finally { f.close(); }
});

test("large interpreted proposals are shown completely in ordered presentation blocks", async () => {
  const f = fixture();
  try {
    const marker = "restriction-".repeat(4_000);
    f.service.approvalReview = (operation, id) => ({ operation, changeId: id, completeRestriction: marker });
    assert.equal(await f.approvals.presentConfirmation(f.target.changeId, f.toolContext), true);
    const sections = f.sent[0].presentation.blocks.filter((block) => block.type === "text").slice(1);
    assert.ok(sections.length > 1);
    const rendered = sections.map((block) => block.text.replace(/^Proposal \d+\/\d+\n/, "")).join("");
    assert.match(rendered, /restriction-/);
    assert.equal(rendered.includes(marker), true, "the approval view must never silently truncate a restriction");
  } finally { f.close(); }
});

test("one authorized click confirms the exact state and replay is refused", async () => {
  const f = fixture();
  try {
    await f.approvals.presentConfirmation(f.target.changeId, f.toolContext);
    const payload = f.approvalButton().value;
    const accepted = await f.click(payload);
    assert.equal(accepted.result.handled, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].operation, "confirm");
    assert.equal(f.calls[0].context.trustedControlAttestation.provenance, "host_verified");
    assert.match(f.calls[0].context.trustedControlAttestation.hostEventId, /^interactive:/);
    assert.equal(accepted.responses.some((entry) => entry.type === "edit"), true);
    const replay = await f.click(payload);
    assert.equal(f.calls.length, 1);
    assert.match(replay.responses.at(-1).value.text, /already used|expired|replaced/i);
  } finally { f.close(); }
});

test("a prepared approval survives plugin reload and remains one-shot", async () => {
  const f = fixture();
  try {
    await f.approvals.presentConfirmation(f.target.changeId, f.toolContext);
    const payload = f.approvalButton().value;
    f.reloadApprovals();
    await f.click(payload);
    assert.equal(f.calls.length, 1);
    await f.click(payload);
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test("unauthorized clicks cannot consume another user's challenge", async () => {
  for (const overrides of [{ senderId: "U2" }, { auth: { isAuthorizedSender: false } }]) {
    const f = fixture();
    try {
      await f.approvals.presentConfirmation(f.target.changeId, f.toolContext);
      const payload = f.approvalButton().value;
      await f.click(payload, overrides);
      assert.equal(f.calls.length, 0);
      await f.click(payload);
      assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  }
});

test("a trusted click from the wrong account, conversation, or thread burns the one-shot challenge", async () => {
  for (const overrides of [{ accountId: "other" }, { conversationId: "user:U2" }, { threadId: "other-thread" }]) {
    const f = fixture();
    try {
      await f.approvals.presentConfirmation(f.target.changeId, f.toolContext);
      const payload = f.approvalButton().value;
      await f.click(payload, overrides);
      assert.equal(f.calls.length, 0);
      await f.click(payload);
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  }
});

test("changed reviewed state and expired buttons fail closed", async () => {
  const changed = fixture();
  try {
    await changed.approvals.presentConfirmation(changed.target.changeId, changed.toolContext);
    const payload = changed.approvalButton().value;
    changed.target.targetDigest = "b".repeat(64);
    const out = await changed.click(payload);
    assert.equal(changed.calls.length, 0);
    assert.match(out.responses.at(-1).value.text, /changed/i);
  } finally { changed.close(); }

  const expired = fixture();
  try {
    await expired.approvals.presentConfirmation(expired.target.changeId, expired.toolContext);
    const payload = expired.approvalButton().value;
    expired.tick(900_001);
    await expired.click(payload);
    assert.equal(expired.calls.length, 0);
  } finally { expired.close(); }
});

test("merge authorization is a separate structured interaction", async () => {
  const f = fixture();
  try {
    await f.approvals.presentConfirmation(f.target.changeId, f.toolContext);
    assert.equal(await f.approvals.presentMerge(f.target.changeId), true);
    const message = f.sent.at(-1);
    const button = f.approvalButton();
    assert.equal(button.label, "Approve merge");
    await f.click(button.value);
    assert.equal(f.calls.at(-1).operation, "merge");
  } finally { f.close(); }
});

test("ordinary agent tool catalog has no text-based execution or merge authority", () => {
  const names = [];
  const api = {
    registerTool(definition, options) { names.push(options?.name ?? definition.name); return () => {}; },
  };
  registerHarnessTools(api, { controlPlane: {}, interactiveControlApprovals: {}, authorisedUsers: ["U1"] });
  assert.deepEqual(names.sort(), ["harness_change_result", "harness_prepare_change"]);
});

test("missing host interactive API leaves approval unavailable and execution paused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "control-interactive-missing-"));
  const store = openStateStoreSync(join(dir, "state.db"));
  const approvals = new InteractiveControlApprovals(
    store.db,
    { runForInteraction() { return { requesterId: "U1", conversationId: "user:U1" }; } },
    { logger: { warn() {}, info() {}, error() {} }, registerInteractiveHandler() {} },
    ["U1"],
  );
  try {
    const dispose = approvals.register();
    assert.equal(await approvals.presentConfirmation("chg_missingapi12", {
      requesterSenderId: "U1", conversationId: "user:U1", nativeChannelId: "D1",
      messageChannel: "slack", agentAccountId: "default",
      sessionKey: "agent:main:slack:direct:U1",
      deliveryContext: { channel: "slack", to: "user:U1", accountId: "default" },
    }), false);
    assert.equal(approvals.diagnostic("chg_missingapi12"), "host_outbound_gateway_unavailable");
    dispose();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
