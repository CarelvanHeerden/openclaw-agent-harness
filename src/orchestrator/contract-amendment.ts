import { createHash, randomUUID } from "node:crypto";
import type { LeadPlan, LeadPlanSubTask, SubTaskVerify } from "./lead.js";

export const CONTRACT_AMENDMENT_VERSION = "contract-amendment/2026-09-rc.11";

export interface ArtifactSubstitution {
  oldPath: string;
  newPaths: string[];
  prohibitionText?: string;
}

export interface ContractAmendment {
  id: string;
  version: string;
  basePlanHash: string;
  baseTaskHash: string;
  originalTask: LeadPlanSubTask;
  revisedTask: LeadPlanSubTask;
  substitution: ArtifactSubstitution;
  changedFields: string[];
}

export type ContractAmendmentResult =
  | { ok: true; amendment: ContractAmendment }
  | { ok: false; reason: string; proposedDiff?: string };

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

function pathTokens(text: string): string[] {
  const tokens = text.match(/(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|mjs|json|ya?ml|sql|txt))(?:$|[\s`'",).;])/g) ?? [];
  return unique(tokens.map((token) => token.trim().replace(/^[`'"(]+|[`'",).;]+$/g, "")));
}

function canonicalArtifactLabel(path: string): string | undefined {
  if (path === ".env.example") return "environment example";
  const base = path.split("/").pop() ?? path;
  const stem = base.replace(/^\./, "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return stem || undefined;
}

function artifactMentioned(text: string, path: string): boolean {
  if (text.includes(path)) return true;
  const label = canonicalArtifactLabel(path);
  return !!label && new RegExp(`\\b(?:the\\s+)?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function directiveFragments(text: string): string[] {
  const fragments: string[] = [];
  let start = 0;
  let closingQuote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!closingQuote && (char === '"' || char === "“")) {
      closingQuote = char === "“" ? "”" : '"';
      continue;
    }
    if (closingQuote && char === closingQuote && text[i - 1] !== "\\") {
      closingQuote = undefined;
      continue;
    }
    if (closingQuote) continue;
    const newline = char === "\n" || char === "\r";
    const sentenceEnd = /[.!?;]/.test(char) && (i === text.length - 1 || /\s/.test(text[i + 1]!));
    if (!newline && !sentenceEnd) continue;
    const end = newline ? i : i + 1;
    const fragment = text.slice(start, end).trim();
    if (fragment) fragments.push(fragment);
    while (i + 1 < text.length && /\s/.test(text[i + 1]!)) i++;
    start = i + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) fragments.push(tail);
  return fragments;
}

type DirectivePolarity = "affirmative" | "prohibition" | "provenance" | "neutral";

function directivePolarity(text: string, oldPath: string): DirectivePolarity {
  if (!artifactMentioned(text, oldPath) && pathTokens(text).length === 0) return "neutral";
  if (/\b(?:previous|prior|historical|original)\b[^.!?;]{0,100}\b(?:plan|answer|proposal|instruction|contract|said|stated|quoted)\b/i.test(text)) {
    return "provenance";
  }
  const prohibition = /\b(?:do\s+not|don't|never|without|avoid|must\s+not|may\s+not|shall\s+not|no\s+(?:read|write|access|replacement))\b/i.exec(text);
  if (prohibition) {
    const literalAt = text.indexOf(oldPath);
    if (!/^without$/i.test(prohibition[0]) || literalAt < 0 || prohibition.index < literalAt) {
      return "prohibition";
    }
  }
  if (/\b(?:instead|replace|substitut|use|document|move)\b/i.test(text)) return "affirmative";
  return "neutral";
}

function isConditionalSubstitution(text: string, oldPath: string): boolean {
  if (!artifactMentioned(text, oldPath) || !/\b(?:replace|substitut|instead\s+of|move)\b/i.test(text)) return false;
  return /\b(?:if|unless|when|pending|subject\s+to)\b|\b(?:once|after)\b[^.!?;]{0,80}\bapprov|\blater\b/i.test(text);
}

function globalAuthorizationGate(text: string): string | undefined {
  if (
    /\b(?:do\s+not|don't|must\s+not|may\s+not|shall\s+not)\s+(?:proceed|execute|apply|activate|implement|start|continue)\b/i.test(text) ||
    /\b(?:await|wait|hold|pause)\b[^.!?;]{0,120}\b(?:approv|confirmation|confirm)\w*\b/i.test(text) ||
    /\b(?:proposal|draft|suggestion|example)\s+only\b/i.test(text) ||
    /\bnot\s+(?:an?\s+)?(?:authorization|approval|permission)\b/i.test(text) ||
    /\buntil\b[^.!?;]{0,120}\b(?:approv|confirmation|confirm)\w*\b/i.test(text) ||
    /\b(?:keep|leave)\s+(?:the\s+)?(?:session|run|task|work)\s+(?:paused|stopped|on\s+hold)\b/i.test(text)
  ) {
    return "the answer globally withholds execution or requires separate approval/confirmation";
  }
  return undefined;
}

function withoutTerminalPunctuation(text: string): string {
  return text.trim().replace(/[.!?;]+$/, "").trim();
}

function parsePathList(text: string): string[] | undefined {
  let remainder = withoutTerminalPunctuation(text)
    .replace(/^(?:the\s+following\s+)?/i, "")
    .replace(/\s+instead$/i, "")
    .replace(/[`'"]/g, "");
  const paths = pathTokens(` ${remainder} `);
  if (paths.length === 0) return undefined;
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    remainder = remainder.replace(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ");
  }
  return /^(?:\s|,|\band\b)*$/i.test(remainder) ? paths : undefined;
}

function artifactReferenceIsComplete(text: string, path: string): boolean {
  const reference = withoutTerminalPunctuation(text).replace(/[`'"]/g, "").trim();
  if (reference === path) return true;
  const label = canonicalArtifactLabel(path);
  return !!label && new RegExp(`^(?:the\\s+)?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i").test(reference);
}

interface ParsedAffirmativeInstruction {
  kind: "substitution" | "documentation" | "contract_update";
  sourcePath?: string;
  destinationPaths: string[];
}

function parseAffirmativeFragment(text: string, oldPath: string): ParsedAffirmativeInstruction | undefined {
  const clause = withoutTerminalPunctuation(text).replace(/^please\s+/i, "");
  const escapedOldPath = oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let match = clause.match(/^(?:actually,\s*)?(?:replace|substitute)\s+(.+?)\s+(?:with|using)\s+(.+)$/i);
  if (match) {
    const destinationPaths = parsePathList(match[2]!);
    if (!artifactReferenceIsComplete(match[1]!, oldPath) || !destinationPaths) return undefined;
    return { kind: "substitution", sourcePath: oldPath, destinationPaths };
  }

  match = clause.match(/^use\s+(.+?)\s+instead\s+of\s+(.+)$/i);
  if (match) {
    const destinationPaths = parsePathList(match[1]!);
    if (!destinationPaths || !artifactReferenceIsComplete(match[2]!, oldPath)) return undefined;
    return { kind: "substitution", sourcePath: oldPath, destinationPaths };
  }

  match = clause.match(/^move\s+(.+?)\s+to\s+(.+)$/i);
  if (match) {
    const destinationPaths = parsePathList(match[2]!);
    if (!artifactReferenceIsComplete(match[1]!, oldPath) || !destinationPaths) return undefined;
    return { kind: "substitution", sourcePath: oldPath, destinationPaths };
  }

  match = clause.match(
    /^document\s+(?:placeholders?|placeholder\s+examples|(?:all\s+)?(?:new|required)\s+variables\s+and\s+placeholder\s+examples)\s+in\s+(.+?)(?:\s+instead)?$/i,
  );
  if (match) {
    const destinationPaths = parsePathList(match[1]!);
    if (!destinationPaths) return undefined;
    return { kind: "documentation", destinationPaths };
  }

  const contractUpdate = new RegExp(
    `^update\\s+the\\s+sub-task(?:['’]s)?\\s+expected\\s+paths\\s+and\\s+verification\\s+contract\\s+to\\s+replace\\s+${escapedOldPath}\\s+with\\s+those\\s+documentation\\s+files$`,
    "i",
  );
  if (contractUpdate.test(clause)) {
    return { kind: "contract_update", sourcePath: oldPath, destinationPaths: [] };
  }
  return undefined;
}

function restrictedArtifactObjectIsComplete(text: string, oldPath: string): boolean {
  let remainder = withoutTerminalPunctuation(text).replace(/[`'"]/g, "");
  const paths = pathTokens(` ${remainder} `).sort((a, b) => b.length - a.length);
  for (const path of paths) {
    remainder = remainder.replace(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ");
  }
  remainder = remainder.replace(new RegExp(oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ");
  remainder = remainder.replace(/\.env(?:\.example|\.\*)?/g, " ");
  return /^(?:\s|,|\b(?:and|or|with|to|files?|including|the|all|any)\b)*$/i.test(remainder);
}

function supportedProhibitionFragment(text: string, oldPath: string): boolean {
  const clause = withoutTerminalPunctuation(text);
  const direct = clause.match(
    /^(?:actually,\s*)?(?:do\s+not|don't|never|must\s+not|may\s+not|shall\s+not|avoid)\s+((?:(?:read|create|modify|write|access|use|replace|substitute|move)(?:\s*,\s*|\s+(?:and|or)\s+))*(?:read|create|modify|write|access|use|replace|substitute|move))\s+(.+)$/i,
  );
  if (direct) {
    const object = direct[2]!;
    if (!artifactMentioned(object, oldPath) && pathTokens(` ${object} `).length === 0) return false;
    return restrictedArtifactObjectIsComplete(object, oldPath);
  }
  const continuation = clause.match(
    /^continue\s+sub-task\s+\d+\s+without\s+(?:(?:reading|creating|modifying)(?:\s*,\s*|\s+(?:and|or)\s+))*(?:reading|creating|modifying)\s+(.+)$/i,
  );
  return (
    !!continuation &&
    artifactMentioned(continuation[1]!, oldPath) &&
    restrictedArtifactObjectIsComplete(continuation[1]!, oldPath)
  );
}

function provenancePrefixMatches(text: string): boolean {
  return /^(?:the\s+)?(?:previous|prior|historical|original)\s+(?:plan|answer|proposal|instruction|contract)\s+(?:said|stated|quoted)(?:\s+that)?\s+/i.test(
    text.trim(),
  );
}

interface ParsedProvenance {
  historicalText: string;
  remainder?: string;
}

function unquotedHistoricalStatementIsComplete(text: string, oldPath: string): boolean {
  const clause = withoutTerminalPunctuation(text);
  if (parseAffirmativeFragment(clause, oldPath)) return true;
  const update = clause.match(/^update\s+(.+)$/i);
  return !!update && artifactReferenceIsComplete(update[1]!, oldPath);
}

function parseProvenanceFragment(text: string, oldPath: string): ParsedProvenance | undefined {
  const clause = text.trim();
  const prefix = clause.match(
    /^(?:the\s+)?(?:previous|prior|historical|original)\s+(?:plan|answer|proposal|instruction|contract)\s+(?:said|stated|quoted)(?:\s+that)?\s+/i,
  );
  if (!prefix) return undefined;
  const body = clause.slice(prefix[0].length).trim();
  const opening = body[0];
  if (opening === '"' || opening === "“") {
    const closing = opening === "“" ? "”" : '"';
    let closeAt = -1;
    for (let i = 1; i < body.length; i++) {
      if (body[i] === closing && body[i - 1] !== "\\") {
        closeAt = i;
        break;
      }
    }
    if (closeAt < 1) return undefined;
    const historicalText = body.slice(1, closeAt).trim();
    if (!historicalText) return undefined;
    const trailing = body.slice(closeAt + 1).trim();
    if (!trailing || /^[.!?;]+$/.test(trailing)) return { historicalText };
    const remainder = trailing.match(/^,\s*(?:and|but|however|yet)\s+(.+)$/i)?.[1]?.trim();
    return remainder ? { historicalText, remainder } : undefined;
  }
  return unquotedHistoricalStatementIsComplete(body, oldPath)
    ? { historicalText: withoutTerminalPunctuation(body) }
    : undefined;
}

function supportedNeutralFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^(?:yes|confirmed|approved|okay|ok)\b[.!]?$/i.test(trimmed)) return true;
  if (
    /^(?:preserve|keep|retain)\s+(?:everything else|completed work and existing scope,\s*budget and time limits|all unrelated (?:requirements|work)|the existing (?:scope|branch|budget|time limits))[.!]?$/i.test(trimmed)
  ) return true;
  if (
    /^(?:complete|finish)\s+(?:the\s+)?[\w-]+\s+implementation\s+and\s+(?:the\s+)?required tests[.!]?$/i.test(trimmed)
  ) return true;
  return false;
}

function standaloneGlobalGateIsComplete(text: string): boolean {
  const clause = withoutTerminalPunctuation(text).replace(/^however\s+/i, "");
  return (
    /^(?:keep|leave)\s+(?:the\s+)?(?:session|run|task|work)\s+(?:paused|stopped|on\s+hold)$/i.test(clause) ||
    /^(?:await|wait\s+for)\s+my\s+(?:approval|confirmation)$/i.test(clause) ||
    /^wait\s+for\s+my\s+confirmation\s+before\s+applying\s+it$/i.test(clause) ||
    /^(?:do\s+not|don't|must\s+not|may\s+not|shall\s+not)\s+(?:proceed|execute|apply|activate|implement|start|continue)(?:\s+it)?(?:\s+until\s+I\s+(?:approve|confirm))?$/i.test(
      clause,
    ) ||
    /^(?:this\s+is\s+)?(?:a\s+)?(?:proposal|draft|suggestion|example)\s+only$/i.test(clause) ||
    /^not\s+(?:an?\s+)?(?:authorization|approval|permission)$/i.test(clause)
  );
}

function affirmativePartBeforeAttachedGate(text: string): string | undefined {
  const clause = withoutTerminalPunctuation(text);
  const match = clause.match(/^(.*?),\s*(?:and|but|however|yet)\s+(.+)$/i);
  if (!match || !standaloneGlobalGateIsComplete(match[2]!)) return undefined;
  return match[1]!.trim();
}

interface ParsedAuthorizationAnswer {
  sourcePaths: string[];
  destinationPaths: string[];
  restrictions: string[];
  unresolved: string[];
  globalGate?: string;
  conditionalSubstitution: boolean;
}

function parseAuthorizationAnswer(fragments: readonly string[], oldPath: string): ParsedAuthorizationAnswer {
  const sourcePaths: string[] = [];
  const substitutionSets: string[][] = [];
  const documentationSets: string[][] = [];
  const restrictions: string[] = [];
  const unresolved: string[] = [];
  const queue = [...fragments];
  let globalGate: string | undefined;
  let conditionalSubstitution = false;
  let contractUpdateReferencesDocumentation = false;

  while (queue.length > 0) {
    const fragment = queue.shift()!;
    if (provenancePrefixMatches(fragment)) {
      const provenance = parseProvenanceFragment(fragment, oldPath);
      if (!provenance) {
        unresolved.push(fragment);
      } else if (provenance.remainder) {
        queue.unshift(provenance.remainder);
      }
      continue;
    }
    if (isConditionalSubstitution(fragment, oldPath)) {
      conditionalSubstitution = true;
      continue;
    }
    const polarity = directivePolarity(fragment, oldPath);
    if (polarity === "affirmative") {
      const gate = globalAuthorizationGate(fragment);
      const parseText = gate ? affirmativePartBeforeAttachedGate(fragment) : fragment;
      const parsed = parseText ? parseAffirmativeFragment(parseText, oldPath) : undefined;
      if (!parsed) {
        unresolved.push(fragment);
        continue;
      }
      if (parsed.sourcePath) sourcePaths.push(parsed.sourcePath);
      if (parsed.kind === "substitution") substitutionSets.push(parsed.destinationPaths);
      if (parsed.kind === "documentation") documentationSets.push(parsed.destinationPaths);
      if (parsed.kind === "contract_update") contractUpdateReferencesDocumentation = true;
      if (gate) globalGate ??= gate;
      continue;
    }
    if (polarity === "prohibition") {
      if (supportedProhibitionFragment(fragment, oldPath)) restrictions.push(fragment.trim());
      else unresolved.push(fragment);
      continue;
    }
    const gate = globalAuthorizationGate(fragment);
    if (gate) {
      if (!standaloneGlobalGateIsComplete(fragment)) unresolved.push(fragment);
      else globalGate ??= gate;
      continue;
    }
    if (!supportedNeutralFragment(fragment)) unresolved.push(fragment);
  }

  const canonicalSet = (paths: readonly string[]) => JSON.stringify([...new Set(paths)].sort());
  const distinctSubstitutions = [...new Set(substitutionSets.map(canonicalSet))];
  if (distinctSubstitutions.length > 1) {
    unresolved.push("multiple affirmative substitutions name different replacement artifact sets");
  }
  const directDestinations = substitutionSets[0] ?? [];
  const documentationDestinations = unique(documentationSets.flat());
  let destinationPaths = unique(directDestinations);
  if (destinationPaths.length > 0) {
    const direct = new Set(destinationPaths);
    const extraDocumentation = documentationDestinations.filter((path) => !direct.has(path));
    if (extraDocumentation.length > 0) {
      unresolved.push(
        `documentation destinations are not authorized replacement outputs: ${extraDocumentation.join(", ")}`,
      );
    }
  } else if (contractUpdateReferencesDocumentation) {
    destinationPaths = documentationDestinations;
  }

  return {
    sourcePaths: unique(sourcePaths),
    destinationPaths: unique(destinationPaths),
    restrictions: unique(restrictions),
    unresolved: unique(unresolved),
    globalGate,
    conditionalSubstitution,
  };
}

function completeProposalPreview(
  amendment: ContractAmendment,
  answer: string,
  prohibitions: readonly string[],
): string {
  const proposalHash = hash(amendment);
  return JSON.stringify(
    {
      proposalVersion: "complete-task-diff/v1",
      proposalHash,
      displayDiff: {
        operation: amendment.substitution,
        changedFields: amendment.changedFields,
        restrictionsPreserved: prohibitions,
        revisedTask: amendment.revisedTask,
      },
      sourceAnswerHash: hash(answer),
      completeAmendment: amendment,
    },
    null,
    2,
  );
}

function replaceArtifactText(text: string, oldPath: string, renderedNew: string): { value: string; changed: boolean } {
  const label = canonicalArtifactLabel(oldPath);
  const value = directiveFragments(text).map((fragment) => {
    const polarity = directivePolarity(fragment, oldPath);
    if (polarity === "prohibition" || polarity === "provenance") return fragment;
    let next = fragment.split(oldPath).join(renderedNew);
    if (label) {
      next = next.replace(new RegExp(`\\b(?:the\\s+)?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), renderedNew);
    }
    return next;
  }).join(" ");
  return { value, changed: value !== text };
}

function isProhibition(text: string, path: string): boolean {
  return directiveFragments(text).some(
    (fragment) => artifactMentioned(fragment, path) && directivePolarity(fragment, path) === "prohibition",
  );
}

function taskProhibitionFields(task: LeadPlanSubTask, path: string): string[] {
  const fields: string[] = [];
  const visit = (value: unknown, field: string): void => {
    if (typeof value === "string") {
      if (isProhibition(value, path)) fields.push(field);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${field}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      visit(entry, field ? `${field}.${key}` : key);
    }
  };
  visit(task, "");
  return fields;
}

function requiredMentions(task: LeadPlanSubTask, path: string): string[] {
  const out: string[] = [];
  const visit = (value: unknown, field: string): void => {
    if (typeof value === "string") {
      if (!artifactMentioned(value, path)) return;
      const mentioned = directiveFragments(value).filter((fragment) => artifactMentioned(fragment, path));
      if (
        mentioned.length > 0 &&
        mentioned.every((fragment) => {
          const polarity = directivePolarity(fragment, path);
          return polarity === "prohibition" || polarity === "provenance";
        })
      ) return;
      out.push(field);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${field}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      visit(entry, field ? `${field}.${key}` : key);
    }
  };
  visit(task, "");
  return out;
}

function reviseVerify(
  probes: readonly SubTaskVerify[] | undefined,
  oldPath: string,
  newPaths: readonly string[],
): SubTaskVerify[] | undefined {
  if (!probes) return undefined;
  const out: SubTaskVerify[] = [];
  for (const probe of probes) {
    if ("path" in probe && probe.path === oldPath) {
      for (const path of newPaths) out.push({ ...probe, path } as SubTaskVerify);
    } else {
      out.push(structuredClone(probe));
    }
  }
  return out;
}

/**
 * Transform only an explicit one-artifact substitution.
 *
 * The operator's prose authorises the old/new artifact set. The transformer,
 * not a model, performs the change; anything outside this shape stays paused.
 */
export function buildArtifactSubstitutionAmendment(input: {
  plan: LeadPlan;
  task: LeadPlanSubTask;
  answer: string;
  blockedPaths: readonly string[];
  id?: string;
}): ContractAmendmentResult {
  const answer = input.answer.trim();
  const blocked = unique(input.blockedPaths);
  if (blocked.length !== 1) {
    return { ok: false, reason: "the clarification does not identify exactly one blocked artifact" };
  }
  const oldPath = blocked[0]!;
  if (!answer.includes(oldPath)) {
    return { ok: false, reason: `the answer does not name the blocked artifact ${oldPath}` };
  }
  const fragments = directiveFragments(answer);
  const prohibitedDestinations = new Set<string>();
  let withdrewSubstitution = false;
  const parsedAnswer = parseAuthorizationAnswer(fragments, oldPath);
  if (parsedAnswer.conditionalSubstitution) {
    return { ok: false, reason: "the replacement is conditional on future approval or another unresolved condition" };
  }
  if (parsedAnswer.unresolved.length > 0) {
    return {
      ok: false,
      reason: `the answer contains instruction(s) outside the bounded automatic-amendment grammar: ${parsedAnswer.unresolved.join(" ")}`,
    };
  }
  const globalGate = parsedAnswer.globalGate;
  const prohibitions = parsedAnswer.restrictions;
  for (const fragment of prohibitions) {
    const paths = pathTokens(fragment).filter(
      (path) => path !== oldPath && !path.startsWith(".env") && !blocked.includes(path),
    );
    if (artifactMentioned(fragment, oldPath) && /\b(?:replace|substitut|instead\s+of|move)\b/i.test(fragment)) {
      if (paths.length === 0) withdrewSubstitution = true;
      else for (const path of paths) prohibitedDestinations.add(path);
    } else {
      for (const path of paths) prohibitedDestinations.add(path);
    }
  }
  if (withdrewSubstitution) {
    return { ok: false, reason: "the answer withdraws or prohibits permission to replace the blocked artifact" };
  }
  const oldPathAuthorised = parsedAnswer.sourcePaths.includes(oldPath);
  if (!oldPathAuthorised) {
    return { ok: false, reason: "the answer does not affirmatively authorize replacing the blocked artifact" };
  }

  const rejectedOperands = parsedAnswer.destinationPaths.filter(
    (path) => path === oldPath || path.startsWith(".env") || blocked.includes(path),
  );
  if (rejectedOperands.length > 0) {
    return {
      ok: false,
      reason: `replacement operand(s) are blocked or alias the obsolete artifact: ${unique(rejectedOperands).join(", ")}`,
    };
  }
  const candidates = parsedAnswer.destinationPaths;
  const newPaths = unique(candidates);
  if (newPaths.length === 0) {
    return { ok: false, reason: "the answer names no replacement artifact path" };
  }
  const prohibitedRequired = newPaths.filter((path) => prohibitedDestinations.has(path));
  if (prohibitedRequired.length > 0) {
    return {
      ok: false,
      reason: `the answer prohibits required access to replacement artifact(s): ${prohibitedRequired.join(", ")}`,
    };
  }
  const inheritedProhibitions = newPaths.flatMap((path) =>
    taskProhibitionFields(input.task, path).map((field) => `${path} (${field})`)
  );
  if (inheritedProhibitions.length > 0) {
    return {
      ok: false,
      reason: `the stored task already prohibits required replacement artifact access: ${inheritedProhibitions.join(", ")}`,
    };
  }

  const original = structuredClone(input.task);
  const revised = structuredClone(input.task);
  const renderedNew = newPaths.join(" and ");
  const changed = new Set<string>();

  const title = replaceArtifactText(revised.title, oldPath, renderedNew);
  if (title.changed) {
    revised.title = title.value;
    changed.add("title");
  }
  revised.filesLikelyTouched = unique(
    revised.filesLikelyTouched.flatMap((path) => (path === oldPath ? newPaths : [path])),
  );
  if (input.task.filesLikelyTouched.includes(oldPath)) changed.add("filesLikelyTouched");

  const intent = replaceArtifactText(revised.intent, oldPath, renderedNew);
  if (intent.changed) {
    revised.intent = intent.value;
    changed.add("intent");
  }
  revised.successCriteria = revised.successCriteria.map((criterion, index) => {
    const next = replaceArtifactText(criterion, oldPath, renderedNew);
    if (next.changed) changed.add(`successCriteria[${index}]`);
    return next.value;
  });
  if (!revised.requiredBehaviorChecks || revised.requiredBehaviorChecks.length === 0) {
    const criteria = revised.successCriteria.join("\n");
    const checks = [];
    if (/\b(?:typecheck|tsc\b|typescript)\b/i.test(criteria)) {
      checks.push({ id: "typecheck", ciCheck: "typecheck", required: true });
    }
    if (/\b(?:security\s+tests?|focused\s+tests?|test\s+suite|tests?\s+pass)\b/i.test(criteria)) {
      checks.push({ id: "focused-security-tests", ciCheck: "test", required: true });
    }
    if (checks.length > 0) {
      revised.requiredBehaviorChecks = checks;
      changed.add("requiredBehaviorChecks");
    }
  }
  revised.verify = reviseVerify(revised.verify, oldPath, newPaths);
  if ((input.task.verify ?? []).some((probe) => "path" in probe && probe.path === oldPath)) changed.add("verify");

  if (revised.workerContext?.changeSpec) {
    const next = replaceArtifactText(revised.workerContext.changeSpec, oldPath, renderedNew);
    if (next.changed) {
      revised.workerContext.changeSpec = next.value;
      changed.add("workerContext.changeSpec");
    }
  }
  if (revised.workerContext) {
    const rationale = replaceArtifactText(revised.workerContext.rationale, oldPath, renderedNew);
    if (rationale.changed) {
      revised.workerContext.rationale = rationale.value;
      changed.add("workerContext.rationale");
    }
    revised.workerContext.gotchas = revised.workerContext.gotchas?.map((gotcha, index) => {
      const next = replaceArtifactText(gotcha, oldPath, renderedNew);
      if (next.changed) changed.add(`workerContext.gotchas[${index}]`);
      return next.value;
    });
    revised.workerContext.relatedSymbols = revised.workerContext.relatedSymbols?.map((symbol, index) => {
      const next = replaceArtifactText(symbol, oldPath, renderedNew);
      if (next.changed) changed.add(`workerContext.relatedSymbols[${index}]`);
      return next.value;
    });
    revised.workerContext.codeExcerpts = revised.workerContext.codeExcerpts?.map((excerpt, index) => {
      if (!excerpt.note) return excerpt;
      const next = replaceArtifactText(excerpt.note, oldPath, renderedNew);
      if (!next.changed) return excerpt;
      changed.add(`workerContext.codeExcerpts[${index}].note`);
      return { ...excerpt, note: next.value };
    });
  }

  if (prohibitions.length > 0) {
    const context = revised.workerContext ?? { rationale: original.workerContext?.rationale ?? "Operator-scoped task amendment." };
    context.gotchas = unique([...(context.gotchas ?? []), ...prohibitions.map((fragment) => fragment.trim())]);
    revised.workerContext = context;
    changed.add("workerContext.gotchas");
  }

  const remaining = requiredMentions(revised, oldPath);
  if (remaining.length > 0) {
    return {
      ok: false,
      reason: `the obsolete artifact remains a positive obligation in ${remaining.join(", ")}`,
      proposedDiff: JSON.stringify({ original, revised }, null, 2),
    };
  }
  for (const path of newPaths) {
    if (!revised.filesLikelyTouched.includes(path)) {
      return { ok: false, reason: `replacement ${path} is absent from task scope` };
    }
    if (!(revised.verify ?? []).some((probe) => "path" in probe && probe.path === path)) {
      return { ok: false, reason: `replacement ${path} is absent from task verification` };
    }
  }

  if (
    revised.seq !== original.seq ||
    revised.estimatedTokens !== original.estimatedTokens ||
    JSON.stringify(revised.dependsOn ?? []) !== JSON.stringify(original.dependsOn ?? []) ||
    revised.taskMode !== original.taskMode ||
    revised.contractScope !== original.contractScope ||
    JSON.stringify(revised.coFixGrantedFiles ?? []) !== JSON.stringify(original.coFixGrantedFiles ?? [])
  ) {
    return { ok: false, reason: "the amendment changed an immutable task field" };
  }

  const amendment: ContractAmendment = {
    id: input.id ?? randomUUID(),
    version: CONTRACT_AMENDMENT_VERSION,
    basePlanHash: hash(input.plan),
    baseTaskHash: hash(original),
    originalTask: original,
    revisedTask: revised,
    substitution: { oldPath, newPaths, prohibitionText: prohibitions.join(" ").trim() || undefined },
    changedFields: [...changed],
  };
  if (globalGate) {
    return {
      ok: false,
      reason: globalGate,
      proposedDiff: completeProposalPreview(amendment, answer, prohibitions),
    };
  }
  return { ok: true, amendment };
}

export function activateTaskAmendment(plan: LeadPlan, amendment: ContractAmendment): LeadPlan {
  if (hash(plan) !== amendment.basePlanHash) throw new Error("stored plan changed after the amendment was proposed");
  const at = plan.subTasks.findIndex((task) => task.seq === amendment.originalTask.seq);
  if (at < 0) throw new Error(`sub-task ${amendment.originalTask.seq} no longer exists`);
  if (hash(plan.subTasks[at]) !== amendment.baseTaskHash) throw new Error("stored task changed after the amendment was proposed");
  const revised = structuredClone(plan);
  revised.subTasks[at] = structuredClone(amendment.revisedTask);
  return revised;
}

export function planHash(plan: LeadPlan): string {
  return hash(plan);
}
