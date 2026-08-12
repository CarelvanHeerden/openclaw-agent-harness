/**
 * beta.121: the shipped brief-intake skill is a load-bearing artefact.
 *
 * It is the only thing in this repository that reaches the CALLING agent, and
 * it carries the most expensive lesson the harness has learned: the b119 take-2
 * run cost $18.46 and 121.6 minutes and built the wrong feature because a
 * 10,710-byte spec became a ~40-line retelling somewhere between the user's
 * file and the tool call. Nothing downstream can recover from that.
 *
 * Until b121 nothing tested this file at all, so a skill that silently stopped
 * shipping -- unregistered in the manifest, excluded from the package, or
 * quietly stripped of the rule that matters -- would have looked exactly like a
 * healthy release.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SKILL_DIR = "skills/harness-brief-intake";
const SKILL_PATH = join(ROOT, SKILL_DIR, "SKILL.md");

test("the brief-intake skill exists and is actually shipped", () => {
  assert.ok(existsSync(SKILL_PATH), "SKILL.md is present");

  // Registered with the host, or the calling agent never sees it.
  const manifest = JSON.parse(readFileSync(join(ROOT, "openclaw.plugin.json"), "utf8"));
  assert.ok(
    Array.isArray(manifest.skills) && manifest.skills.includes(SKILL_DIR),
    "the skill is listed in openclaw.plugin.json",
  );

  // Included in the published package, or it never reaches the container.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("skills"),
    "package.json ships the skills directory",
  );
});

test("the skill has front-matter a host can index", () => {
  const src = readFileSync(SKILL_PATH, "utf8");
  assert.ok(src.startsWith("---\n"), "front-matter opens the file");
  const fm = src.slice(4, src.indexOf("\n---", 4));
  assert.match(fm, /^name:\s*harness-brief-intake$/m);
  assert.match(fm, /description:/, "a description is what makes it discoverable");
});

test("the skill still carries the three rules that stop a wasted run", () => {
  const src = readFileSync(SKILL_PATH, "utf8");

  // 1. Verbatim. The b119 loss was a retelling, not a crystallisation failure.
  assert.match(src, /verbatim/i);
  assert.match(src, /in full, byte for byte/i, "the demand is unambiguous, not a preference");
  assert.match(src, /Do not summarise/i);

  // 2. The file passthrough, which removes the lossy hop entirely.
  assert.match(src, /requestPath/, "the parameter is named");
  assert.match(src, /brief\.request_file_roots/, "and so is the config that gates it");

  // 3. The echo, which is the only check that catches "I misread the user".
  assert.match(src, /echo the premise back/i);
  assert.match(src, /two to four sentences/i, "a length that gets read, not skimmed");

  // And the harness's own gate must be relayed, never answered on the user's
  // behalf -- the whole value of it is that a human's eyes cross the brief.
  assert.match(src, /awaitingConfirmation/);
  assert.match(src, /Do not confirm on the user's behalf/i);
});

test("the skill names the concrete failure, not just the rule", () => {
  const src = readFileSync(SKILL_PATH, "utf8");
  // A rule with no story attached is one an agent talks itself out of.
  assert.match(src, /performedAt/, "the field that changed meaning");
  assert.match(src, /scheduledAt/, "and what it became");
  assert.match(src, /10,710/, "the size of the spec that was thrown away");
});

test("b121: the skill says the attachment path lives for exactly one turn", () => {
  const src = readFileSync(SKILL_PATH, "utf8");

  // OpenClaw confirmed the inbound-media envelope is present only on the turn
  // the file arrives. An agent that does not know this reconstructs the brief
  // from memory a turn later -- the b119 failure by a new route.
  assert.match(src, /openclaw-staged-<envelope-uuid>\/<file-uuid>/, "the real on-disk shape");
  assert.match(src, /no extension/i, "a bare UUID is not a mistake and must not be 'corrected'");
  assert.match(src, /not in your context on any later turn/i);
  assert.match(src, /same turn the file arrives/i);

  // The two wrong recoveries, both named explicitly.
  assert.match(src, /re-attach/i, "the correct recovery");
  assert.match(src, /taking the newest/i, "guessing by mtime is called out");
  assert.match(src, /retyping the spec from memory/i, "and so is the memory fallback");
});

test("the anti-pattern table and checklist cover the turn-scoped path", () => {
  const src = readFileSync(SKILL_PATH, "utf8");
  const table = src.slice(src.indexOf("## Anti-patterns"), src.indexOf("## Checklist"));
  assert.match(table, /Lost the path a turn later/i);
  assert.match(table, /Guess the path/i);

  const checklist = src.slice(src.indexOf("## Checklist"));
  assert.match(checklist, /this\*\* turn/i, "the checklist asks the question at call time");
  assert.match(checklist, /re-attach/i);
});
