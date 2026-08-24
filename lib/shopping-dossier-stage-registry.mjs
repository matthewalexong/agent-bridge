import crypto from "node:crypto";
import { verifyShoppingDossierStage } from "./shopping-dossier-stage.mjs";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function bundleId(contextId, stages) {
  const payload = { context_id: contextId, stages: Object.fromEntries(Object.entries(stages).map(([name, artifact]) => [name, artifact.artifact_id])) };
  return `dossier_stages_${crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex").slice(0, 32)}`;
}

export function createShoppingDossierStageRegistry({ max_contexts = 128, max_stages = 32, verify_stage = verifyShoppingDossierStage } = {}) {
  if (!Number.isInteger(max_contexts) || max_contexts < 1 || max_contexts > 1_024 || !Number.isInteger(max_stages) || max_stages < 1 || max_stages > 100) {
    throw coded("Dossier-stage registry bounds are invalid", "shopping_dossier_stages_registry_invalid");
  }
  const entries = new Map();

  function reference(contextId, stages) {
    return { context_id: contextId, bundle_id: bundleId(contextId, stages), stage_names: Object.keys(stages).sort() };
  }

  function remember({ context_id, stages = {}, invalidate_stages = [] }) {
    const contextId = String(context_id || "");
    if (!contextId || !stages || typeof stages !== "object" || Array.isArray(stages) || !Array.isArray(invalidate_stages)) {
      throw coded("Dossier stages require an exact decision context", "shopping_dossier_stages_reference_invalid");
    }
    const prior = entries.get(contextId)?.stages || {};
    const merged = structuredClone(prior);
    for (const name of new Set(invalidate_stages)) delete merged[name];
    for (const [name, artifact] of Object.entries(stages)) {
      if (!verify_stage(name, artifact, contextId)) throw coded(`Dossier stage ${name} is invalid or context-mismatched`, "shopping_dossier_stages_reference_invalid");
      merged[name] = structuredClone(artifact);
    }
    if (Object.keys(merged).length > max_stages) throw coded("Dossier stage bundle exceeds its bounded stage count", "shopping_dossier_stages_reference_invalid");
    entries.delete(contextId);
    entries.set(contextId, { stages: merged });
    while (entries.size > max_contexts) entries.delete(entries.keys().next().value);
    return reference(contextId, merged);
  }

  function resolve(ref, contextId) {
    if (!ref || ref.context_id !== contextId) throw coded("Dossier-stage reference does not match the decision context", "shopping_dossier_stages_reference_mismatch");
    const entry = entries.get(contextId);
    if (!entry) throw coded("Dossier-stage reference is unknown in this process; rerun the evaluator waves", "shopping_dossier_stages_reference_unknown");
    const expected = reference(contextId, entry.stages);
    if (ref.bundle_id !== expected.bundle_id || JSON.stringify(ref.stage_names) !== JSON.stringify(expected.stage_names)) {
      throw coded("Dossier-stage reference is stale or altered", "shopping_dossier_stages_reference_stale");
    }
    for (const [name, artifact] of Object.entries(entry.stages)) {
      if (!verify_stage(name, artifact, contextId)) throw coded("Stored dossier-stage authority is invalid", "shopping_dossier_stages_reference_invalid");
    }
    entries.delete(contextId);
    entries.set(contextId, entry);
    return structuredClone(entry.stages);
  }

  return { remember, resolve };
}
