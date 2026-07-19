// beta.42: the worker SDK call must be bounded by worker_timeout_seconds. A
// hung worker await was the true root cause of the ~5h30m silent wedge on the
// beta.39 + beta.40 ProjectThanos smokes (the loop's hard-deadline check only
// runs BETWEEN sub-tasks, so an unresolved await inside a sub-task froze the
// whole loop with no timeout). withTimeout races the worker against a rejecting
// timeout so a hang becomes a bounded, catchable failure.
import { test } from "node:test";
import assert from "node:assert/strict";

let mod;
try {
  mod = await import("../dist/orchestrator/loop.js");
} catch {
  mod = null;
}
const withTimeout = mod?.withTimeout ?? null;
const WorkerTimeoutError = mod?.WorkerTimeoutError ?? null;

test("beta42: withTimeout resolves a fast promise normally", { skip: !withTimeout }, async () => {
  const v = await withTimeout(Promise.resolve("ok"), 5);
  assert.equal(v, "ok");
});

test("beta42: withTimeout rejects with WorkerTimeoutError when the promise hangs past the bound", { skip: !withTimeout }, async () => {
  const never = new Promise(() => {}); // never resolves
  await assert.rejects(
    () => withTimeout(never, 0.05), // 50ms bound
    (err) => {
      assert.ok(err instanceof WorkerTimeoutError, "must be a WorkerTimeoutError");
      assert.equal(err.seconds, 0.05);
      assert.match(err.message, /worker_timeout_seconds/);
      return true;
    },
  );
});

test("beta42: withTimeout with seconds<=0 disables the bound (returns the promise as-is)", { skip: !withTimeout }, async () => {
  const v = await withTimeout(Promise.resolve(42), 0);
  assert.equal(v, 42);
});

test("beta42: a rejecting worker promise still rejects (timeout doesn't swallow real errors)", { skip: !withTimeout }, async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error("boom")), 5), /boom/);
});

// Source assertion: the worker call site actually uses withTimeout with the
// configured worker_timeout_seconds (guards against the wrapper existing but
// not being wired -- the beta.16/17 telemetry-truth lesson).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const loopSrc = readFileSync(join(here, "..", "src", "orchestrator", "loop.ts"), "utf8");

test("beta42: the worker call site is wrapped in withTimeout(worker_timeout_seconds)", () => {
  assert.match(
    loopSrc,
    /withTimeout\(\s*this\.deps\.runWorker\([^)]*\}\),\s*this\.deps\.config\.loop\.worker_timeout_seconds/s,
    "runWorker must be raced against worker_timeout_seconds",
  );
  assert.ok(loopSrc.includes('"loop.worker_timeout"'), "a worker timeout must emit loop.worker_timeout audit");
});
