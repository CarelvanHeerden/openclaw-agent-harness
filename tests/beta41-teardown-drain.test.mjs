// beta.41: teardown drain-guard. A plugin re-register (OKF / gateway
// auto-discovery churn when plugins.allow is empty) schedules a fire-and-forget
// teardown of the previous runtime. If teardown closes the state DB out from
// under an in-flight loop.run() (which holds runtime.state.db), the loop's next
// prepare() throws "database is not open" -> `loop crashed`. This killed the
// beta.39 + beta.40 ProjectThanos smokes. Fix: teardown drains running loops
// (via runningSessionIds()) before closing, bounded by
// loop.teardown_drain_seconds. teardown() is not exported (it's an internal of
// the plugin entry), so these are source + wiring assertions, matching the
// beta.19/33/40 source-assertion pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
const configSrc = readFileSync(join(here, "..", "src", "config.ts"), "utf8");
const manifest = JSON.parse(readFileSync(join(here, "..", "openclaw.plugin.json"), "utf8"));

test("beta41: teardown imports and consults runningSessionIds", () => {
  assert.ok(
    /import \{[^}]*runningSessionIds[^}]*\} from "\.\/orchestrator\/loop\.js"/.test(indexSrc),
    "index.ts must import runningSessionIds from the loop module",
  );
  assert.ok(indexSrc.includes("runningSessionIds().length > 0"), "teardown must check for running loops");
});

test("beta41: the drain-wait happens BEFORE state.close()", () => {
  const drainIdx = indexSrc.indexOf("teardown deferred: waiting for running loop");
  const closeIdx = indexSrc.indexOf("runtime.state.close()");
  assert.ok(drainIdx > 0, "drain-wait log line must exist");
  assert.ok(closeIdx > 0, "state.close() must exist");
  assert.ok(drainIdx < closeIdx, "the drain-wait must precede state.close() so the DB stays open for the loop");
});

test("beta41: the drain is bounded by loop.teardown_drain_seconds with a default fallback", () => {
  assert.ok(
    indexSrc.includes("runtime.config?.loop?.teardown_drain_seconds ?? 3600"),
    "drain must read teardown_drain_seconds with a 3600 fallback",
  );
  assert.ok(
    indexSrc.includes("teardown drain deadline exceeded"),
    "must log loudly and proceed if the drain deadline is exceeded (bounded, not infinite)",
  );
});

test("beta41: teardown_drain_seconds is wired into config type, defaults, and manifest", () => {
  assert.ok(configSrc.includes("teardown_drain_seconds: number;"), "LoopConfig type must declare teardown_drain_seconds");
  assert.ok(configSrc.includes("teardown_drain_seconds: 3600"), "DEFAULTS must set teardown_drain_seconds");
  const loopProps = manifest.configSchema?.properties?.loop?.properties;
  assert.ok(loopProps?.teardown_drain_seconds, "manifest loop block must declare teardown_drain_seconds (gateway source of truth)");
  assert.equal(loopProps.teardown_drain_seconds.default, 3600, "manifest default must be 3600");
});
