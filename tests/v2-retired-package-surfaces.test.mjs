import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const retiredModules = [
  "orchestrator/budget-extension",
  "orchestrator/time-extension",
  "slack/channel-listener",
  "slack/dispatcher",
  "hooks/okf-auto-forward",
];
const retiredPackagePatterns = [
  /\breactions_json\b/g,
  /\bcancelSession\b/g,
  /\bshipIt\b/g,
  /\bbudgetBump\b/g,
  /harness_run/g,
  /harness_start_session/g,
  /harness_merge_pr/g,
  /harness_cancel/g,
  /harness_onboard/g,
  /harness_health/g,
  /harness_logs/g,
  /harness_status/g,
  /harness_progress/g,
  /harness_session_get/g,
  /harness_telemetry/g,
  /harness_upload_logs/g,
  /harness_resume/g,
  /harness_answer/g,
  /harness_retention_prune/g,
  /harness_list_revisable/g,
  /harness_revise/g,
  /harness_link_pr/g,
  /listener_enabled/g,
  /readReactions/g,
  /:moneybag:/g,
  /:rocket:/g,
  /\bbudget_bump\b/g,
  /\bship_it\b/g,
  /user_abort_reaction/g,
  /user_ship_it_reaction/g,
  /reaction_added/g,
  /reaction_removed/g,
  /reactions:(?:read|write)/g,
  /slash_commands/g,
  /\/harness-(?:onboard|run|start|merge)\b/g,
  /registerCommand\s*[?(:]/g,
  /confirming emoji/gi,
  /pauses? for an operator decision/gi,
  /offers? a resumable continue-watching/gi,
  /pause for an operator to confirm/gi,
  /hard `?clarify`? pause-and-wait/gi,
];

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

test("retired interactive modules are absent from source and built output", () => {
  for (const module of retiredModules) {
    assert.equal(existsSync(resolve(root, `src/${module}.ts`)), false, `src/${module}.ts`);
    assert.equal(existsSync(resolve(root, `dist/${module}.js`)), false, `dist/${module}.js`);
    assert.equal(existsSync(resolve(root, `dist/${module}.d.ts`)), false, `dist/${module}.d.ts`);
  }
});

test("the exact packed artifact has only the four ordinary operations and no retired interaction surface", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "oah-packed-surface-"));
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", root, "--json", "--pack-destination", temp], {
      cwd: temp,
      encoding: "utf8",
    }));
    const artifact = packed[0] ?? Object.values(packed)[0];
    const tarball = join(temp, artifact.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", temp]);
    const packageRoot = join(temp, "package");
    const files = filesUnder(packageRoot);
    assert.equal(
      files.some((path) => path.slice(packageRoot.length + 1).startsWith("node_modules/@anthropic-ai/claude-agent-sdk-")),
      false,
      "platform-specific Claude binaries must be installed for the consumer platform, not bundled into the artifact",
    );
    const leaks = [];
    for (const path of files) {
      const relative = path.slice(packageRoot.length + 1);
      // Third-party bundled dependencies are audited as dependencies, not as
      // first-party product surface. Their protocol/type vocabulary does not
      // register or document an ordinary harness operation.
      if (relative.startsWith("node_modules/")) continue;
      const bytes = readFileSync(path);
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      for (const pattern of retiredPackagePatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) leaks.push(`${relative}: ${pattern}`);
      }
    }
    assert.deepEqual(leaks, []);

    const legacyLoop = readFileSync(join(packageRoot, "dist/orchestrator/legacy-loop.js"), "utf8");
    assert.match(
      legacyLoop,
      /confirmedControlGuards\.has\(sessionId\)[\s\S]{0,800}UPDATE sessions SET status='failed'[\s\S]{0,800}exhausted autonomous clarification handling/,
      "the packaged loop must terminalize before creating or delivering a historical clarification state",
    );
    assert.match(
      legacyLoop,
      /outcome\.status !== "awaiting_clarification"[\s\S]{0,1000}UPDATE sessions SET status='failed'/,
      "the packaged confirmed-control entry point must retain a second terminalization guard",
    );

    const registration = readFileSync(join(packageRoot, "dist/tools/registration.js"), "utf8");
    const names = [...registration.matchAll(/"(harness_[a-z_]+)"/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(names)].sort(), [
      "harness_change_result",
      "harness_confirm_change",
      "harness_merge_change",
      "harness_prepare_change",
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("public config and Slack deployment expose only outbound control-plane settings", () => {
  const schema = JSON.parse(read("src/config.schema.json"));
  const manifest = JSON.parse(read("openclaw.plugin.json")).configSchema;
  const goneLoop = [
    "time_extension_ask_enabled",
    "time_extension_wait_seconds",
    "time_extension_default_seconds",
    "budget_extension_ask_enabled",
    "budget_extension_wait_seconds",
  ];
  for (const publicSchema of [schema, manifest]) {
    assert.equal(publicSchema.properties.slack.properties.listener_enabled, undefined);
    assert.equal(publicSchema.properties.slack.properties.reactions, undefined);
    for (const key of goneLoop) assert.equal(publicSchema.properties.loop.properties[key], undefined, key);
  }
  const slackManifest = read("deploy/slack-app-manifest.yaml");
  assert.doesNotMatch(slackManifest, /listener|reaction|slash|interactiv/i);
  assert.match(slackManifest, /chat:write/);
});

test("the manifest config schema is generated from the canonical schema without semantic drift", () => {
  const schema = JSON.parse(read("src/config.schema.json"));
  const manifest = JSON.parse(read("openclaw.plugin.json"));
  assert.deepEqual(manifest.configSchema, schema);
});

test("control-plane documentation matches the v2 running response", () => {
  const doc = read("docs/CONTROL-PLANE.md");
  assert.match(doc, /control-plane-confirm\/v2/);
  assert.match(doc, /"state": "running"/);
  assert.match(doc, /"summary": "Change confirmed and running autonomously\."/);
  assert.doesNotMatch(doc, /`accepted`/);
});
