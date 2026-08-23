// A semicolon inside a Mermaid line ends the statement.
//
// rc.2 rewrote the sequence diagram's intake step to say the quiet part out loud:
//
//   Slack->>Agent: message (the agent is subscribed; the harness is not)
//
// Mermaid reads `;` as a statement separator, so the message ends at
// "subscribed", and "the harness is not)" becomes a statement of its own that
// parses as nothing. GitHub renders the whole block as "Unable to render rich
// display — Parse error on line 16". The diagram was correct and unreadable.
//
// It shipped because nothing looks at the diagrams. Every other claim in
// ARCHITECTURE.md now has a test behind it, but a fenced ```mermaid block is
// just text to this suite, and the failure only appears on github.com.
//
// Parsing properly would mean pulling in mermaid and a DOM to run it in, which
// is a lot of dependency for one document in a repo that deliberately has almost
// none. So this checks the hazard that actually bit, cheaply: no `;` inside a
// Mermaid block. We never need one — newlines separate statements — and its only
// effect is to truncate a label silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function markdownFiles() {
  const docs = readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f));
  return ["README.md", ...docs];
}

/** Fenced ```mermaid blocks, with the line number each starts on. */
function mermaidBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  let start = -1;
  let body = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (start === -1 && /^\s*```mermaid\s*$/.test(line)) {
      start = i + 1;
      body = [];
    } else if (start !== -1 && /^\s*```\s*$/.test(line)) {
      blocks.push({ startLine: start, lines: body });
      start = -1;
    } else if (start !== -1) {
      body.push({ n: i + 1, text: line });
    }
  }
  return blocks;
}

test("no Mermaid block contains a semicolon", () => {
  const offenders = [];
  for (const rel of markdownFiles()) {
    const source = readFileSync(join(root, rel), "utf8");
    for (const block of mermaidBlocks(source)) {
      for (const { n, text } of block.lines) {
        if (text.includes(";")) offenders.push(`${rel}:${n}: ${text.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Mermaid treats ';' as a statement separator, so it silently truncates the label " +
      "and GitHub then fails to render the whole diagram. Use a comma or an em dash:\n" +
      offenders.join("\n"),
  );
});

test("every Mermaid block declares a diagram type on its first line", () => {
  const known = /^(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/;
  const offenders = [];
  for (const rel of markdownFiles()) {
    const source = readFileSync(join(root, rel), "utf8");
    for (const block of mermaidBlocks(source)) {
      const first = block.lines.find((l) => l.text.trim() !== "");
      if (!first || !known.test(first.text.trim())) {
        offenders.push(`${rel}:${block.startLine}: starts with ${JSON.stringify(first?.text ?? "")}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Mermaid blocks must open with a diagram type:\n${offenders.join("\n")}`);
});

test("the diagrams this repo actually ships are found and checked", () => {
  const arch = readFileSync(join(root, "docs", "ARCHITECTURE.md"), "utf8");
  const blocks = mermaidBlocks(arch);
  assert.equal(blocks.length, 3, "ARCHITECTURE.md should carry the component, sequence and state diagrams");
  const kinds = blocks.map((b) => b.lines.find((l) => l.text.trim() !== "").text.trim().split(/\s/)[0]);
  assert.deepEqual(kinds, ["flowchart", "sequenceDiagram", "stateDiagram-v2"]);
});
