/**
 * The containment disclosure is part of the release, not a nice-to-have.
 *
 * v2 does not weaken any control, but it removes the assumption every control
 * rested on: that the worker is a capable, non-adversarial Anthropic model
 * under contract. An operator can now point a role at weights of unknown
 * provenance. That is a real change in the threat model and it is documented
 * rather than enforced, because the harness cannot tell a trusted repository
 * from an untrusted one.
 *
 * These tests exist so the disclosure cannot be quietly softened or dropped in
 * a later edit — which is the normal fate of an inconvenient paragraph. They
 * check for the SUBSTANCE (an owner, exit criteria, the trusted-repo-only
 * guidance) rather than exact prose, so the section can be rewritten but not
 * hollowed out.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const security = readFileSync(resolve(root, "SECURITY.md"), "utf8");

/** The v2 section, isolated so a match elsewhere in the file cannot satisfy a test. */
const section = (() => {
  const start = security.indexOf("### `2.0.0`: third-party backends make this materially worse");
  assert.ok(start > 0, "SECURITY.md has no v2 third-party-backend section at all");
  const next = security.indexOf("\n## ", start);
  return security.slice(start, next === -1 ? undefined : next);
})();

test("the disclosure names the assumption v2 removes", () => {
  // The specific claim that stops being true, not a general warning.
  assert.match(section, /capable but not adversarial/,
    "the section does not name the assumption every control rests on");
  assert.match(section, /configuration choice/,
    "the section does not say the assumption became a configuration choice");
});

test("non-Anthropic workers are documented as trusted-repo-only", () => {
  assert.match(section, /trusted[- ]rep/i, "the trusted-repo-only guidance is missing");
  // And it must say what 'trusted' means, or it is advice nobody can follow.
  assert.match(section, /dependencies|transitive|prompt-injected/i,
    "'trusted repository' is asserted but never defined");
});

test("the risk carries an owner and exit criteria", () => {
  assert.match(section, /\*\*Owner\*\*/, "no owner is named");
  assert.match(section, /\*\*Exit criteria\*\*/, "no exit criteria are stated");
  // Both halves, not either: the reasoning is in the table itself.
  assert.match(section, /read-only/i, "exit criteria do not mention a read-only filesystem");
  assert.match(section, /egress/i, "exit criteria do not mention egress control");
  assert.match(section, /docs\/WORKER_ISOLATION\.md/, "exit criteria do not point at the scoping doc");
});

test("the disclosure does not overclaim what v2 added", () => {
  // The four M5/M6 hardening items are real and easy to mistake for
  // containment. The section must say so explicitly.
  assert.match(section, /None of them makes either path a sandbox|not a sandbox/i,
    "the section lists v2's hardening without disclaiming that it is containment");
});

test("the section is marked for deletion rather than softening", () => {
  // An expiry condition, so this does not calcify into permanent boilerplate.
  assert.match(section, /deleted rather than softened|delete/i,
    "the section has no stated end condition");
});

test("the honest bash-guard table is still there and still honest", () => {
  // The v2 section leans on it. If the table were ever quietly trimmed, the
  // new section's reasoning would be resting on nothing.
  assert.match(security, /speed bump, not a wall/);
  assert.match(security, /python3 exfil\.py/);
  assert.match(security, /\*\*allowed\*\*/);
});

test("SECURITY.md does not link source files that were renamed away", () => {
  // M2 and M3 renamed the role and adapter modules. A security doc pointing at
  // a file that no longer exists reads as unmaintained, which is corrosive for
  // exactly the document that most needs to be believed.
  const gone = ["claude-sdk.ts", "sonnet-worker.ts", "fable5-lead.ts", "fable5-adversary.ts"];
  for (const name of gone) {
    assert.ok(!security.includes(name), `SECURITY.md still links the renamed ${name}`);
  }
});

test("the README points at the modules that actually exist", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  for (const name of ["claude-sdk.ts", "sonnet-worker.ts", "fable5-lead.ts", "fable5-adversary.ts"]) {
    assert.ok(!readme.includes(name), `README still lists the renamed ${name}`);
  }
  // And it names the second backend, since "wraps the Claude SDK" is now only
  // half of what the harness does.
  assert.match(readme, /src\/adapters\/acp\.ts/, "the README does not mention the ACP backend");
});
