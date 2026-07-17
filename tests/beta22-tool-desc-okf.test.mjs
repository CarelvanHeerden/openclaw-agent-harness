/**
 * beta.22: tool description regression guards.
 *
 * Option A of the OKF auto-forward story (beta.23 will add Option B, a
 * deterministic hook). Beta.21 wired the plumbing; beta.22 teaches the
 * calling OpenClaw agent to actually forward OKF blocks by making the
 * instruction part of the `harness_run` / `harness_start_session` tool
 * descriptions.
 *
 * These tests guard the source string so a future refactor can't silently
 * drop the guidance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const registrationSourcePath = resolve(here, "..", "src", "tools", "registration.ts");
const source = readFileSync(registrationSourcePath, "utf8");

test("beta.22: harness_run description includes REQUIRED WHEN OKF CONTEXT header", () => {
  assert.ok(
    source.includes("REQUIRED WHEN OKF CONTEXT IS PRESENT"),
    "harness_run description must instruct the calling agent to forward OKF blocks",
  );
});

test("beta.22: harness_run description explains the id/path/summary/tags/content mapping", () => {
  assert.ok(/`id`: the block's `ID:` value/.test(source), "must map ID field");
  assert.ok(/`path`: if the block references a file in the target repo/.test(source), "must map path field");
  assert.ok(/`summary`: the block's one-line description/.test(source), "must map summary field");
  assert.ok(/`tags`: the block's `Tags:` list, verbatim/.test(source), "must map tags field");
  assert.ok(/`content`: OPTIONAL/.test(source), "must document content field as optional");
});

test("beta.22: harness_run description forbids inventing concept ids", () => {
  assert.ok(
    /Do NOT invent concept ids/.test(source),
    "description must forbid inventing concept ids the OKF context did not surface",
  );
});

test("beta.22: harness_run description says NOT to pass empty relevantConcepts array", () => {
  assert.ok(
    /Do not pass an empty array/.test(source),
    "description must say omit relevantConcepts entirely rather than passing []",
  );
});

test("beta.22: harness_start_session description includes matching OKF forwarding rule", () => {
  // Sanity: not just harness_run, both structured entry points teach the
  // same rule so the agent's habit is consistent regardless of which tool
  // it picks.
  const startSection = source.slice(source.indexOf('name: "harness_start_session"'));
  assert.ok(
    startSection.indexOf("OKF forwarding") >= 0 && startSection.indexOf("OKF forwarding") < 2000,
    "harness_start_session description must also include an OKF forwarding rule (within first 2K chars of its block)",
  );
});
