import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  LeadPlan,
  LeadPlanSubTask,
  ObserveBindingSpec,
  ObserveBindingType,
  ObserveContract,
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
  | { ok: true; result: StructuredObserveResult; bindingsHash: string }
  | { ok: false; reason: string };

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseEnvelope(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const marker = /OBSERVE_RESULT\s*:\s*```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (!marker) throw new Error("missing OBSERVE_RESULT JSON envelope");
  return JSON.parse(marker[1]!);
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

function pathExists(repoFiles: ReadonlySet<string>, path: string): boolean {
  return repoFiles.has(path.replace(/^\.\//, ""));
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
    raw = parseEnvelope(input.finalMessage ?? "");
  } catch (err) {
    return { ok: false, reason: `observe deliverable is not valid structured JSON: ${String(err)}` };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "observe result must be an object" };
  const result = raw as StructuredObserveResult;
  if (result.status !== "ok" && result.status !== "blocked") {
    return { ok: false, reason: "observe result status must be ok or blocked" };
  }
  if (result.status === "blocked") {
    const blockers = Array.isArray(result.blockers)
      ? result.blockers.filter((blocker): blocker is string => typeof blocker === "string" && blocker.trim().length > 0)
      : [];
    return {
      ok: false,
      reason: `observe result is blocked and cannot release dependents${blockers.length > 0 ? `: ${blockers.join("; ")}` : ""}`,
    };
  }
  if (!Array.isArray(result.findings) || !Array.isArray(result.bindings)) {
    return { ok: false, reason: "observe result must contain findings and bindings arrays" };
  }
  const findings = new Map<string, ObserveFinding>();
  const repoFiles = new Set(input.repoFiles.map((path) => path.replace(/^\.\//, "")));
  const validEvidencePath = (ref: ObserveEvidenceRef): boolean => {
    if (typeof ref.path !== "string") return false;
    const path = ref.path.replace(/^\.\//, "");
    if (!pathExists(repoFiles, path)) return false;
    return ref.line === undefined || (Number.isInteger(ref.line) && ref.line > 0);
  };
  for (const finding of result.findings) {
    if (!finding || typeof finding.id !== "string" || typeof finding.summary !== "string" || !finding.summary.trim()) {
      return { ok: false, reason: "every observe finding needs a stable id and non-empty summary" };
    }
    if (!Array.isArray(finding.evidence) || !finding.evidence.every(isEvidenceRef)) {
      return { ok: false, reason: `finding ${finding.id} has invalid evidence references` };
    }
    if (input.contract.requireEvidence !== false && finding.evidence.length === 0) {
      return { ok: false, reason: `finding ${finding.id} has no evidence` };
    }
    if (input.contract.requireEvidence !== false && !finding.evidence.some(validEvidencePath)) {
      return { ok: false, reason: `finding ${finding.id} has no repository-backed evidence` };
    }
    if (finding.evidence.some((ref) => ref.path !== undefined && !validEvidencePath(ref))) {
      return { ok: false, reason: `finding ${finding.id} references missing or invalid repository evidence` };
    }
    findings.set(finding.id, finding);
  }
  for (const id of input.contract.requiredFindings) {
    if (!findings.has(id)) return { ok: false, reason: `required finding ${id} is missing` };
  }

  const supplied = new Map(result.bindings.map((binding) => [binding.name, binding]));
  for (const spec of input.contract.bindings) {
    const binding = supplied.get(spec.name);
    if (!binding) {
      if (spec.required !== false) return { ok: false, reason: `required binding ${spec.name} is missing` };
      continue;
    }
    if (binding.type !== spec.type) {
      return { ok: false, reason: `binding ${spec.name} has type ${binding.type}, expected ${spec.type}` };
    }
    if (!Array.isArray(binding.evidence) || !binding.evidence.every(isEvidenceRef)) {
      return { ok: false, reason: `binding ${spec.name} has invalid evidence` };
    }
    if (binding.evidence.some((ref) => ref.path !== undefined && !validEvidencePath(ref))) {
      return { ok: false, reason: `binding ${spec.name} references missing or invalid repository evidence` };
    }
    const path = bindingPath(binding);
    switch (spec.type) {
      case "existing_repo_path":
        if (!path || !pathExists(repoFiles, path)) {
          return { ok: false, reason: `existing path binding ${spec.name} does not resolve in the repository` };
        }
        break;
      case "proposed_output_path":
      case "contract_patch":
        if (!path) return { ok: false, reason: `proposed path binding ${spec.name} has no path` };
        if (pathExists(repoFiles, path)) {
          return { ok: false, reason: `proposed path binding ${spec.name} collides with an existing artifact` };
        }
        if (!parentExists(repoFiles, path)) {
          return { ok: false, reason: `proposed path binding ${spec.name} has no evidenced parent convention` };
        }
        if (!binding.evidence.some(validEvidencePath)) {
          return { ok: false, reason: `proposed path binding ${spec.name} has no convention evidence` };
        }
        break;
      case "existing_symbol": {
        if (!path || !pathExists(repoFiles, path)) {
          return { ok: false, reason: `symbol binding ${spec.name} does not name an existing source path` };
        }
        const symbol = binding.value && typeof binding.value === "object"
          ? (binding.value as { symbol?: unknown }).symbol
          : undefined;
        if (typeof symbol !== "string" || !symbol.trim()) {
          return { ok: false, reason: `symbol binding ${spec.name} has no symbol name` };
        }
        const contents = input.readRepoFile?.(path);
        const escaped = symbol.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (typeof contents !== "string" || !new RegExp(`\\b${escaped}\\b`).test(contents)) {
          return { ok: false, reason: `symbol binding ${spec.name} does not resolve in ${path}` };
        }
        break;
      }
      case "status":
      case "blocker":
        if (typeof binding.value !== "string" || !binding.value.trim()) {
          return { ok: false, reason: `binding ${spec.name} must contain a non-empty string` };
        }
        break;
    }
  }
  return { ok: true, result, bindingsHash: hash(result.bindings) };
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
    const value = bindingPath(binding) ?? (typeof binding.value === "string" ? binding.value : JSON.stringify(binding.value));
    for (const target of spec.applyTo ?? []) {
      const consumer = revised.subTasks.find((task) => task.seq === target.consumerSeq);
      if (!consumer) throw new Error(`observe binding ${spec.name} targets missing sub-task ${target.consumerSeq}`);
      if (consumer.seq === input.producer.seq) throw new Error("observe binding cannot rewrite its producer");
      for (const field of target.fields) {
        switch (field) {
          case "filesLikelyTouched":
            consumer.filesLikelyTouched = [...new Set([...(consumer.filesLikelyTouched ?? []), value])];
            break;
          case "verify":
            consumer.verify = consumer.verify ?? [];
            if (!consumer.verify.some((probe) => probe.kind === "file_committed" && "path" in probe && probe.path === value)) {
              consumer.verify.push({ kind: "file_committed", path: value });
            }
            break;
          case "intent":
            consumer.intent = appendBinding(consumer.intent, spec.name, value, target.placeholder);
            break;
          case "successCriteria":
            if (target.placeholder) {
              let hit = false;
              consumer.successCriteria = consumer.successCriteria.map((criterion) => {
                if (!criterion.includes(target.placeholder!)) return criterion;
                hit = true;
                return criterion.split(target.placeholder!).join(value);
              });
              if (!hit) throw new Error(`binding placeholder ${target.placeholder} is missing from success criteria`);
            } else {
              consumer.successCriteria.push(`Observe binding ${spec.name} requires \`${value}\`.`);
            }
            break;
          case "workerContext.changeSpec":
            if (!consumer.workerContext) throw new Error(`consumer ${consumer.seq} has no workerContext`);
            consumer.workerContext.changeSpec = appendBinding(
              consumer.workerContext.changeSpec ?? "",
              spec.name,
              value,
              target.placeholder,
            );
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
    const asksForBindings = /structured[^\n]{0,160}(?:binding|contract)|contract\s+bind|contract\s+addition/i.test(
      [task.title, task.intent, ...(task.successCriteria ?? [])].join("\n"),
    );
    if (asksForBindings && !task.observeContract) {
      errors.push(`observe sub-task ${task.seq} is a load-bearing prerequisite but has no observeContract`);
    }
  }
  return errors;
}
