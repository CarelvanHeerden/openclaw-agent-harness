import test from "node:test";
import assert from "node:assert/strict";

let vc;
try {
  vc = await import("../dist/orchestrator/verify-contract.js");
} catch {
  vc = null;
}

const st = (over) => ({ seq: 1, title: "", intent: "", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 100, ...over });

// ============================================================
// beta.8 regression tests (must still pass)
// ============================================================

test("inferVerifyContract: 'push branch to origin' infers branch_pushed",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({ title: "Push branch to origin + verify remote SHA", intent: "git push" }));
    assert.ok(c.some((x) => x.kind === "branch_pushed"), JSON.stringify(c));
  });

test("inferVerifyContract: 'open draft PR' infers pr_opened",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({ title: "Open draft PR + capture URL", intent: "open a pull request" }));
    assert.ok(c.some((x) => x.kind === "pr_opened"), JSON.stringify(c));
  });

test("inferVerifyContract: 'end-to-end verification of remote side effects' infers push + PR",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({ title: "End-to-end verification of remote side effects", intent: "verify the remote side effects" }));
    const kinds = c.map((x) => x.kind);
    assert.ok(kinds.includes("branch_pushed"), JSON.stringify(c));
    assert.ok(kinds.includes("pr_opened"), JSON.stringify(c));
  });

test("inferVerifyContract: 'write docs/SMOKE.md' infers file_written with the path",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({ title: "Create branch + write docs/SMOKE.md", intent: "write the file", filesLikelyTouched: ["docs/SMOKE.md"] }));
    const fw = c.find((x) => x.kind === "file_written");
    assert.ok(fw, JSON.stringify(c));
    assert.equal(fw.path, "docs/SMOKE.md");
  });

test("inferVerifyContract: 'commit the change' (no push) infers commit_made",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({ title: "Commit the single-file change", intent: "commit" }));
    assert.ok(c.some((x) => x.kind === "commit_made"), JSON.stringify(c));
    assert.ok(!c.some((x) => x.kind === "branch_pushed"));
  });

test("inferVerifyContract: pure-reasoning sub-task infers nothing (trust SDK)",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({ title: "Analyse the failure modes", intent: "think about edge cases", successCriteria: ["list of risks"] }));
    assert.equal(c.length, 0, JSON.stringify(c));
  });

test("inferVerifyContract: explicit lead-declared verify wins over inference",
  { skip: vc === null }, () => {
    const explicit = [{ kind: "pr_opened" }];
    const c = vc.inferVerifyContract(st({ title: "Analyse", intent: "no observable output", verify: explicit }));
    assert.deepEqual(c, explicit);
  });

// ============================================================
// beta.9 NEW: precise contract kinds
// ============================================================

// --- file_written (beta.9 fix: includes untracked) ---

test("inferVerifyContract: 'write file X' infers file_written (beta.9 fix for untracked)",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Write src/hello.ts",
      intent: "create the file with the handler",
      filesLikelyTouched: ["src/hello.ts"],
    }));
    const fw = c.find((x) => x.kind === "file_written");
    assert.ok(fw, `expected file_written in ${JSON.stringify(c)}`);
    assert.equal(fw.path, "src/hello.ts");
    // Should NOT infer commit_made or branch_pushed for a pure write sub-task.
    assert.ok(!c.some((x) => x.kind === "branch_pushed"), "should not infer push for write-only task");
    assert.ok(!c.some((x) => x.kind === "commit_made"), "should not infer commit for write-only task");
  });

test("inferVerifyContract: 'create docs/README.md' from intent infers file_written even without filesLikelyTouched",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Create docs/README.md",
      intent: "add a readme file to docs/",
    }));
    const fw = c.find((x) => x.kind === "file_written");
    assert.ok(fw, `expected file_written in ${JSON.stringify(c)}`);
    assert.ok(fw.path.includes("README.md"), `expected path to include README.md, got ${fw.path}`);
  });

// --- file_committed ---

test("inferVerifyContract: 'commit' with a file path infers file_committed",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Commit the single-file change",
      intent: "git add + commit docs/SMOKE.md",
      filesLikelyTouched: ["docs/SMOKE.md"],
    }));
    const fc = c.find((x) => x.kind === "file_committed");
    assert.ok(fc, `expected file_committed in ${JSON.stringify(c)}`);
    assert.equal(fc.path, "docs/SMOKE.md");
    // Also infers commit_made for backward compat.
    assert.ok(c.some((x) => x.kind === "commit_made"), `expected commit_made too in ${JSON.stringify(c)}`);
  });

