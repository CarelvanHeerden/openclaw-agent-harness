/**
 * rc.9 -- the path policy, after StitchGuard session f7c4e585.
 *
 * The incident denial read:
 *
 *   edit path '.env.example, README.md, docs/deployment-runbook.md,
 *              docs/slack/client-offboarding-app-manifest.yaml' is denylisted
 *
 * Four files in one path string. The read-only probe run while packaging the
 * evidence then found three separate defects behind it, and the first two pull
 * in opposite directions, which is why they had gone unnoticed together:
 *
 *   `.env.example`                  -> denied   (correct rule, wrong outcome:
 *                                                the brief required this file)
 *   `/repo/.env.production`         -> ALLOWED  (a real hole)
 *   `.env.example, README.md`       -> denied   (by accident -- see below)
 *   `README.md, .env.production`    -> ALLOWED  (the same hole, order-dependent)
 *
 * The accident is worth naming because it is what kept the hole hidden: the
 * pattern `.env.*` compiles to `^\.env\..*$`, and `.*` cheerfully swallows
 * ", README.md". Put the secret second instead of first and the whole string
 * stops matching. A denial that depends on the ORDER of the files in it is not
 * a control.
 *
 * These tests pin all four probe results, both directions of the exception, and
 * the representation gap underneath: `apply_patch` carries no per-file path at
 * all, only a `patchText` blob the guard never read.
 *
 * Every credential-shaped fixture below is BUILT from fragments rather than
 * written out, so this file contains no literal token.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAcpGuard, acpPathsFromToolCall, pathMatchesDenylist, denylistRuleFor } from "../dist/safety/bash-guard.js";
import {
  resolvePathForPolicy,
  pathsFromPatchText,
  scanPatchForSecrets,
  looksLikeMultiplePaths,
  templateExceptionApplies,
} from "../dist/safety/path-policy.js";
import { parseHarnessConfig } from "../dist/config.js";

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const MINIMAL_CONFIG = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["example-org/*"], default_base_branch: "main" },
};
const DEFAULTS = parseHarnessConfig(MINIMAL_CONFIG);

/** The default denylist as shipped, so these tests move if the default moves. */
const DENY = DEFAULTS.safety.path_denylist;

/** Synthetic credentials, assembled so no literal token appears in this file. */
const FAKE = {
  github: "ghp_" + "a".repeat(36),
  slack: "xoxb-" + "9".repeat(10) + "-" + "b".repeat(20),
  bearer: "Bearer " + "c".repeat(26),
  pem: "-".repeat(5) + "BEGIN RSA PRIVATE " + "KEY" + "-".repeat(5),
  opaque: "d".repeat(40) + "==",
};

const guard = (over = {}) =>
  buildAcpGuard({
    bash_whitelist: ["git"],
    bash_denylist_tokens: [],
    path_denylist: DENY,
    allow_git_push: false,
    allow_network_commands: false,
    ...over,
  });

