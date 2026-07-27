// beta.72 — two defects surfaced during the PR #876 test follow-up (2026-07-27):
//
//   D-A  worktrees/ re-roots to root:root between runs -> the harness (uid
//        `node`) can't mkdir `worktrees/.repos` -> EACCES during planning at
//        $0.00, with a raw un-actionable stack. FIX: a bootstrap preflight that
//        (1) creates the root node-owned if MISSING (fresh install is correct),
//        and (2) detects the exists-but-not-writable (root-owned) case and emits
//        a precise, actionable `chown` diagnostic instead of exploding later.
//
//   D-B  harness_revise reconstructed EMPTY finding bodies -> the #876 auto-brief
//        came through as "1. [medium] " x4 (severity present, TEXT empty),
//        producing a garbage revise. ROOT CAUSE: findingText read
//        `message ?? finding ?? detail ?? description` and used `??` (which does
//        NOT fall through an empty string), and never read the adversary's
//        primary `title` field. A finding with text in `title` + empty `detail`
//        rendered blank. FIX: read `title`, coalesce empties, JSON-dump as a
//        last resort so a brief line is NEVER empty.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { findingText } = await import("../dist/orchestrator/finding-hygiene.js");
const { ensureWorktreesRootWritable } = await import("../dist/state/worktrees-preflight.js");

// ---------------------------------------------------------------------------
// D-B: finding body extraction
// ---------------------------------------------------------------------------

test("beta72 D-B: the exact #876 failure (title populated, empty detail) is no longer blank", () => {
  const f = { dimension: "quality", severity: "medium", title: "Add export-branch test to changes-api.test.ts", detail: "" };
  const txt = findingText(f);
  assert.ok(txt.length > 0, "must not be empty");
  assert.ok(txt.includes("export-branch"), "must carry the title text");
});

test("beta72 D-B: adversary ReviewFinding shape (title + detail) joins both", () => {
  const f = { dimension: "spec", severity: "high", title: "Missing test", detail: "Author flagged it themselves." };
  assert.equal(findingText(f), "Missing test -- Author flagged it themselves.");
});

test("beta72 D-B: title alone, detail alone, and duplicate title/detail all render", () => {
  assert.equal(findingText({ title: "T only" }), "T only");
  assert.equal(findingText({ detail: "D only" }), "D only");
  // identical title/detail should not double up
  assert.equal(findingText({ title: "same", detail: "same" }), "same");
});

test("beta72 D-B: empty/whitespace strings do NOT win over a populated field", () => {
  // `??` bug: message:"" would have short-circuited to "". Hardened picker skips empties.
  assert.equal(findingText({ message: "", title: "real title" }), "real title");
  assert.equal(findingText({ detail: "   ", title: "trimmed" }), "trimmed");
});

test("beta72 D-B: an object with keys but no recognisable text dumps JSON (never blank)", () => {
  const txt = findingText({ severity: "medium", title: "", detail: "" });
  assert.ok(txt.length > 0, "must not be blank");
  assert.ok(txt.includes("severity"), "falls back to a JSON dump");
});

test("beta72 D-B: backward-compatible with beta49 loose-schema assertions", () => {
  assert.equal(findingText({ message: "m" }), "m");
  assert.equal(findingText({ finding: "f" }), "f");
  assert.equal(findingText({ detail: "d" }), "d");
  assert.equal(findingText({ description: "x" }), "x");
  assert.equal(findingText(null), "");
  assert.equal(findingText(undefined), "");
  assert.equal(findingText({}), "");
});

// ---------------------------------------------------------------------------
// D-A: worktrees-root preflight
// ---------------------------------------------------------------------------

function baseDeps(overrides = {}) {
  return {
    worktreesRoot: "/home/node/.openclaw/workspace/openclaw-agent-harness/worktrees",
    exists: () => true,
    mkdirp: () => {},
    probeWritable: () => true,
    getuid: () => 1000,
    ...overrides,
  };
}

test("beta72 D-A: MISSING root is created node-owned (fresh install is correct)", () => {
  let made = null;
  const r = ensureWorktreesRootWritable(baseDeps({ exists: () => false, mkdirp: (p) => (made = p) }));
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(made, r.worktreesRoot);
});

test("beta72 D-A: EXISTING + writable root passes without creating", () => {
  let made = false;
  const r = ensureWorktreesRootWritable(baseDeps({ exists: () => true, probeWritable: () => true, mkdirp: () => (made = true) }));
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(made, false, "must not mkdir an existing dir");
});

test("beta72 D-A: EXISTING + NOT writable (root-owned) yields an actionable chown diagnostic", () => {
  const r = ensureWorktreesRootWritable(baseDeps({ exists: () => true, probeWritable: () => false, getuid: () => 1000 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_writable");
  assert.equal(r.uid, 1000);
  assert.ok(r.chownCommand.startsWith("chown -R node:node "), "gives the exact chown");
  assert.ok(r.chownCommand.includes(r.worktreesRoot));
  assert.ok(r.message.includes("EACCES") || r.message.includes("not writable"), "explains the failure mode");
});

test("beta72 D-A: does NOT throw when probe returns false (fails safe, no crash)", () => {
  assert.doesNotThrow(() => ensureWorktreesRootWritable(baseDeps({ probeWritable: () => false })));
});

// ---------------------------------------------------------------------------
// Wiring source-assertions
// ---------------------------------------------------------------------------

test("beta72 wiring: index.ts calls the preflight before the self-heal and audits both outcomes", () => {
  const idx = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.ok(idx.includes("ensureWorktreesRootWritable"), "preflight is wired");
  assert.ok(idx.includes("harness.worktrees_root_not_writable"), "not-writable audit event");
  assert.ok(idx.includes("harness.worktrees_preflight"), "ok audit event");
  // preflight must precede the self-heal call
  const pfIdx = idx.indexOf("ensureWorktreesRootWritable");
  const healIdx = idx.indexOf("healOrphanedWorktrees");
  assert.ok(pfIdx >= 0 && healIdx >= 0 && pfIdx < healIdx, "preflight runs before self-heal");
});

test("beta72 wiring: both revise call sites use the hardened findingText", () => {
  const reg = readFileSync(join(root, "src/tools/registration.ts"), "utf8");
  assert.ok(reg.includes("findingText, isConditionalFinding") || reg.includes("findingText,"), "findingText imported");
  // buildReviseBrief line construction must route through findingText, not the
  // old empty-prone `?? o.description ?? JSON.stringify(o)` inline chain.
  assert.ok(reg.includes("findingText(f) || JSON.stringify(o)"), "buildReviseBrief uses findingText");
  assert.ok(reg.includes("summary: findingText(f).slice"), "summariseRevisable uses findingText");
});

test("beta72 version bumped to beta.72", () => {
  const v = readFileSync(join(root, "src/version.ts"), "utf8");
  assert.ok(v.includes("0.1.0-beta.72"), "version.ts bumped");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.1.0-beta.72");
});
