import test from "node:test";
import assert from "node:assert/strict";
import { createShoppingDossierStageRegistry } from "../lib/shopping-dossier-stage-registry.mjs";

const contextA = `shopping_context_${"a".repeat(32)}`;
const contextB = `shopping_context_${"b".repeat(32)}`;
const artifact = (stage, context_id, suffix = "1") => ({ stage, decision_context_id: context_id, artifact_id: `${stage}-${suffix}`, valid: true });
const verify = (stage, value, contextId) => value?.valid === true && value.stage === stage && value.decision_context_id === contextId;

test("dossier-stage registry accumulates exact-context stages behind one compact reference", () => {
  const registry = createShoppingDossierStageRegistry({ verify_stage: verify });
  const first = registry.remember({ context_id: contextA, stages: { product_evidence: artifact("product_evidence", contextA) } });
  const second = registry.remember({ context_id: contextA, stages: { safety: artifact("safety", contextA) } });
  assert.deepEqual(first.stage_names, ["product_evidence"]);
  assert.deepEqual(second.stage_names, ["product_evidence", "safety"]);
  assert.deepEqual(Object.keys(registry.resolve(second, contextA)).sort(), ["product_evidence", "safety"]);
  assert.throws(() => registry.resolve(first, contextA), { code: "shopping_dossier_stages_reference_stale" });
});

test("dossier-stage registry rejects altered, wrong-context, and invalid stage authority", () => {
  const registry = createShoppingDossierStageRegistry({ verify_stage: verify });
  const reference = registry.remember({ context_id: contextA, stages: { safety: artifact("safety", contextA) } });
  assert.throws(() => registry.resolve({ ...reference, bundle_id: `dossier_stages_${"0".repeat(32)}` }, contextA), { code: "shopping_dossier_stages_reference_stale" });
  assert.throws(() => registry.resolve(reference, contextB), { code: "shopping_dossier_stages_reference_mismatch" });
  assert.throws(() => registry.remember({ context_id: contextA, stages: { merchant: artifact("merchant", contextB) } }), { code: "shopping_dossier_stages_reference_invalid" });
});

test("dossier-stage registry replaces a rerun stage and bounds retained contexts", () => {
  const registry = createShoppingDossierStageRegistry({ max_contexts: 1, verify_stage: verify });
  const first = registry.remember({ context_id: contextA, stages: { safety: artifact("safety", contextA, "old") } });
  const rerun = registry.remember({ context_id: contextA, stages: { safety: artifact("safety", contextA, "new") } });
  assert.notEqual(rerun.bundle_id, first.bundle_id);
  assert.equal(registry.resolve(rerun, contextA).safety.artifact_id, "safety-new");
  const other = registry.remember({ context_id: contextB, stages: { safety: artifact("safety", contextB) } });
  assert.throws(() => registry.resolve(rerun, contextA), { code: "shopping_dossier_stages_reference_unknown" });
  assert.equal(registry.resolve(other, contextB).safety.decision_context_id, contextB);
});

test("a failed attempted rerun invalidates the older successful stage", () => {
  const registry = createShoppingDossierStageRegistry({ verify_stage: verify });
  registry.remember({ context_id: contextA, stages: { product_evidence: artifact("product_evidence", contextA), safety: artifact("safety", contextA) } });
  const afterFailure = registry.remember({ context_id: contextA, invalidate_stages: ["safety"] });
  assert.deepEqual(afterFailure.stage_names, ["product_evidence"]);
  assert.equal("safety" in registry.resolve(afterFailure, contextA), false);
});
