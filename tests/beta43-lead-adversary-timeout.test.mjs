// beta.43: bound the lead + adversary SDK awaits with withTimeout, closing the
// last two unbounded structured-call awaits (beta.42 only bounded the worker).
// The unbounded lead await is precisely what made a healthy ~10min plan on the
// beta.42 ProjectThanos smoke indistinguishable from a wedge. withTimeout's
// behavioral guarantees are covered by beta42-worker-timeout; here we assert
// the two new call sites are actually wired (guards against the wrapper
// existing but not being applied -- the telemetry-truth lesson).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const loopSrc = readFileSync(join(here, "..", "src", "orchestrator", "loop.ts"), "utf8");
const cfgSrc = readFileSync(join(here, "..", "src", "config.ts"), "utf8");
const manifestSrc = readFileSync(join(here, "..", "openclaw.plugin.json"), "utf8");

test("beta43: runLead is wrapped in withTimeout(lead_timeout_seconds)", () => {
  assert.match(
    loopSrc,
    /withTimeout\(\s*this\.deps\.runLead\([^)]*\),\s*this\.deps\.config\.loop\.lead_timeout_seconds/s,
    "runLead must be raced against lead_timeout_seconds",
  );
  assert.ok(loopSrc.includes('"loop.lead_timeout"'), "a lead timeout must emit loop.lead_timeout audit");
});

test("beta43: runAdversary is wrapped in withTimeout(adversary_timeout_seconds)", () => {
  assert.match(
    loopSrc,
    /withTimeout\(\s*this\.deps\.runAdversary\([^)]*\),\s*this\.deps\.config\.loop\.adversary_timeout_seconds/s,
    "runAdversary must be raced against adversary_timeout_seconds",
  );
  assert.ok(loopSrc.includes('"loop.adversary_timeout"'), "an adversary timeout must emit loop.adversary_timeout audit");
});

test("beta43: lead_timeout_seconds exists in config default + manifest schema", () => {
  assert.match(cfgSrc, /lead_timeout_seconds:\s*900/, "config default must include lead_timeout_seconds");
  assert.ok(manifestSrc.includes('"lead_timeout_seconds"'), "manifest configSchema must declare lead_timeout_seconds");
});

// Behavioral: a hung lead/adversary now fails the run cleanly instead of
// hanging. We import the real loop + withTimeout to confirm the wiring rejects
// (full loop behavior is exercised by the beta38/40 suites; here we just prove
// withTimeout is the mechanism and rejects on a hang).
import { withTimeout, WorkerTimeoutError } from "../dist/orchestrator/loop.js";

test("beta43: a hung structured call rejects via withTimeout (shared mechanism)", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 0.05),
    (e) => e instanceof WorkerTimeoutError,
  );
});
