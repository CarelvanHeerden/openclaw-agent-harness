import { createHash, randomUUID } from "node:crypto";
export const CONTRACT_AMENDMENT_VERSION = "contract-amendment/2026-09-rc.11";
function hash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function unique(xs) {
    return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}
function pathTokens(text) {
    const tokens = text.match(/(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|ts|tsx|js|mjs|json|ya?ml|sql|txt))(?:$|[\s`'",).;])/g) ?? [];
    return unique(tokens.map((token) => token.trim().replace(/^[`'"(]+|[`'",).;]+$/g, "")));
}
function canonicalArtifactLabel(path) {
    if (path === ".env.example")
        return "environment example";
    const base = path.split("/").pop() ?? path;
    const stem = base.replace(/^\./, "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
    return stem || undefined;
}
function artifactMentioned(text, path) {
    if (text.includes(path))
        return true;
    const label = canonicalArtifactLabel(path);
    return !!label && new RegExp(`\\b(?:the\\s+)?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}
function directiveFragments(text) {
    return text.split(/(?<=[.!?;])\s+/).filter(Boolean);
}
function directivePolarity(text, oldPath) {
    if (!artifactMentioned(text, oldPath) && pathTokens(text).length === 0)
        return "neutral";
    if (/\b(?:previous|prior|historical|original)\b[^.!?;]{0,100}\b(?:plan|answer|proposal|instruction|contract|said|stated|quoted)\b/i.test(text)) {
        return "provenance";
    }
    if (/\b(?:do\s+not|don't|never|without|avoid|must\s+not|may\s+not|shall\s+not|no\s+(?:read|write|access|replacement))\b/i.test(text)) {
        return "prohibition";
    }
    if (/\b(?:instead|replace|substitut|use|document|move)\b/i.test(text))
        return "affirmative";
    return "neutral";
}
function replaceArtifactText(text, oldPath, renderedNew) {
    const label = canonicalArtifactLabel(oldPath);
    const value = directiveFragments(text).map((fragment) => {
        const polarity = directivePolarity(fragment, oldPath);
        if (polarity === "prohibition" || polarity === "provenance")
            return fragment;
        let next = fragment.split(oldPath).join(renderedNew);
        if (label) {
            next = next.replace(new RegExp(`\\b(?:the\\s+)?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), renderedNew);
        }
        return next;
    }).join(" ");
    return { value, changed: value !== text };
}
function isProhibition(text, path) {
    return directiveFragments(text).some((fragment) => artifactMentioned(fragment, path) && directivePolarity(fragment, path) === "prohibition");
}
function hasPositiveObligationMention(text, path) {
    return directiveFragments(text).some((fragment) => {
        if (!artifactMentioned(fragment, path))
            return false;
        const polarity = directivePolarity(fragment, path);
        return polarity !== "prohibition" && polarity !== "provenance";
    });
}
function requiredMentions(task, path) {
    const out = [];
    if (task.filesLikelyTouched.includes(path))
        out.push("filesLikelyTouched");
    for (let i = 0; i < task.successCriteria.length; i++) {
        const criterion = task.successCriteria[i];
        if (criterion.includes(path) && hasPositiveObligationMention(criterion, path))
            out.push(`successCriteria[${i}]`);
    }
    for (let i = 0; i < (task.verify ?? []).length; i++) {
        const probe = task.verify[i];
        if ("path" in probe && probe.path === path)
            out.push(`verify[${i}]`);
    }
    if (task.intent.includes(path) && hasPositiveObligationMention(task.intent, path))
        out.push("intent");
    if (task.workerContext?.changeSpec?.includes(path) && hasPositiveObligationMention(task.workerContext.changeSpec, path)) {
        out.push("workerContext.changeSpec");
    }
    return out;
}
function reviseVerify(probes, oldPath, newPaths) {
    if (!probes)
        return undefined;
    const out = [];
    for (const probe of probes) {
        if ("path" in probe && probe.path === oldPath) {
            for (const path of newPaths)
                out.push({ ...probe, path });
        }
        else {
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
export function buildArtifactSubstitutionAmendment(input) {
    const answer = input.answer.trim();
    const blocked = unique(input.blockedPaths);
    if (blocked.length !== 1) {
        return { ok: false, reason: "the clarification does not identify exactly one blocked artifact" };
    }
    const oldPath = blocked[0];
    if (!answer.includes(oldPath)) {
        return { ok: false, reason: `the answer does not name the blocked artifact ${oldPath}` };
    }
    const fragments = directiveFragments(answer);
    const affirmative = fragments.filter((fragment) => directivePolarity(fragment, oldPath) === "affirmative");
    const oldPathAuthorised = affirmative.some((fragment) => artifactMentioned(fragment, oldPath) &&
        /\b(?:replace|substitut|instead\s+of|move)\b/i.test(fragment));
    if (!oldPathAuthorised) {
        return { ok: false, reason: "the answer does not affirmatively authorize replacing the blocked artifact" };
    }
    const candidates = pathTokens(affirmative.join(" ")).filter((path) => path !== oldPath && !path.startsWith(".env") && !blocked.includes(path));
    const newPaths = unique(candidates);
    if (newPaths.length === 0) {
        return { ok: false, reason: "the answer names no replacement artifact path" };
    }
    const original = structuredClone(input.task);
    const revised = structuredClone(input.task);
    const renderedNew = newPaths.join(" and ");
    const changed = new Set();
    revised.filesLikelyTouched = unique(revised.filesLikelyTouched.flatMap((path) => (path === oldPath ? newPaths : [path])));
    if (input.task.filesLikelyTouched.includes(oldPath))
        changed.add("filesLikelyTouched");
    const intent = replaceArtifactText(revised.intent, oldPath, renderedNew);
    if (intent.changed) {
        revised.intent = intent.value;
        changed.add("intent");
    }
    revised.successCriteria = revised.successCriteria.map((criterion, index) => {
        const next = replaceArtifactText(criterion, oldPath, renderedNew);
        if (next.changed)
            changed.add(`successCriteria[${index}]`);
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
    if ((input.task.verify ?? []).some((probe) => "path" in probe && probe.path === oldPath))
        changed.add("verify");
    if (revised.workerContext?.changeSpec) {
        const next = replaceArtifactText(revised.workerContext.changeSpec, oldPath, renderedNew);
        if (next.changed) {
            revised.workerContext.changeSpec = next.value;
            changed.add("workerContext.changeSpec");
        }
    }
    const prohibition = answer
        .split(/(?<=[.!?])\s+/)
        .find((sentence) => sentence.includes(oldPath) && isProhibition(sentence, oldPath));
    if (prohibition) {
        const context = revised.workerContext ?? { rationale: original.workerContext?.rationale ?? "Operator-scoped task amendment." };
        context.gotchas = unique([...(context.gotchas ?? []), prohibition.trim()]);
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
    if (revised.seq !== original.seq ||
        revised.title !== original.title ||
        revised.estimatedTokens !== original.estimatedTokens ||
        JSON.stringify(revised.dependsOn ?? []) !== JSON.stringify(original.dependsOn ?? []) ||
        revised.taskMode !== original.taskMode ||
        revised.contractScope !== original.contractScope ||
        JSON.stringify(revised.coFixGrantedFiles ?? []) !== JSON.stringify(original.coFixGrantedFiles ?? [])) {
        return { ok: false, reason: "the amendment changed an immutable task field" };
    }
    return {
        ok: true,
        amendment: {
            id: input.id ?? randomUUID(),
            version: CONTRACT_AMENDMENT_VERSION,
            basePlanHash: hash(input.plan),
            baseTaskHash: hash(original),
            originalTask: original,
            revisedTask: revised,
            substitution: { oldPath, newPaths, prohibitionText: prohibition?.trim() },
            changedFields: [...changed],
        },
    };
}
export function activateTaskAmendment(plan, amendment) {
    if (hash(plan) !== amendment.basePlanHash)
        throw new Error("stored plan changed after the amendment was proposed");
    const at = plan.subTasks.findIndex((task) => task.seq === amendment.originalTask.seq);
    if (at < 0)
        throw new Error(`sub-task ${amendment.originalTask.seq} no longer exists`);
    if (hash(plan.subTasks[at]) !== amendment.baseTaskHash)
        throw new Error("stored task changed after the amendment was proposed");
    const revised = structuredClone(plan);
    revised.subTasks[at] = structuredClone(amendment.revisedTask);
    return revised;
}
export function planHash(plan) {
    return hash(plan);
}
//# sourceMappingURL=contract-amendment.js.map