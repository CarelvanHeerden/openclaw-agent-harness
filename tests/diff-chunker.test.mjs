import test from "node:test";
import assert from "node:assert/strict";

let splitDiffOnFileBoundaries, checkPriceDrift;
try {
  ({ splitDiffOnFileBoundaries, checkPriceDrift } = await import("../dist/adapters/claude-sdk.js"));
} catch {
  splitDiffOnFileBoundaries = null;
}

const oneFile = (name, bytes) => `diff --git a/${name} b/${name}\nindex abc..def 100644\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,1 @@\n+` + "x".repeat(bytes) + "\n";

test("splitDiffOnFileBoundaries: small diff returns a single chunk",
  { skip: splitDiffOnFileBoundaries === null }, () => {
    const d = oneFile("a.ts", 100) + oneFile("b.ts", 100);
    const chunks = splitDiffOnFileBoundaries(d, 50_000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], d);
  });

test("splitDiffOnFileBoundaries: splits on file boundary when total exceeds cap",
  { skip: splitDiffOnFileBoundaries === null }, () => {
    const d = oneFile("a.ts", 4000) + oneFile("b.ts", 4000) + oneFile("c.ts", 4000);
    const chunks = splitDiffOnFileBoundaries(d, 5000);
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    for (const c of chunks) {
      assert.ok(c.length <= 5500, `chunk too large: ${c.length}`);
      assert.ok(c.startsWith("diff --git"), "each chunk should start on a file boundary");
    }
  });

test("splitDiffOnFileBoundaries: truncates a single oversized file and annotates",
  { skip: splitDiffOnFileBoundaries === null }, () => {
    const d = oneFile("huge.ts", 20_000);
    const chunks = splitDiffOnFileBoundaries(d, 5000);
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].length <= 5500);
    assert.match(chunks[0], /TRUNCATED: file diff was \d+ bytes, capped at 5000/);
  });

test("checkPriceDrift: within 20% -> no warn",
  { skip: checkPriceDrift === null }, () => {
    // fable5: input 10, output 50 per M. 100k in + 50k out = 1 + 2.5 = $3.50
    const r = checkPriceDrift("claude-fable-5", 3.6, 100_000, 50_000);
    assert.equal(r.warn, false);
    assert.ok(r.drift < 0.2);
    assert.ok(r.estimated > 3 && r.estimated < 4);
  });

test("checkPriceDrift: > 20% drift -> warn",
  { skip: checkPriceDrift === null }, () => {
    const r = checkPriceDrift("claude-fable-5", 6.0, 100_000, 50_000);
    assert.equal(r.warn, true);
    assert.ok(r.drift > 0.2);
  });

test("checkPriceDrift: unknown model -> no warn",
  { skip: checkPriceDrift === null }, () => {
    const r = checkPriceDrift("claude-nothing", 1.0, 100_000, 50_000);
    assert.equal(r.warn, false);
  });
