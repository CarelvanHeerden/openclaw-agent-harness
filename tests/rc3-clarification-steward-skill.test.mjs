/**
 * rc.3: the clarification steward is a shipped artefact, and a load-bearing one.
 *
 * It is the second thing in this repository that reaches the CALLING agent
 * rather than the harness, and it is the only place the auto-accept policy
 * lives. That was a deliberate choice: the guardrails were kept out of
 * `harness_answer` so the harness stays neutral about who decided. The cost of
 * that choice is that this file IS the safety mechanism, so a skill that
 * silently stopped shipping -- unregistered in the manifest, dropped from the
 * package -- or quietly lost the sentence forbidding automatic `skip` would
 * look exactly like a healthy release.
 *
 * These tests pin the packaging and the load-bearing prohibitions. They cannot
 * make a calling agent obey any of it; nothing in this repository can.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SKILL_DIR = "skills/harness-clarification-steward";
const SKILL_PATH = join(ROOT, SKILL_DIR, "SKILL.md");
const src = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, "utf8") : "";

// ---------------------------------------------------------------------------
// Discoverable after a clean install
// ---------------------------------------------------------------------------

test("rc3: the steward skill exists and is actually shipped", () => {
  assert.ok(existsSync(SKILL_PATH), "SKILL.md is present");

  // Registered with the host, or the calling agent never sees it. The manifest
  // enumerates skill directories explicitly -- adding the directory alone is
  // not enough, and that is the whole failure mode this assertion catches.
  const manifest = JSON.parse(readFileSync(join(ROOT, "openclaw.plugin.json"), "utf8"));
  assert.ok(
    Array.isArray(manifest.skills) && manifest.skills.includes(SKILL_DIR),
    "the skill is listed in openclaw.plugin.json",
  );

  // Shipped in the package, or it never reaches the container.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("skills"), "package.json ships the skills directory");
});

test("rc3: every manifest skill directory actually exists", () => {
  // The reverse of the check above. A typo in the manifest ships a plugin that
  // advertises a skill the host cannot load, and nothing else would notice.
  const manifest = JSON.parse(readFileSync(join(ROOT, "openclaw.plugin.json"), "utf8"));
  for (const dir of manifest.skills) {
    assert.ok(existsSync(join(ROOT, dir, "SKILL.md")), `${dir}/SKILL.md exists`);
  }
});

test("rc3: the skill has front-matter a host can index", () => {
  assert.ok(src.startsWith("---\n"), "front-matter opens the file");
  const fm = src.slice(4, src.indexOf("\n---", 4));
  assert.match(fm, /^name:\s*harness-clarification-steward$/m, "name matches the directory");
  assert.match(fm, /description:/, "a description is what makes it discoverable");
  // The description is the only part a host reads when deciding whether to
  // surface the skill, so the trigger condition has to be in it.
  assert.match(fm, /needsClarification|awaiting_clarification/, "the description names its trigger");
});

// ---------------------------------------------------------------------------
// Recommendation-only is the default, and it is complete
// ---------------------------------------------------------------------------

test("rc3: the skill demands live state, not a screenshot or an explanation", () => {
  assert.match(src, /harness_progress/);
  assert.match(src, /harness_session_get/);
  assert.match(src, /screenshot/i, "deciding from a screenshot is called out by name");
  assert.match(
    src,
    /model explanation of why a commit is fine is not evidence/i,
    "an agent's own reasoning is not evidence about a diff",
  );
});

test("rc3: a relayed pause carries the question, a labelled recommendation and a paste-ready reply", () => {
  assert.match(src, /verbatim/, "the question is relayed as written");
  for (const label of ["accept", "skip", "abort", "human decision required"]) {
    assert.ok(src.includes(label), `the recommendation vocabulary includes "${label}"`);
  }
  // Paste-ready means the human copies it, so the seq has to be in the example
  // or the race the harness now guards is reintroduced by the skill.
  assert.match(src, /harness_answer\(\{[\s\S]*clarificationSeq/, "the paste-ready call carries the sequence");
});

test("rc3: the evidence required before recommending accept is enumerated", () => {
  for (const [needle, why] of [
    [/changed-file list and the diff/i, "what was committed, not what was described"],
    [/worker commit/i, "the commit under discussion exists"],
    [/typecheck/i, "verification results"],
    [/within the originally approved scope/i, "no scope drift"],
    [/no unexplained or out-of-scope files/i, "nothing unaccounted for in the diff"],
  ]) {
    assert.match(src, needle, why);
  }
});

// ---------------------------------------------------------------------------
// The prohibitions -- the part that must never quietly disappear
// ---------------------------------------------------------------------------

test("rc3: automatic answering is off unless explicitly delegated", () => {
  assert.match(src, /\*\*Off by default\.\*\*/, "the default is stated plainly, not implied");
  assert.match(src, /explicitly delegated/i);
  assert.match(
    src,
    /Silence is not delegation/i,
    "the absence of an objection is the obvious way to talk oneself into acting",
  );
  assert.match(src, /Fail closed/i);
});

test("rc3: skip and abort can be recommended but never acted on", () => {
  // b121: an operator answered `skip` meaning "carry on" and a correct,
  // committed migration was dropped from every subsequent plan. An agent
  // reaching that conclusion by itself is strictly worse.
  assert.match(src, /never \*act on\*|Any `skip`\. Any `abort`\./);
  assert.match(src, /b121/, "the incident is cited, so the rule has a reason attached");
});

test("rc3: the never-automatic list covers every sensitive class", () => {
  for (const [needle, why] of [
    [/brief approval/i, "the pre-spend gate"],
    [/[Bb]udget approval/, "money"],
    [/[Ss]cope changes/, "scope"],
    [/architecture decisions/i, "subjective judgment"],
    [/[Ss]ecurity boundaries, schemas, migrations, credentials or access/, "security and data"],
    [/destructive action/i, "irreversible operations"],
    [/generated or unexplained files/i, "files nobody can account for"],
  ]) {
    assert.match(src, needle, why);
  }
});

test("rc3: substituting a path is refused for the categories where the path IS the contract", () => {
  for (const needle of [
    /public API or route contract/i,
    /security boundary/i,
    /database schema or migration/i,
    /[Cc]redential handling/,
    /[Gg]enerated artifacts/,
    /does not demonstrably\s*\n?\s*provide/i,
  ]) {
    assert.match(src, needle);
  }
});

test("rc3: acting automatically requires a re-read, the sequence, and the canonical answer", () => {
  assert.match(src, /Re-read the clarification immediately before answering/i);
  assert.match(src, /Pass `clarificationSeq`/);
  assert.match(src, /answeredBy: "automation"/);
  // "accept this commit" is folded in as a brief correction instead of taken as
  // an acceptance, which silently changes what gets built.
  assert.match(src, /Not "accept this"/);
  assert.match(src, /Retries are safe/i, "the harness claims a pause atomically; do not re-implement that");
});

test("rc3: the skill says what it must record, and that secrets are never among it", () => {
  assert.match(src, /never\s+its text/, "the harness logs the answer's length, not the answer");
  assert.match(src, /Never include secrets, tokens or credential values/i);
  assert.match(src, /Which delegation you were acting under/, "an automatic answer names its authority");
});

test("rc3: the checklist is present, because that is what gets read under pressure", () => {
  const tail = src.slice(src.indexOf("## Checklist"));
  assert.ok(tail.length > 200, "the checklist section exists and is not a stub");
  assert.match(tail, /explicitly delegate/i);
  assert.match(tail, /contract-path mismatch and nothing else/i);
  assert.match(tail, /Any unchecked box means relay it/i, "the checklist states its own failure mode");
});
