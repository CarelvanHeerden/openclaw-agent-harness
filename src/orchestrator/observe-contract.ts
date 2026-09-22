import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  LeadPlan,
  LeadPlanSubTask,
  ObserveBindingSpec,
  ObserveBindingType,
  ObserveContract,
  ObserveContractPatch,
} from "./lead.js";

export interface ObserveEvidenceRef {
  path?: string;
  line?: number;
  note?: string;
}

export interface ObserveFinding {
  id: string;
  summary: string;
  evidence: ObserveEvidenceRef[];
}

export interface ObserveBindingResult {
  name: string;
  type: ObserveBindingType;
  value: unknown;
  evidence: ObserveEvidenceRef[];
}

export interface StructuredObserveResult {
  status: "ok" | "blocked";
  findings: ObserveFinding[];
  bindings: ObserveBindingResult[];
  blockers?: string[];
}

export type ObserveValidation =
  | { ok: true; kind: "satisfied"; result: StructuredObserveResult; bindingsHash: string }
  | {
      ok: false;
      kind: "blocked";
      reason: string;
      result: StructuredObserveResult;
      bindingsHash: string;
      missingRequired: { findings: string[]; bindings: string[] };
    }
  | { ok: false; kind: "invalid_format" | "invalid_schema" | "invalid_evidence"; reason: string };

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requiredFindingId(spec: string): string {
  return spec.split(":", 1)[0]!.trim();
}

export function parseObserveEnvelope(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const canonical = /^OBSERVE_RESULT\s*:?\s*```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
  if (canonical) return JSON.parse(canonical[1]!);
  const labelledFence = /^```OBSERVE_RESULT\s*([\s\S]*?)```\s*$/i.exec(trimmed);
  if (labelledFence) return JSON.parse(labelledFence[1]!);
  throw new Error("missing OBSERVE_RESULT JSON envelope");
}

export function renderObserveContractInstructions(contract: ObserveContract): string {
  return [
    "## Structured observe deliverable (REQUIRED)",
    "Return exactly one complete result using this canonical wrapper (the colon and closing fence are required):",
    "OBSERVE_RESULT:",
    "```json",
    '{"status":"ok|blocked","findings":[{"id":"...","summary":"...","evidence":[{"path":"...","line":1}]}],"bindings":[{"name":"...","type":"...","value":"...","evidence":[{"path":"..."}]}],"blockers":[]}',
    "```",
    `Required finding ids: ${contract.requiredFindings.map(requiredFindingId).join(", ") || "(none)"}`,
    `Required bindings: ${contract.bindings.map((binding) => `${binding.name}:${binding.type}`).join(", ") || "(none)"}`,
    "Use status=blocked only for a genuine unresolved authority, environment, or contract decision. Implementation work already required by the task is a finding/binding, not an operator blocker.",
    "A promise to inspect, a tool-call count, or prose outside the single wrapper is not a finding and will not release dependent work.",
  ].join("\n");
}

function isEvidenceRef(value: unknown): value is ObserveEvidenceRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as ObserveEvidenceRef;
  return typeof ref.path === "string" || typeof ref.note === "string";
}

