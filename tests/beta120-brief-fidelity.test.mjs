/**
 * beta.120: brief fidelity.
 *
 * The bug these pin down, concretely. On the b119 take-2 smoke the user handed
 * OpenClaw a 10,710-byte spec for a BCP/DR ARTEFACT LIBRARY -- dated records of
 * disaster-recovery tests that had already been run. OpenClaw passed the harness
 * a ~40-line summary it wrote itself, in which `performedAt` had become
 * `scheduledAt`, the status vocabulary had changed, and `exerciseType`,
 * `nextDueAt`, `period`, `results` and `relatedControlId` had vanished. The
 * harness built the summary faithfully: a system for PLANNING future exercises.
 * ~$18 and ~2h, twice, for the wrong feature.
 *
 * The harness's crystalliser was never at fault -- the identical file, read off
 * disk by the local driver, crystallised with every field intact. The loss was
 * in the hop between the user's file and the tool call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let briefSource, briefConfirmation, registerHarnessTools, Database;
try {
  briefSource = await import("../dist/tools/brief-source.js");
  briefConfirmation = await import("../dist/tools/brief-confirmation.js");
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  briefSource = null;
}

const skip = briefSource === null;
const here = dirname(fileURLToPath(import.meta.url));
const regSrc = readFileSync(resolve(here, "..", "src", "tools", "registration.ts"), "utf8");

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "b120-brief-"));
}

// ---------------------------------------------------------------------------
// Fix B: read the spec from disk instead of trusting a retelling of it
// ---------------------------------------------------------------------------

test("beta120: file reads are OFF until an operator names the safe directories", { skip }, () => {
  const { readRequestFile } = briefSource;
  const r = readRequestFile("/anywhere/brief.md", { allowedRoots: [], maxBytes: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "disabled");
  // The harness holds GitHub tokens and a brief's text reaches PR bodies, so
  // secure-by-default is the only defensible posture.
  assert.match(r.message, /request_file_roots/);
});

test("beta120: a brief inside an allowed root is read verbatim", { skip }, () => {
  const { readRequestFile } = briefSource;
  const root = tempRoot();
  const p = join(root, "dr-bcp.md");
  const body = "# DR/BCP\n\nperformedAt is the date the test was RUN.\n";
  writeFileSync(p, body);
  const r = readRequestFile(p, { allowedRoots: [root], maxBytes: 100000 });
  assert.equal(r.ok, true);
  assert.equal(r.text, body, "bytes, not a summary");
  assert.equal(r.bytes, Buffer.byteLength(body, "utf8"));
  rmSync(root, { recursive: true, force: true });
});

test("beta120: a relative path is refused", { skip }, () => {
  const { readRequestFile } = briefSource;
  const r = readRequestFile("briefs/dr.md", { allowedRoots: ["/tmp"], maxBytes: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_absolute");
});

test("beta120: a path outside every root is refused", { skip }, () => {
  const { readRequestFile } = briefSource;
  const rootA = tempRoot();
  const rootB = tempRoot();
  const outside = join(rootB, "secret.md");
  writeFileSync(outside, "not for you");
  const r = readRequestFile(outside, { allowedRoots: [rootA], maxBytes: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "outside_allowed_roots");
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

test("beta120: a sibling directory sharing the root's name prefix is NOT inside it", { skip }, () => {
  const { isInsideRoot } = briefSource;
  // Naive startsWith() would let /srv/briefs-secret pass a /srv/briefs root.
  assert.equal(isInsideRoot("/srv/briefs-secret/x.md", "/srv/briefs"), false);
  assert.equal(isInsideRoot("/srv/briefs/x.md", "/srv/briefs"), true);
  assert.equal(isInsideRoot("/srv/briefs", "/srv/briefs"), true);
});

test("beta120: a symlink planted in an allowed root cannot reach outside it", { skip }, () => {
  const { readRequestFile } = briefSource;
  const root = tempRoot();
  const elsewhere = tempRoot();
  const secret = join(elsewhere, "token.txt");
  writeFileSync(secret, "ghp_realtokenvalue");
  const link = join(root, "innocent-brief.md");
  try {
    symlinkSync(secret, link);
  } catch {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
    return; // platform without symlink permission
  }
  const r = readRequestFile(link, { allowedRoots: [root], maxBytes: 1000 });
  assert.equal(r.ok, false, "symlinks must be resolved BEFORE the root check");
  assert.equal(r.code, "outside_allowed_roots");
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test("beta120: credential-shaped filenames are refused even inside a root", { skip }, () => {
  const { readRequestFile } = briefSource;
  const root = tempRoot();
  for (const name of [".env", ".env.production", "id_rsa", "server.pem", "credentials.json", ".npmrc"]) {
    const p = join(root, name);
    writeFileSync(p, "secret=1");
    const r = readRequestFile(p, { allowedRoots: [root], maxBytes: 1000 });
    assert.equal(r.ok, false, `${name} must not be readable as a brief`);
    assert.equal(r.code, "denied_name");
  }
  rmSync(root, { recursive: true, force: true });
});

test("beta120: oversized, binary and empty files are refused with distinct codes", { skip }, () => {
  const { readRequestFile } = briefSource;
  const root = tempRoot();
  const big = join(root, "big.md");
  writeFileSync(big, "x".repeat(500));
  assert.equal(readRequestFile(big, { allowedRoots: [root], maxBytes: 100 }).code, "too_large");

  const bin = join(root, "bin.md");
  writeFileSync(bin, "abc\u0000def");
  assert.equal(readRequestFile(bin, { allowedRoots: [root], maxBytes: 100000 }).code, "binary");

  const empty = join(root, "empty.md");
  writeFileSync(empty, "   \n  ");
  assert.equal(readRequestFile(empty, { allowedRoots: [root], maxBytes: 100000 }).code, "empty");

  const missing = join(root, "nope.md");
  assert.equal(readRequestFile(missing, { allowedRoots: [root], maxBytes: 100000 }).code, "not_found");

  const dir = join(root, "adir");
  mkdirSync(dir);
  assert.equal(readRequestFile(dir, { allowedRoots: [root], maxBytes: 100000 }).code, "not_a_file");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Drift measurement: the b119 case, reproduced
// ---------------------------------------------------------------------------

// Trimmed to the fields whose substitution changed the feature.
const REAL_SPEC = `
Build a new Continuity & Resilience section for storing BCP/DR test artefacts.
model ContinuityExercise { title String; exerciseType String; performedAt DateTime;
  nextDueAt DateTime?; period String?; results Json?; ownersSignOff String?;
  relatedControlId String?; businessUnitId String }
model ContinuityArtefactFile { kind String; title String; fileUrl String;
  fileName String; mimeType String; fileSize Int; businessUnitId String }
Downloads go through proxyBlobDownload; blobs are private.
`;

const OPENCLAW_PARAPHRASE = `
Add a GRC continuity-exercise module with scheduling and artefact uploads.
ContinuityExercise: id, businessUnitId, title, description, scheduledAt, status
enum, ownerUserId, findings, ownersSignOff boolean.
ContinuityExerciseFile: id, exerciseId, blobKey, filename, mimeType.
`;

test("beta120: drift measurement catches the exact b119 substitution", { skip }, () => {
  const { measureParaphraseDrift } = briefSource;
  const d = measureParaphraseDrift(REAL_SPEC, OPENCLAW_PARAPHRASE);
  assert.equal(d.material, true, "this is the drift that cost two runs");
  assert.ok(d.droppedTerms.includes("performedat"), `performedAt must be reported dropped: ${d.droppedTerms}`);
  assert.ok(d.droppedTerms.includes("exercisetype"));
  assert.ok(d.droppedTerms.includes("relatedcontrolid"));
  assert.ok(d.droppedTerms.includes("proxyblobdownload"));
  assert.ok(d.paraphraseBytes < d.fileBytes);
});

test("beta120: an unmodified copy shows no material drift", { skip }, () => {
  const { measureParaphraseDrift } = briefSource;
  const d = measureParaphraseDrift(REAL_SPEC, REAL_SPEC);
  assert.equal(d.material, false);
  assert.equal(d.ratio, 1);
  assert.deepEqual(d.droppedTerms, []);
});

// ---------------------------------------------------------------------------
// Fix C: confirm the brief before spending
// ---------------------------------------------------------------------------

test("beta120: the confirmation gate keys on risk, never on the budget", { skip }, () => {
  const { decideBriefConfirmation } = briefConfirmation;
  const base = { mode: "high_risk", minRisk: "high" };

  assert.equal(decideBriefConfirmation({ ...base, riskLevel: "high" }).confirm, true);
  assert.equal(decideBriefConfirmation({ ...base, riskLevel: "medium" }).confirm, false);
  assert.equal(decideBriefConfirmation({ ...base, riskLevel: "low" }).confirm, false);
  assert.equal(decideBriefConfirmation({ ...base, minRisk: "medium", riskLevel: "medium" }).confirm, true);

  assert.equal(decideBriefConfirmation({ mode: "off", minRisk: "high", riskLevel: "high" }).confirm, false);
  assert.equal(decideBriefConfirmation({ mode: "always", minRisk: "high", riskLevel: "low" }).confirm, true);
  assert.equal(decideBriefConfirmation({ ...base, riskLevel: "high", waived: true }).confirm, false);
});

test("beta120: an unknown risk level is treated as medium, not as safe", { skip }, () => {
  const { decideBriefConfirmation, riskRank } = briefConfirmation;
  assert.equal(riskRank(undefined), riskRank("medium"));
  assert.equal(riskRank("bogus"), riskRank("medium"));
  // With a medium floor an unknown level still gates.
  assert.equal(decideBriefConfirmation({ mode: "high_risk", minRisk: "medium", riskLevel: undefined }).confirm, true);
});

test("beta120: only an UNQUALIFIED approval starts the run", { skip }, () => {
  const { isBriefConfirmation } = briefConfirmation;
  for (const yes of ["confirm", "Confirm.", "yes", "YES!", "go ahead", "ship it", "lgtm", "proceed", "ok", "confirm please", "yes thanks"]) {
    assert.equal(isBriefConfirmation(yes), true, `${yes} should approve`);
  }
  for (const no of [
    "confirm, but use performedAt not scheduledAt",
    "yes - although change the status enum",
    "no",
    "not quite, it's an artefact library",
    "use performedAt",
    "",
    "   ",
  ]) {
    assert.equal(isBriefConfirmation(no), false, `"${no}" must be treated as a correction`);
  }
});

test("beta120: the confirmation text shows the fields that expose drift", { skip }, () => {
  const { renderBriefConfirmation } = briefConfirmation;
  const out = renderBriefConfirmation({
    brief: {
      title: "Continuity & Resilience artefact library",
      motivation: "BCP/DR artefacts have no home",
      acceptanceCriteria: ["Prisma adds continuity_artefact_files with kind/title", "performedAt is the run date"],
      filesLikelyTouched: ["prisma/schema.prisma"],
      outOfScope: ["Do not touch the policy register"],
      riskLevel: "high",
      repoHint: "o/r",
    },
    estimatedUsd: 18,
    effectiveBudget: 18,
    sourcePath: "/briefs/dr-bcp.md",
  });
  assert.match(out, /Continuity & Resilience artefact library/);
  assert.match(out, /performedAt is the run date/, "acceptance criteria are where drift shows");
  assert.match(out, /prisma\/schema\.prisma/);
  assert.match(out, /Do not touch the policy register/);
  assert.match(out, /Risk high/);
  assert.match(out, /\$18\.00/);
  assert.match(out, /read verbatim from \/briefs\/dr-bcp\.md/);
  assert.match(out, /confirm/i);
});

test("beta120: without a source path the text warns that the request may be second-hand", { skip }, () => {
  const { renderBriefConfirmation } = briefConfirmation;
  const out = renderBriefConfirmation({
    brief: { title: "t", motivation: "m", acceptanceCriteria: ["a"], filesLikelyTouched: [], outOfScope: [], riskLevel: "high" },
    estimatedUsd: 1,
    effectiveBudget: 2,
  });
  assert.match(out, /paraphrased away/, "the reader should be told to check for paraphrasing");
});

test("beta120: long criteria lists are summarised, not dumped", { skip }, () => {
  const { renderBriefConfirmation } = briefConfirmation;
  const many = Array.from({ length: 40 }, (_, i) => `criterion ${i}`);
  const out = renderBriefConfirmation({
    brief: { title: "t", motivation: "m", acceptanceCriteria: many, filesLikelyTouched: [], outOfScope: [], riskLevel: "high" },
    estimatedUsd: 1,
    effectiveBudget: 2,
  });
  assert.match(out, /and \d+ more/);
});

// ---------------------------------------------------------------------------
// End to end through the real tools
// ---------------------------------------------------------------------------

function makeRuntime({ riskLevel = "high", brief: briefCfg } = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const state = {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    close() {},
  };
  const loopCalls = [];
  const crystalliseCalls = [];
  return {
    state,
    audits,
    loopCalls,
    crystalliseCalls,
    loop: { run: async (sessionId, brief) => { loopCalls.push({ sessionId, brief }); return { status: "shipped", sessionId, cycles: 1, totalCostUsd: 0.1 }; } },
    crystallise: async (userText) => {
      crystalliseCalls.push(userText);
      return {
        kind: "brief",
        costUsd: 0,
        brief: {
          title: "Continuity artefact library",
          motivation: "m",
          acceptanceCriteria: ["performedAt is the date the test was run"],
          filesLikelyTouched: [],
          outOfScope: [],
          riskLevel,
        },
      };
    },
    anthropicApiKey: async () => "sk-test",
    githubServiceFor: () => "github-o",
    githubToken: async () => "gh",
    gitResolutionFor: () => ({ credentialService: "github-o", provider: "github", apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN" }),
    gitToken: async () => "gh",
    budget: { getDailySpend: () => 0 },
    config: {
      storage: { audit_retention_days: 90 },
      slack: { listener_enabled: false, channel: "C1", authorised_users: ["U1"] },
      repos: { allowed: ["o/*"] },
      models: { lead: "l", worker: "w", adversary: "a", classifier: "c", auth: { credential_service: "anthropic-x" } },
      pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{owner}", auth: { api_key_env: "GH_TOKEN" } },
      budgets: { session_default_usd: 18 },
      brief: briefCfg,
    },
  };
}

function collectTools() {
  const tools = new Map();
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool: (def) => {
      tools.set(def.name, { ...def, execute: (input) => def.execute("test-call-id", input) });
      return () => tools.delete(def.name);
    },
  };
  return { api, tools };
}

test("beta120: a high-risk run PAUSES before the loop is ever entered", { skip }, async () => {
  const runtime = makeRuntime({ riskLevel: "high" });
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1", request: "build the continuity artefact library" });

  assert.equal(r.details.ok, true);
  assert.equal(r.details.awaitingConfirmation, true);
  assert.equal(runtime.loopCalls.length, 0, "not one dollar of planning or worker spend");
  const row = runtime.state.db.prepare("SELECT status, clarification_question FROM sessions WHERE id = ?").get(r.details.sessionId);
  assert.equal(row.status, "awaiting_clarification");
  assert.match(row.clarification_question, /performedAt is the date the test was run/);
  assert.ok(runtime.audits.some((a) => a.event === "tool.run.awaiting_brief_confirmation"));
});

test("beta120: approving the brief runs it unchanged", { skip }, async () => {
  const runtime = makeRuntime({ riskLevel: "high" });
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1", request: "build the continuity artefact library" });
  const a = await tools.get("harness_answer").execute({ sessionId: r.details.sessionId, answer: "confirm", invokedBy: "U1" });

  assert.equal(a.details.ok, true);
  assert.equal(a.details.briefConfirmed, true);
  assert.equal(runtime.loopCalls.length, 1);
  assert.deepEqual(
    runtime.loopCalls[0].brief.acceptanceCriteria,
    ["performedAt is the date the test was run"],
    "an approval must not append anything to the brief",
  );
  const row = runtime.state.db.prepare("SELECT status FROM sessions WHERE id = ?").get(r.details.sessionId);
  assert.equal(row.status, "planning");
});

test("beta120: correcting the brief folds the correction in BEFORE any work", { skip }, async () => {
  const runtime = makeRuntime({ riskLevel: "high" });
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1", request: "build the continuity artefact library" });
  const a = await tools.get("harness_answer").execute({
    sessionId: r.details.sessionId,
    answer: "No - it stores artefacts of tests already run. Use performedAt, not scheduledAt.",
    invokedBy: "U1",
  });

  assert.equal(a.details.briefCorrected, true);
  assert.equal(runtime.loopCalls.length, 1);
  const criteria = runtime.loopCalls[0].brief.acceptanceCriteria;
  assert.equal(criteria.length, 2);
  assert.match(criteria[1], /performedAt, not scheduledAt/);
  assert.match(criteria[1], /OPERATOR CORRECTION/);
  // Nothing ran, so there is no branch to preserve.
  assert.notEqual(runtime.loopCalls[0].brief.resumeFromClarification, true);
});

test("beta120: a low-risk run is not gated", { skip }, async () => {
  const runtime = makeRuntime({ riskLevel: "low" });
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1", request: "fix a typo in the readme" });
  assert.notEqual(r.details.awaitingConfirmation, true);
  assert.equal(runtime.loopCalls.length, 1);
});

test("beta120: confirm_before_spend off restores the pre-beta.120 path", { skip }, async () => {
  const runtime = makeRuntime({ riskLevel: "high", brief: { confirm_before_spend: "off" } });
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1", request: "build the continuity artefact library" });
  assert.notEqual(r.details.awaitingConfirmation, true);
  assert.equal(runtime.loopCalls.length, 1);
});

test("beta120: harness_run reads the spec from disk and discards the paraphrase", { skip }, async () => {
  const root = tempRoot();
  const p = join(root, "dr-bcp.md");
  writeFileSync(p, REAL_SPEC);
  const runtime = makeRuntime({ riskLevel: "low", brief: { confirm_before_spend: "off", request_file_roots: [root], request_file_max_bytes: 100000 } });
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);

  const r = await tools.get("harness_run").execute({
    requester: "U1",
    request: OPENCLAW_PARAPHRASE,
    requestPath: p,
  });

  assert.equal(r.details.ok, true);
  assert.equal(runtime.crystalliseCalls.length, 1);
  assert.equal(runtime.crystalliseCalls[0], REAL_SPEC, "the FILE is what gets crystallised, not the retelling");

  const drift = runtime.audits.find((a) => a.event === "tool.run.paraphrase_discarded");
  assert.ok(drift, "the discarded paraphrase is recorded, so this bug is visible in the audit log");
  assert.equal(drift.payload.material, true);
  assert.ok(drift.payload.droppedTerms.includes("performedat"));
  rmSync(root, { recursive: true, force: true });
});

test("beta120: a bad requestPath with no usable text fails loudly instead of guessing", { skip }, async () => {
  const runtime = makeRuntime({ riskLevel: "low", brief: { confirm_before_spend: "off", request_file_roots: ["/nonexistent-root"] } });
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1", requestPath: "/etc/hosts" });
  assert.equal(r.details.ok, false);
  assert.equal(r.details.requestFileError, true);
  assert.equal(runtime.crystalliseCalls.length, 0, "nothing is crystallised from a refused path");
  assert.ok(runtime.audits.some((a) => a.event === "tool.run.request_file_rejected"));
});

test("beta120: neither request nor requestPath is a clean failure", { skip }, async () => {
  const runtime = makeRuntime({ riskLevel: "low" });
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1" });
  assert.equal(r.details.ok, false);
  assert.equal(r.details.missingRequest, true);
});

test("beta120: a revise is not re-gated", { skip }, () => {
  // A revise continues a brief the human already accepted, off findings the
  // harness itself produced -- re-confirming adds a round-trip and no signal.
  const i = regSrc.indexOf('auditEvent: "tool.revise"');
  assert.ok(i > 0);
  // Bound by the end of the startSessionFromBrief call this belongs to.
  const end = regSrc.indexOf("});", i);
  assert.ok(end > i);
  assert.match(regSrc.slice(i, end), /confirmWaived: true/);
});

// ---------------------------------------------------------------------------
// Fix A: the contract that stops a caller paraphrasing in the first place
// ---------------------------------------------------------------------------

test("beta120: harness_run tells callers to pass the request verbatim", { skip }, () => {
  const i = regSrc.indexOf('name: "harness_run"');
  assert.ok(i > 0);
  const seg = regSrc.slice(i, i + 9000);
  assert.match(seg, /PASS THE USER'S WORDS VERBATIM/);
  assert.match(seg, /Do NOT summarise/);
  assert.match(seg, /crystallis/i, "and says the harness does the condensing itself");
  assert.match(seg, /requestPath/, "and points at the file route");
});

test("beta120: request is no longer a required parameter, because a path can replace it", { skip }, () => {
  const i = regSrc.indexOf('name: "harness_run"');
  const seg = regSrc.slice(i, i + 9000);
  assert.match(seg, /required: \["requester"\]/);
  assert.ok(!/required: \["requester", "request"\]/.test(seg));
});
