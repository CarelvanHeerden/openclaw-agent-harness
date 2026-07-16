import test from "node:test";
import assert from "node:assert/strict";

let vc;
try {
  vc = await import("../dist/orchestrator/verify-contract.js");
} catch {
  vc = null;
}

const st = (over) => ({ seq: 1, title: "", intent: "", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 100, ...over });

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