const edit = (path) => ({ kind: "edit", title: "1 file", locations: [{ path }], rawInput: {} });
const patchCall = (patchText, title = "patch") => ({ kind: "edit", title, locations: [], rawInput: { patchText } });
const patchOf = (...files) =>
  `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}`).join("\n")}\n*** End Patch`;

/* ------------------------------------------------------------------ *
 * The four probe results
 * ------------------------------------------------------------------ */

test("rc.9 probe: an absolute secret path is no longer allowed", async () => {
  // THE hole. The literal branch of the matcher had `p.endsWith("/" + pat)`
  // and the wildcard branch had no equivalent, so a pattern with a `*` in it
  // did not understand directories.
  const v = await guard()(edit("/repo/.env.production"));
  assert.equal(v.allow, false, "/repo/.env.production was ALLOWED at rc.8");
  assert.equal(v.denial.code, "path_denylisted");
  assert.equal(v.denial.rule, ".env.*", "the operator must be told WHICH rule fired");
});

test("rc.9 probe: a joined path list is refused whichever order it is in", async () => {
  const g = guard();
  const first = await g(edit(".env.example, README.md"));
  const second = await g(edit("README.md, .env.production"));

  assert.equal(first.allow, false);
  assert.equal(second.allow, false, "README.md, .env.production was ALLOWED at rc.8");
  // Both must fail for the SAME reason. At rc.8 the first was denied by the
  // accident of `.*` swallowing the tail, which is not a decision about paths.
  assert.equal(first.denial.code, "path_unresolvable");
  assert.equal(second.denial.code, "path_unresolvable");
  assert.match(second.denial.message, /name 2 files rather than one/);
});

test("rc.9 probe: individually-represented paths still behave exactly as before", async () => {
  const g = guard();
  assert.equal((await g(edit(".env.production"))).allow, false);
  assert.equal((await g(edit(".env.example"))).allow, false, "still denied with no exception configured");
  assert.equal((await g(edit("README.md"))).allow, true);
});

/* ------------------------------------------------------------------ *
 * 1. The authorised template
 * ------------------------------------------------------------------ */

test("rc.9: an explicitly authorised template may be edited; real secrets may not", async () => {
  const g = guard({ path_denylist_exceptions: [".env.example"] });
  assert.equal((await g(edit(".env.example"))).allow, true, "the file the brief required");

  for (const secret of [".env", ".env.local", ".env.production", "id_rsa", ".secrets/token", "/etc/passwd"]) {
    const v = await g(edit(secret));
    assert.equal(v.allow, false, `${secret} must stay denied`);
  }
});

test("rc.9: the exception is OFF by default -- it is a decision, not an inheritance", () => {
  assert.deepEqual(DEFAULTS.safety.path_denylist_exceptions, []);
});

test("rc.9: authorising a template does not authorise putting a credential in it", async () => {
  const g = guard({ path_denylist_exceptions: [".env.example"] });
  const v = await g(
    patchCall(`*** Begin Patch\n*** Update File: .env.example\n+SLACK_BOT_TOKEN=${FAKE.slack}\n*** End Patch`),
  );
  assert.equal(v.allow, false);
  assert.equal(v.denial.code, "secret_material");
  // The diagnostic reaches a human, so it must describe the shape, not the value.
  assert.ok(!v.denial.message.includes(FAKE.slack), "the token must not be echoed back");
});

test("rc.9: a placeholder in a template is still allowed -- this is the whole point", async () => {
  const g = guard({ path_denylist_exceptions: [".env.example"] });
  const placeholder = patchCall(
    "*** Begin Patch\n*** Update File: .env.example\n+CLIENT_OFFBOARDING_AGENT_ENABLED=false\n" +
      "+CLIENT_OFFBOARDING_SLACK_SIGNING_SECRET=example-client-offboarding-signing-secret\n*** End Patch",
  );
  assert.equal((await g(placeholder)).allow, true);
});

test("rc.9: the exception is exact -- no globs, no directories, no neighbours", () => {
  const r = (p) => resolvePathForPolicy(p);
  assert.equal(templateExceptionApplies(r(".env.example"), [".env.example"]), true);
  assert.equal(templateExceptionApplies(r(".env.production"), [".env.example"]), false);
  // A glob or directory entry is discarded rather than honoured: it would
  // re-create `.env.*` with the sign flipped.
  assert.equal(templateExceptionApplies(r(".env.production"), [".env.*"]), false);
  assert.equal(templateExceptionApplies(r("config/.env.example"), ["config/"]), false);
  assert.equal(templateExceptionApplies(r(".env.example"), []), false);
});

/* ------------------------------------------------------------------ *
 * 2. Real-shaped multi-file patches
 * ------------------------------------------------------------------ */

test("rc.9: apply_patch exposes its targets, which rc.8 never read", () => {
  const text = patchOf(".env.example", "README.md", "docs/deployment-runbook.md");
  assert.deepEqual(pathsFromPatchText(text), [".env.example", "README.md", "docs/deployment-runbook.md"]);

  // Through the guard's own extractor, with no locations[] at all.
  const found = acpPathsFromToolCall({ kind: "edit", locations: [], rawInput: { patchText: text } });
  assert.deepEqual(found.sort(), [".env.example", "README.md", "docs/deployment-runbook.md"].sort());
});

test("rc.9: every target is checked, and ordering cannot change the verdict", async () => {
  const g = guard();
  const forbidden = ".env.production";
  const innocent = ["README.md", "docs/a.md", "docs/b.md"];

  for (let i = 0; i <= innocent.length; i++) {
    const files = [...innocent.slice(0, i), forbidden, ...innocent.slice(i)];
    const v = await g(patchCall(patchOf(...files), `${files.length} files`));
    assert.equal(v.allow, false, `denied wherever the secret sits (position ${i})`);
    assert.equal(v.denial.code, "path_denylisted");
    assert.deepEqual(v.denial.paths, [forbidden], "and it names the file that caused it");
  }
});

test("rc.9: the incident's own four-file patch is denied, and says which file and which rule", async () => {
  const v = await guard()(
    patchCall(
      patchOf(
        ".env.example",
        "README.md",
        "docs/deployment-runbook.md",
        "docs/slack/client-offboarding-app-manifest.yaml",
      ),
      "4 files",
    ),
  );
  assert.equal(v.allow, false);
  assert.deepEqual(v.denial.paths, [".env.example"]);
  assert.equal(v.denial.rule, ".env.*");
  // rc.8's operator was told none of this. The message must carry the remedy.
  assert.match(v.denial.message, /path_denylist_exceptions/);
});

test("rc.9: adds, deletes and renames are targets too", () => {
  const text =
    "*** Begin Patch\n*** Add File: docs/new.md\n*** Delete File: .env.local\n*** Move to: .env.production\n*** End Patch";
  assert.deepEqual(pathsFromPatchText(text).sort(), [".env.local", ".env.production", "docs/new.md"].sort());
});

test("rc.9: a patch with no directives exposes no path and fails closed", async () => {
  const v = await guard()({ kind: "edit", locations: [], rawInput: { patchText: "not a patch" } });
  assert.equal(v.allow, false);
  assert.equal(v.denial.code, "no_path_exposed");
});

test("rc.9: a comma is still a legal filename character", async () => {
  const g = guard();
  assert.equal(looksLikeMultiplePaths("my,file.txt"), false);
  assert.equal(looksLikeMultiplePaths("Report, Final Version.pdf"), false, "a space means it is prose, not a list");
  assert.equal((await g(edit("my,file.txt"))).allow, true);
  assert.equal((await g(edit("docs/Report, Final Version.pdf"))).allow, true);
});

/* ------------------------------------------------------------------ *
 * 3. Normalisation: absolute, relative, traversal, symlink
 * ------------------------------------------------------------------ */

test("rc.9: traversal cannot walk out to a secret", async () => {
  const g = guard();
  for (const p of ["docs/../.env", "./.env.production", "a/b/../../.env", "docs/./../.env.local"]) {
    const v = await g(edit(p));
    assert.equal(v.allow, false, `${p} must normalise onto the denylist`);
  }
});

test("rc.9: an in-repo absolute path is judged repo-relative, and vice versa", async () => {
  const root = mkdtempSync(join(tmpdir(), "rc9-root-"));
  const g = guard({ repoRoot: root });
  assert.equal((await g(edit(`${root}/.env.production`))).allow, false);
  assert.equal((await g(edit(".env.production"))).allow, false);
  // A same-named file that is NOT a secret is unaffected.
  assert.equal((await g(edit(`${root}/docs/env.md`))).allow, true);
});

test("rc.9: a symlink is judged by its target, not its name", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rc9-link-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "rc9-outside-")));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(outside, ".env.production"), "PLACEHOLDER=1\n");
  // An innocent-looking name inside the repo pointing at a real secret.
  symlinkSync(join(outside, ".env.production"), join(root, "docs", "notes.md"));

  const withResolver = guard({ repoRoot: root, realpath: (p) => realpathSync(p) });
  const v = await withResolver(edit("docs/notes.md"));
  assert.equal(v.allow, false, "the link target is a denylisted file");
  assert.equal(v.denial.rule, ".env.*");

  // And the read path must agree with the edit path, or the guard is a sieve.
  const r = await withResolver({ kind: "read", locations: [{ path: "docs/notes.md" }], rawInput: {} });
  assert.equal(r.allow, false, "read and edit must reach the same verdict");
});

test("rc.9: a path that cannot be resolved safely fails closed", () => {
  const boom = () => {
    const e = new Error("EACCES: permission denied");
    e.code = "EACCES";
    throw e;
  };
  const res = resolvePathForPolicy("docs/x.md", { repoRoot: "/repo", realpath: boom });
  assert.ok(res.refuse, "an unreadable target is a refusal, not a pass");

  // A MISSING target is ordinary -- a patch that creates a file has no target.
  const missing = () => {
    const e = new Error("ENOENT");
    e.code = "ENOENT";
    throw e;
  };
  const ok = resolvePathForPolicy("docs/new.md", { repoRoot: "/repo", realpath: missing });
  assert.equal(ok.refuse, undefined);
  assert.ok(ok.candidates.includes("docs/new.md"));
});

test("rc.9: a newline or NUL in a path is refused", () => {
  assert.ok(resolvePathForPolicy("README.md\n.env").refuse);
  assert.ok(resolvePathForPolicy("README.md\0.env").refuse);
});

test("rc.9: the matcher names the rule that fired", () => {
  assert.equal(denylistRuleFor("/repo/.env.production", DENY), ".env.*");
  assert.equal(denylistRuleFor("deep/nested/id_rsa", DENY), "id_rsa");
  assert.equal(denylistRuleFor("docs/README.md", DENY), null);
  // The boolean wrapper must stay exactly equivalent.
  for (const p of ["/repo/.env.production", "deep/nested/id_rsa", "docs/README.md", ".secrets/x"]) {
    assert.equal(pathMatchesDenylist(p, DENY), denylistRuleFor(p, DENY) !== null, p);
  }
});

/* ------------------------------------------------------------------ *
 * 14. Nothing secret reaches a diagnostic
 * ------------------------------------------------------------------ */

test("rc.9: the secret scan reports the shape and never the value", () => {
  const lines = [
    `+GITHUB_TOKEN=${FAKE.github}`,
    `+AUTHORIZATION=${FAKE.bearer}`,
    `+PRIVATE=${FAKE.pem}`,
    `+OPAQUE_VALUE=${FAKE.opaque}`,
  ];
  for (const line of lines) {
    const scan = scanPatchForSecrets(`*** Begin Patch\n*** Update File: .env.example\n${line}\n*** End Patch`);
    assert.equal(scan.found, true, `should flag: ${line.slice(0, 24)}...`);
    const value = line.split("=").slice(1).join("=");
    assert.ok(!scan.detail.includes(value), `detail must not echo the value: ${scan.detail}`);
  }
});

test("rc.9: only ADDED lines count as introducing a secret", () => {
  // A context line already in the file is not this edit's doing, and scanning
  // it would refuse every future edit to a file that has a placeholder in it.
  const context = `*** Begin Patch\n*** Update File: .env.example\n TOKEN=${FAKE.github}\n*** End Patch`;
  assert.equal(scanPatchForSecrets(context).found, false);
  assert.equal(scanPatchForSecrets("").found, false);
});

test("rc.9: the secret shapes are not a second copy of the redaction list", () => {
  // One list, or the two drift and the drift is silent in the permissive
  // direction. path-policy must reuse the interaction log's redactor.
  assert.match(S("src/safety/path-policy.ts"), /redactTokenShapes/);
});