test("inferVerifyContract: 'commit' without file path infers commit_made only",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Commit staged changes",
      intent: "run git commit -m message",
    }));
    assert.ok(c.some((x) => x.kind === "commit_made"), JSON.stringify(c));
    // No path to infer file_committed from.
    assert.ok(!c.some((x) => x.kind === "file_committed"), `should not infer file_committed without path: ${JSON.stringify(c)}`);
  });

// --- remote_branch_exists ---

test("inferVerifyContract: 'push branch' infers remote_branch_exists",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Push branch to origin",
      intent: "git push origin harness/feat",
    }));
    assert.ok(c.some((x) => x.kind === "remote_branch_exists"), JSON.stringify(c));
  });

test("inferVerifyContract: 'verify remote SHA' infers remote_branch_exists",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Verify remote SHA matches local HEAD",
      intent: "confirm the branch exists on origin with matching SHA",
    }));
    assert.ok(c.some((x) => x.kind === "remote_branch_exists"), JSON.stringify(c));
  });

// --- commit_sha_matches ---

test("inferVerifyContract: 'push branch' infers commit_sha_matches",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Push branch to origin + verify remote SHA",
      intent: "git push",
    }));
    assert.ok(c.some((x) => x.kind === "commit_sha_matches"), JSON.stringify(c));
  });

test("inferVerifyContract: 'verify remote SHA' (no push keyword) infers commit_sha_matches",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Verify remote SHA matches local HEAD",
      intent: "confirm sha match",
    }));
    assert.ok(c.some((x) => x.kind === "commit_sha_matches"), JSON.stringify(c));
  });

// --- pr_state ---

test("inferVerifyContract: 'open draft PR' infers pr_state=draft",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Open draft PR for the branch",
      intent: "POST /pulls with draft:true",
    }));
    const ps = c.find((x) => x.kind === "pr_state");
    assert.ok(ps, `expected pr_state in ${JSON.stringify(c)}`);
    assert.equal(ps.state, "draft");
  });

test("inferVerifyContract: 'open PR' (non-draft) infers pr_state=open",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Open pull request for the branch",
      intent: "POST /pulls",
    }));
    const ps = c.find((x) => x.kind === "pr_state");
    assert.ok(ps, `expected pr_state in ${JSON.stringify(c)}`);
    assert.equal(ps.state, "open");
  });

// --- file_pushed + file_in_pr (from end-to-end) ---

test("inferVerifyContract: 'end-to-end verification' with file infers file_pushed + file_in_pr + pr_opened",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "End-to-end verification of remote side effects",
      intent: "verify the remote side effects for docs/SMOKE.md",
      filesLikelyTouched: ["docs/SMOKE.md"],
    }));
    const kinds = c.map((x) => x.kind);
    assert.ok(kinds.includes("file_pushed"), `expected file_pushed in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("file_in_pr"), `expected file_in_pr in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("pr_opened"), `expected pr_opened in ${JSON.stringify(kinds)}`);
    // Note: pr_state is NOT inferred for e2e tasks (state depends on prior sub-tasks;
    // e2e just verifies PR exists, not specific state).
    assert.ok(!kinds.includes("pr_state"), `e2e should not infer pr_state (state unknown): ${JSON.stringify(kinds)}`);
  });

// --- no duplicates from overlapping regexes ---

test("inferVerifyContract: no duplicate contract kinds for push+PR sub-task",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Push branch and open draft PR",
      intent: "git push then POST /pulls draft:true",
    }));
    const kindCounts = {};
    for (const x of c) {
      const key = x.kind + (x.path ?? "") + (x.state ?? "");
      kindCounts[key] = (kindCounts[key] ?? 0) + 1;
    }
    for (const [key, count] of Object.entries(kindCounts)) {
      assert.equal(count, 1, `duplicate contract: ${key} appears ${count} times`);
    }
  });

// --- stage/git add also triggers commit inference ---

test("inferVerifyContract: 'stage the change' infers commit_made",
  { skip: vc === null }, () => {
    const c = vc.inferVerifyContract(st({
      title: "Stage and commit src/index.ts",
      intent: "git add src/index.ts && git commit",
      filesLikelyTouched: ["src/index.ts"],
    }));
    assert.ok(c.some((x) => x.kind === "commit_made"), JSON.stringify(c));
  });
