import test from "node:test";
import assert from "node:assert/strict";

let topoSortSubTasks;
try {
  ({ topoSortSubTasks } = await import("../dist/orchestrator/loop.js"));
} catch {
  topoSortSubTasks = null;
}

const st = (seq, dependsOn) => ({
  seq,
  title: `t${seq}`,
  intent: "",
  filesLikelyTouched: [],
  successCriteria: [],
  estimatedTokens: 100,
  dependsOn,
});

test("topoSortSubTasks: no deps preserves seq order",
  { skip: topoSortSubTasks === null }, () => {
    const out = topoSortSubTasks([st(1), st(2), st(3)]);
    assert.deepEqual(out.map((s) => s.seq), [1, 2, 3]);
  });

test("topoSortSubTasks: linear chain",
  { skip: topoSortSubTasks === null }, () => {
    const out = topoSortSubTasks([st(3, [2]), st(2, [1]), st(1)]);
    assert.deepEqual(out.map((s) => s.seq), [1, 2, 3]);
  });

test("topoSortSubTasks: diamond",
  { skip: topoSortSubTasks === null }, () => {
    // 1 -> 2 -> 4, 1 -> 3 -> 4
    const out = topoSortSubTasks([st(4, [2, 3]), st(3, [1]), st(2, [1]), st(1)]);
    const idx = Object.fromEntries(out.map((s, i) => [s.seq, i]));
    assert.equal(idx[1] < idx[2], true);
    assert.equal(idx[1] < idx[3], true);
    assert.equal(idx[2] < idx[4], true);
    assert.equal(idx[3] < idx[4], true);
  });

test("topoSortSubTasks: cycle detected",
  { skip: topoSortSubTasks === null }, () => {
    assert.throws(() => topoSortSubTasks([st(1, [2]), st(2, [1])]), /cycle/i);
  });

test("topoSortSubTasks: ignores dangling deps to non-existent seqs",
  { skip: topoSortSubTasks === null }, () => {
    const out = topoSortSubTasks([st(1, [99]), st(2)]);
    assert.deepEqual(out.map((s) => s.seq), [1, 2]);
  });
