import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the committed release tree is byte-for-byte bound to its deterministic build", () => {
  const checked = spawnSync(process.execPath, ["scripts/gen-build-integrity.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});
