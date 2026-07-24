// beta.63 (convention-awareness) — Fix 1 (convention-as-context) + Fix 2
// (convention-as-check). Origin: PR #859 was good + green CI but violated the
// repo's keep-okf-current rule (okf:check drift) which CI does not gate.
//
// Asserts:
//   Fix 1: brief ingests .cursor/rules + .cursorrules + CONTRIBUTING; char
//          budget longest-first + noted; empty repo => []; prompt threading.
//   Fix 2: final-verify discovers okf:check; non-zero => convention_check_failed
//          finding (NOT a hard run-fail); allowlist gating (non-allowlisted not
//          run); timeout/unrunnable non-fatal; audit events; config+manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let ingestRepoConventions, discoverCheckScripts, runCheckScripts, applyCharBudget, renderConventionsForPrompt, CHECK_SCRIPT_NAME_RE;
try {
  ({ ingestRepoConventions, discoverCheckScripts, runCheckScripts, applyCharBudget, renderConventionsForPrompt, CHECK_SCRIPT_NAME_RE } =
    await import("../dist/orchestrator/repo-conventions.js"));
} catch {
  ingestRepoConventions = null;
}

function mkrepo() {
  const d = resolve(tmpdir(), `harness-conv-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// ---- Fix 1: ingest .cursor/rules + .cursorrules + CONTRIBUTING ----
test("beta63: brief ingests .cursor/rules/*, .cursorrules, and CONTRIBUTING.md",
  { skip: ingestRepoConventions === null }, () => {
    const repo = mkrepo();
    mkdirSync(join(repo, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(repo, ".cursor", "rules", "keep-okf-current.mdc"), "Always regenerate the OKF bundle when adding src/lib files.");
    writeFileSync(join(repo, ".cursorrules"), "Prefer folding into existing dirs.");
    writeFileSync(join(repo, "CONTRIBUTING.md"), "Run npm run okf:check before opening a PR.");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { "okf:check": "okf-cli check", "lint": "eslint .", "build": "tsc" } }));

    const conv = ingestRepoConventions(repo, 10000);
    const sources = conv.map((c) => c.source);
    assert.ok(sources.some((s) => s.includes("keep-okf-current.mdc")), "cursor rule ingested");
    assert.ok(sources.includes(".cursorrules"), ".cursorrules ingested");
    assert.ok(sources.includes("CONTRIBUTING.md"), "CONTRIBUTING.md ingested");
    // package.json#scripts convention lists ONLY check-ish scripts (build excluded).
    const pkg = conv.find((c) => c.source === "package.json#scripts");
    assert.ok(pkg, "package.json#scripts convention present");
    assert.match(pkg.text, /okf:check/);
    assert.match(pkg.text, /lint/);
    assert.ok(!/build: tsc/.test(pkg.text), "non-check script 'build' not surfaced as a convention");
    rmSync(repo, { recursive: true, force: true });
  });

// ---- Fix 1: empty repo => [] ----
test("beta63: empty repo (no convention files) ingests to []",
  { skip: ingestRepoConventions === null }, () => {
    const repo = mkrepo();
    assert.deepEqual(ingestRepoConventions(repo, 10000), []);
    // Non-existent path also => [].
    assert.deepEqual(ingestRepoConventions(join(repo, "nope"), 10000), []);
    rmSync(repo, { recursive: true, force: true });
  });

// ---- Fix 1: char budget longest-first + noted ----
test("beta63: char budget truncates the LONGEST source first, with a note",
  { skip: ingestRepoConventions === null }, () => {
    const conv = [
      { source: "short.md", text: "S".repeat(300) },
      { source: "long.md", text: "L".repeat(5000) },
    ];
    const budgeted = applyCharBudget(conv, 1000);
    const total = budgeted.reduce((a, c) => a + c.text.length, 0);
    assert.ok(total <= 1000 + 100, "total within budget (allowing note slack)");
    const long = budgeted.find((c) => c.source === "long.md");
    assert.equal(long.truncated, true, "the longest source is the one truncated");
    assert.match(long.text, /truncated to fit the convention char budget/);
    const short = budgeted.find((c) => c.source === "short.md");
    assert.ok(!short.truncated, "the short source is not truncated");
    rmSync;
  });

// ---- Fix 1: prompt threading for lead/worker/adversary ----
test("beta63: renderConventionsForPrompt carries conventions with per-role guidance",
  { skip: ingestRepoConventions === null }, () => {
    const conv = [{ source: "CONTRIBUTING.md", text: "Run okf:check." }];
    const lead = renderConventionsForPrompt(conv, "lead");
    const worker = renderConventionsForPrompt(conv, "worker");
    const adv = renderConventionsForPrompt(conv, "adversary");
    assert.match(lead, /REPO CONVENTIONS/);
    assert.match(lead, /CONTRIBUTING\.md/);
    assert.match(lead, /surface it as a finding/i);
    assert.match(worker, /Respect these repo conventions for any file you touch/);
    assert.match(adv, /Flag any change that violates a stated repo convention, even if CI is green/);
    // Empty => "".
    assert.equal(renderConventionsForPrompt([], "lead"), "");
    assert.equal(renderConventionsForPrompt(undefined, "worker"), "");
  });

// ---- Fix 2: discover check scripts (name regex) ----
test("beta63: discoverCheckScripts finds check|lint|verify|okf scripts only",
  { skip: ingestRepoConventions === null }, () => {
    const repo = mkrepo();
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      scripts: { "okf:check": "okf check", "lint": "eslint .", "verify": "./v.sh", "typecheck": "tsc --noEmit", "build": "tsc", "start": "node ." },
    }));
    const found = discoverCheckScripts(repo).map((s) => s.name).sort();
    // 'typecheck' matches because it CONTAINS 'check'; build/start excluded.
    assert.deepEqual(found, ["lint", "okf:check", "typecheck", "verify"], "build/start excluded (no matching NAME token)");
    assert.match(CHECK_SCRIPT_NAME_RE.source, /check|lint|verify|okf/);
    rmSync(repo, { recursive: true, force: true });
  });

// ---- Fix 2: allowlist gating -- non-allowlisted NOT run ----
test("beta63: a discovered but non-allowlisted script is NEVER run",
  { skip: ingestRepoConventions === null }, () => {
    let ran = [];
    const results = runCheckScripts({
      repoRoot: "/tmp/x",
      discovered: [{ name: "okf:check", command: "x" }, { name: "verify", command: "y" }],
      allowlist: ["okf:check", "lint", "typecheck", "test"], // 'verify' NOT allowlisted
      timeoutSeconds: 60,
      runScript: (name) => { ran.push(name); return { status: 0, stdout: "ok", stderr: "" }; },
    });
    assert.deepEqual(ran, ["okf:check"], "only the allowlisted script actually ran");
    const verify = results.find((r) => r.script === "verify");
    assert.equal(verify.ran, false);
    assert.match(verify.skippedReason, /not on verify\.check_script_allowlist/);
  });

// ---- Fix 2: non-zero exit => a result the loop turns into a finding ----
test("beta63: a non-zero check exit is a ran+fail result (REVISE-worthy, not a hard fail)",
  { skip: ingestRepoConventions === null }, () => {
    const results = runCheckScripts({
      repoRoot: "/tmp/x",
      discovered: [{ name: "okf:check", command: "x" }],
      allowlist: ["okf:check"],
      timeoutSeconds: 60,
      runScript: () => ({ status: 3, stdout: "3 drift issues", stderr: "" }),
    });
    assert.equal(results[0].ran, true);
    assert.equal(results[0].exitCode, 3);
    assert.match(results[0].outputTail, /3 drift issues/);
    assert.ok(!results[0].unrunnable, "a real non-zero exit is NOT 'unrunnable'");
  });

// ---- Fix 2: timeout / spawn error => unrunnable (non-fatal) ----
test("beta63: a timed-out or spawn-errored script is unrunnable (non-fatal note, not a finding)",
  { skip: ingestRepoConventions === null }, () => {
    const timedOut = runCheckScripts({
      repoRoot: "/tmp/x",
      discovered: [{ name: "test", command: "x" }],
      allowlist: ["test"],
      timeoutSeconds: 1,
      runScript: () => ({ status: null, stdout: "", stderr: "partial", timedOut: true }),
    });
    assert.equal(timedOut[0].ran, false);
    assert.equal(timedOut[0].unrunnable, true);

    const spawnErr = runCheckScripts({
      repoRoot: "/tmp/x",
      discovered: [{ name: "lint", command: "x" }],
      allowlist: ["lint"],
      timeoutSeconds: 60,
      runScript: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT npm") }),
    });
    assert.equal(spawnErr[0].ran, false);
    assert.equal(spawnErr[0].unrunnable, true);
    assert.match(spawnErr[0].skippedReason, /unrunnable/);
  });

// ---- config + interface source wiring ----
test("beta63: brief.* + verify.* keys in config.ts DEFAULTS + interface (source)", () => {
  const src = S("src/config.ts");
  assert.match(src, /ingest_repo_conventions: boolean/);
  assert.match(src, /convention_char_budget: number/);
  assert.match(src, /run_repo_check_scripts: boolean/);
  assert.match(src, /check_script_allowlist: string\[\]/);
  assert.match(src, /check_script_timeout_seconds: number/);
  assert.match(src, /ingest_repo_conventions: true/);
  assert.match(src, /convention_char_budget: 10000/);
  assert.match(src, /check_script_allowlist: \["okf:check", "lint", "typecheck", "test"\]/);
  assert.match(src, /check_script_timeout_seconds: 600/);
});

test("beta63: brief + verify blocks declared in manifest configSchema (additionalProperties:false)", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  const brief = m.configSchema.properties.brief;
  const verify = m.configSchema.properties.verify;
  assert.ok(brief && verify, "brief + verify blocks declared (else additionalProperties:false rejects the config)");
  assert.equal(brief.additionalProperties, false);
  assert.equal(brief.properties.ingest_repo_conventions.default, true);
  assert.equal(brief.properties.convention_char_budget.default, 10000);
  assert.equal(verify.additionalProperties, false);
  assert.equal(verify.properties.run_repo_check_scripts.default, true);
  assert.deepEqual(verify.properties.check_script_allowlist.default, ["okf:check", "lint", "typecheck", "test"]);
  assert.equal(verify.properties.check_script_timeout_seconds.default, 600);
});

test("beta63: loop ingests conventions at plan-ready + runs final-verify checks + emits findings (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /ingestRepoConventions\(plan\.worktreePath/);
  assert.match(src, /loop\.repo_conventions_ingested/);
  assert.match(src, /runFinalVerifyChecks\(sessionId, plan, cycle\)/);
  assert.match(src, /loop\.convention_check_ran/);
  assert.match(src, /loop\.convention_check_failed/);
  // beta.70 (F2): convention findings downgrade a pass to revise ONLY when a
  // convention finding is BLOCKING (diff_addressable + medium+). A process-
  // class finding (e.g. OKF bundle regen) no longer force-revises.
  assert.match(src, /blockingConvention\.length > 0/);
  assert.match(src, /report\.verdict === "pass" && blockingConvention\.length > 0/);
});

test("beta63: lead/worker/adversary prompts thread renderConventionsForPrompt (source)", () => {
  assert.match(S("src/adapters/claude-sdk.ts"), /renderConventionsForPrompt\(params\.brief\.repoConventions, "lead"\)/);
  assert.match(S("src/orchestrator/sonnet-worker.ts"), /renderConventionsForPrompt\(brief\.repoConventions, "worker"\)/);
  assert.match(S("src/orchestrator/fable5-adversary.ts"), /renderConventionsForPrompt\(input\.repoConventions, "adversary"\)/);
});