function bindingPath(binding: ObserveBindingResult): string | undefined {
  if (typeof binding.value === "string") return binding.value.trim() || undefined;
  if (binding.value && typeof binding.value === "object") {
    const path = (binding.value as { path?: unknown }).path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return undefined;
}

function contractPatch(binding: ObserveBindingResult): ObserveContractPatch | undefined {
  if (!binding.value || typeof binding.value !== "object" || Array.isArray(binding.value)) return undefined;
  const value = binding.value as Record<string, unknown>;
  const allowed = new Set([
    "filesLikelyTouched",
    "verify",
    "intent",
    "successCriteria",
    "workerContextChangeSpec",
    "requiredBehaviorChecks",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    value.filesLikelyTouched !== undefined &&
    (!Array.isArray(value.filesLikelyTouched) || !value.filesLikelyTouched.every((path) => typeof path === "string" && path.trim()))
  ) return undefined;
  if (
    value.verify !== undefined &&
    (!Array.isArray(value.verify) || !value.verify.every((probe) => probe && typeof probe === "object" && typeof (probe as { kind?: unknown }).kind === "string"))
  ) return undefined;
  if (value.intent !== undefined && typeof value.intent !== "string") return undefined;
  if (
    value.successCriteria !== undefined &&
    (!Array.isArray(value.successCriteria) || !value.successCriteria.every((criterion) => typeof criterion === "string" && criterion.trim()))
  ) return undefined;
  if (value.workerContextChangeSpec !== undefined && typeof value.workerContextChangeSpec !== "string") return undefined;
  if (
    value.requiredBehaviorChecks !== undefined &&
    (!Array.isArray(value.requiredBehaviorChecks) ||
      !value.requiredBehaviorChecks.every((check) =>
        check &&
        typeof check === "object" &&
        typeof (check as { id?: unknown }).id === "string" &&
        typeof (check as { ciCheck?: unknown }).ciCheck === "string"
      ))
  ) return undefined;
  return value as ObserveContractPatch;
}

function pathExists(repoFiles: ReadonlySet<string>, path: string): boolean {
  return repoFiles.has(path.replace(/^\.\//, ""));
}

function repoEntryExists(repoFiles: ReadonlySet<string>, path: string): boolean {
  const normalized = path.replace(/^\.\//, "").replace(/\/+$/, "");
  return repoFiles.has(normalized) || [...repoFiles].some((file) => file.startsWith(`${normalized}/`));
}

function parentExists(repoFiles: ReadonlySet<string>, path: string): boolean {
  let parent = posix.dirname(path.replace(/^\.\//, ""));
  if (parent === ".") return true;
  while (parent !== "." && parent !== "/") {
    const prefix = `${parent}/`;
    if ([...repoFiles].some((file) => file.startsWith(prefix))) return true;
    parent = posix.dirname(parent);
  }
  return false;
}

export function validateObserveResult(input: {
  finalMessage?: string;
  contract: ObserveContract;
  repoFiles: readonly string[];
  readRepoFile?: (path: string) => string | undefined;
}): ObserveValidation {
  let raw: unknown;
  try {
    raw = parseObserveEnvelope(input.finalMessage ?? "");
  } catch (err) {
    return { ok: false, kind: "invalid_format", reason: `observe deliverable is not valid structured JSON: ${String(err)}` };
  }
  if (!raw || typeof raw !== "object") return { ok: false, kind: "invalid_schema", reason: "observe result must be an object" };
  const result = raw as StructuredObserveResult;
  if (result.status !== "ok" && result.status !== "blocked") {
    return { ok: false, kind: "invalid_schema", reason: "observe result status must be ok or blocked" };
  }
  if (!Array.isArray(result.findings) || !Array.isArray(result.bindings)) {
    return { ok: false, kind: "invalid_schema", reason: "observe result must contain findings and bindings arrays" };
  }
  const findings = new Map<string, ObserveFinding>();
  const repoFiles = new Set(input.repoFiles.map((path) => path.replace(/^\.\//, "")));
  const validEvidencePath = (ref: ObserveEvidenceRef): boolean => {
    if (typeof ref.path !== "string") return false;
    const path = ref.path.replace(/^\.\//, "");
    if (!repoEntryExists(repoFiles, path)) return false;
    return ref.line === undefined || (Number.isInteger(ref.line) && ref.line > 0);
  };
  for (const finding of result.findings) {
    if (!finding || typeof finding.id !== "string" || typeof finding.summary !== "string" || !finding.summary.trim()) {
      return { ok: false, kind: "invalid_schema", reason: "every observe finding needs a stable id and non-empty summary" };
    }
    if (!Array.isArray(finding.evidence) || !finding.evidence.every(isEvidenceRef)) {
      return { ok: false, kind: "invalid_schema", reason: `finding ${finding.id} has invalid evidence references` };
    }
    if (input.contract.requireEvidence !== false && finding.evidence.length === 0) {
      return { ok: false, kind: "invalid_evidence", reason: `finding ${finding.id} has no evidence` };
    }
    if (input.contract.requireEvidence !== false && !finding.evidence.some(validEvidencePath)) {
      return { ok: false, kind: "invalid_evidence", reason: `finding ${finding.id} has no repository-backed evidence` };
    }
    if (finding.evidence.some((ref) => ref.path !== undefined && !validEvidencePath(ref))) {
      return { ok: false, kind: "invalid_evidence", reason: `finding ${finding.id} references missing or invalid repository evidence` };
    }
    findings.set(finding.id, finding);
  }
  if (result.status === "blocked") {
    const blockers = Array.isArray(result.blockers)
      ? result.blockers.filter((blocker): blocker is string => typeof blocker === "string" && blocker.trim().length > 0)
      : [];
    if (blockers.length === 0) {
      return { ok: false, kind: "invalid_schema", reason: "blocked observe result must name at least one blocker" };
    }
    for (const binding of result.bindings) {
      if (
        !binding ||
        typeof binding.name !== "string" ||
        typeof binding.type !== "string" ||
        !Array.isArray(binding.evidence) ||
        !binding.evidence.every(isEvidenceRef)
      ) {
        return { ok: false, kind: "invalid_schema", reason: "blocked observe result contains a malformed binding" };
      }
      if (binding.evidence.some((ref) => ref.path !== undefined && !validEvidencePath(ref))) {
        return { ok: false, kind: "invalid_evidence", reason: `blocked binding ${binding.name} references missing repository evidence` };
      }
    }
    return {
      ok: false,
      kind: "blocked",
      reason: `observe result is blocked and cannot release dependents: ${blockers.join("; ")}`,
      result,
      bindingsHash: hash(result.bindings),
      missingRequired: {
        findings: input.contract.requiredFindings
          .map(requiredFindingId)
          .filter((id) => !findings.has(id)),
        bindings: input.contract.bindings
          .filter((spec) => spec.required !== false && !result.bindings.some((binding) => binding.name === spec.name))
          .map((spec) => spec.name),
      },
    };
  }
  for (const spec of input.contract.requiredFindings) {
    const id = requiredFindingId(spec);
    if (!findings.has(id)) return { ok: false, kind: "invalid_schema", reason: `required finding ${id} is missing` };
  }

  const supplied = new Map(result.bindings.map((binding) => [binding.name, binding]));
  for (const spec of input.contract.bindings) {
    const binding = supplied.get(spec.name);
    if (!binding) {
      if (spec.required !== false) return { ok: false, kind: "invalid_schema", reason: `required binding ${spec.name} is missing` };
      continue;
    }
    if (binding.type !== spec.type) {
      return { ok: false, kind: "invalid_schema", reason: `binding ${spec.name} has type ${binding.type}, expected ${spec.type}` };
    }
    if (!Array.isArray(binding.evidence) || !binding.evidence.every(isEvidenceRef)) {
      return { ok: false, kind: "invalid_schema", reason: `binding ${spec.name} has invalid evidence` };
    }
    if (binding.evidence.some((ref) => ref.path !== undefined && !validEvidencePath(ref))) {
      return { ok: false, kind: "invalid_evidence", reason: `binding ${spec.name} references missing or invalid repository evidence` };
    }
    const path = bindingPath(binding);
    switch (spec.type) {
      case "existing_repo_path":
        if (!path || !pathExists(repoFiles, path)) {
          return { ok: false, kind: "invalid_evidence", reason: `existing path binding ${spec.name} does not resolve in the repository` };
        }
        break;
      case "proposed_output_path":
        if (!path) return { ok: false, kind: "invalid_schema", reason: `proposed path binding ${spec.name} has no path` };
        if (pathExists(repoFiles, path)) {
          return { ok: false, kind: "invalid_evidence", reason: `proposed path binding ${spec.name} collides with an existing artifact` };
        }
        if (!parentExists(repoFiles, path)) {
          return { ok: false, kind: "invalid_evidence", reason: `proposed path binding ${spec.name} has no evidenced parent convention` };
        }
        if (!binding.evidence.some(validEvidencePath)) {
          return { ok: false, kind: "invalid_evidence", reason: `proposed path binding ${spec.name} has no convention evidence` };
        }
        break;
      case "contract_patch":
        if (!contractPatch(binding)) {
          return { ok: false, kind: "invalid_schema", reason: `contract patch binding ${spec.name} has an unsupported patch shape` };
        }
        if (!binding.evidence.some(validEvidencePath)) {
          return { ok: false, kind: "invalid_evidence", reason: `contract patch binding ${spec.name} has no repository-backed evidence` };
        }
        break;
      case "existing_symbol": {
        if (!path || !pathExists(repoFiles, path)) {
          return { ok: false, kind: "invalid_evidence", reason: `symbol binding ${spec.name} does not name an existing source path` };
        }
        const symbol = binding.value && typeof binding.value === "object"
          ? (binding.value as { symbol?: unknown }).symbol
          : undefined;
        if (typeof symbol !== "string" || !symbol.trim()) {
          return { ok: false, kind: "invalid_schema", reason: `symbol binding ${spec.name} has no symbol name` };
        }
        const contents = input.readRepoFile?.(path);
        const escaped = symbol.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (typeof contents !== "string" || !new RegExp(`\\b${escaped}\\b`).test(contents)) {
          return { ok: false, kind: "invalid_evidence", reason: `symbol binding ${spec.name} does not resolve in ${path}` };
        }
        break;
      }
      case "status":
      case "blocker":
        if (typeof binding.value !== "string" || !binding.value.trim()) {
          return { ok: false, kind: "invalid_schema", reason: `binding ${spec.name} must contain a non-empty string` };
        }
        break;
    }
  }
  const bindingsHash = hash(result.bindings);
  return { ok: true, kind: "satisfied", result, bindingsHash };
}

function appendBinding(text: string, name: string, value: string, placeholder?: string): string {
  if (placeholder) {
    if (!text.includes(placeholder)) throw new Error(`binding placeholder ${placeholder} is missing`);
    return text.split(placeholder).join(value);
  }
  return `${text.trim()} Bound observe result ${name}: \`${value}\`.`.trim();
}

export function applyObserveBindings(input: {
  plan: LeadPlan;
  producer: LeadPlanSubTask;
  result: StructuredObserveResult;
}): { plan: LeadPlan; changedConsumers: number[]; bindingsHash: string } {
  const contract = input.producer.observeContract;
  if (!contract) return { plan: structuredClone(input.plan), changedConsumers: [], bindingsHash: hash([]) };
  const revised = structuredClone(input.plan);
  const values = new Map(input.result.bindings.map((binding) => [binding.name, binding]));
  const changed = new Set<number>();

  for (const spec of contract.bindings) {
    const binding = values.get(spec.name);
    if (!binding) continue;
    const patch = spec.type === "contract_patch" ? contractPatch(binding) : undefined;
    const value = patch
      ? undefined
      : bindingPath(binding) ?? (typeof binding.value === "string" ? binding.value : undefined);
    if (!patch && value === undefined) throw new Error(`observe binding ${spec.name} has no scalar value`);
    for (const target of spec.applyTo ?? []) {
      const consumer = revised.subTasks.find((task) => task.seq === target.consumerSeq);
      if (!consumer) throw new Error(`observe binding ${spec.name} targets missing sub-task ${target.consumerSeq}`);
      if (consumer.seq === input.producer.seq) throw new Error("observe binding cannot rewrite its producer");
      for (const field of target.fields) {
        switch (field) {
          case "filesLikelyTouched":
            if (patch) {
              if (!patch.filesLikelyTouched) throw new Error(`contract patch ${spec.name} has no filesLikelyTouched`);
              consumer.filesLikelyTouched = [...new Set([...(consumer.filesLikelyTouched ?? []), ...patch.filesLikelyTouched])];
            } else {
              consumer.filesLikelyTouched = [...new Set([...(consumer.filesLikelyTouched ?? []), value!])];
            }
            break;
          case "verify":
            consumer.verify = consumer.verify ?? [];
            if (patch) {
              if (!patch.verify) throw new Error(`contract patch ${spec.name} has no verify probes`);
              for (const probe of patch.verify) {
                if (!consumer.verify.some((existing) => JSON.stringify(existing) === JSON.stringify(probe))) {
                  consumer.verify.push(structuredClone(probe));
                }
              }
            } else if (!consumer.verify.some((probe) => probe.kind === "file_committed" && "path" in probe && probe.path === value)) {
              consumer.verify.push({ kind: "file_committed", path: value! });
            }
            break;
          case "intent":
            if (patch && patch.intent === undefined) throw new Error(`contract patch ${spec.name} has no intent`);
            consumer.intent = appendBinding(consumer.intent, spec.name, patch?.intent ?? value!, target.placeholder);
            break;
          case "successCriteria":
            if (patch) {
              if (!patch.successCriteria) throw new Error(`contract patch ${spec.name} has no successCriteria`);
              consumer.successCriteria = [...new Set([...consumer.successCriteria, ...patch.successCriteria])];
              break;
            }
            if (target.placeholder) {
              let hit = false;
              consumer.successCriteria = consumer.successCriteria.map((criterion) => {
                if (!criterion.includes(target.placeholder!)) return criterion;
                hit = true;
                return criterion.split(target.placeholder!).join(value!);
              });
              if (!hit) throw new Error(`binding placeholder ${target.placeholder} is missing from success criteria`);
            } else {
              consumer.successCriteria.push(`Observe binding ${spec.name} requires \`${value!}\`.`);
            }
            break;
          case "workerContext.changeSpec":
            if (!consumer.workerContext) throw new Error(`consumer ${consumer.seq} has no workerContext`);
            if (patch && patch.workerContextChangeSpec === undefined) {
              throw new Error(`contract patch ${spec.name} has no workerContextChangeSpec`);
            }
            consumer.workerContext.changeSpec = appendBinding(
              consumer.workerContext.changeSpec ?? "",
              spec.name,
              patch?.workerContextChangeSpec ?? value!,
              target.placeholder,
            );
            break;
          case "requiredBehaviorChecks":
            if (!patch?.requiredBehaviorChecks) {
              throw new Error(`contract patch ${spec.name} has no requiredBehaviorChecks`);
            }
            consumer.requiredBehaviorChecks = consumer.requiredBehaviorChecks ?? [];
            for (const check of patch.requiredBehaviorChecks) {
              const at = consumer.requiredBehaviorChecks.findIndex((existing) => existing.id === check.id);
              if (at >= 0) consumer.requiredBehaviorChecks[at] = structuredClone(check);
              else consumer.requiredBehaviorChecks.push(structuredClone(check));
            }
            break;
        }
      }
      changed.add(consumer.seq);
    }
  }
  return { plan: revised, changedConsumers: [...changed], bindingsHash: hash(input.result.bindings) };
}

export function taskHash(task: LeadPlanSubTask): string {
  return hash(task);
}

export function loadBearingObserveContractErrors(plan: LeadPlan): string[] {
  const dependedOn = new Set(plan.subTasks.flatMap((task) => task.dependsOn ?? []));
  const errors: string[] = [];
  for (const task of plan.subTasks) {
    if (task.taskMode !== "observe" || !dependedOn.has(task.seq)) continue;
    if (task.observeContract) {
      const ids = task.observeContract.requiredFindings.map(requiredFindingId);
      if (ids.some((id) => !/^[A-Za-z0-9_.-]+$/.test(id))) {
        errors.push(`observe sub-task ${task.seq} has an invalid required finding id`);
      }
      if (new Set(ids).size !== ids.length) {
        errors.push(`observe sub-task ${task.seq} has duplicate required finding ids`);
      }
    }
    const asksForBindings = /structured[^\n]{0,160}(?:binding|contract)|contract\s+bind|contract\s+addition/i.test(
      [task.title, task.intent, ...(task.successCriteria ?? [])].join("\n"),
    );
    if (asksForBindings && !task.observeContract) {
      errors.push(`observe sub-task ${task.seq} is a load-bearing prerequisite but has no observeContract`);
    }
  }
  return errors;
}
