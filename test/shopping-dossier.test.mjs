import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { composeShoppingDossier as composeShoppingDossierProduction, validateProductClearance } from "../lib/shopping-dossier.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const composeShoppingDossier = (input) => composeShoppingDossierProduction(input, { require_stage_attestations: false, require_decision_context: false });
const artifact = (name, fields = {}, evaluated_at = NOW) => ({ artifact_id: `${name}-artifact`, evaluated_at, ...fields });
const applicability = (overrides = {}) => ({
  candidate_coverage: { required: false, reason: "The user specified one exact product rather than requesting product discovery." },
  performance: { required: false, reason: "No measured-performance metric affects this fixture." },
  value: { required: false, reason: "No normalized unit-value metric affects this fixture." },
  condition: { required: false, reason: "This fixture uses verified ordinary new inventory without a condition conflict." },
  promotion: { required: false, reason: "No promotion changes the price or recommendation in this fixture." },
  review_integrity: { required: false, reason: "No review-derived metric is used in this decision." },
  composition: { required: false, reason: "Product suitability does not depend on ingredients, allergens, materials, formulation, or hazards." },
  privacy: { required: false, reason: "Product does not collect, transmit, infer, or retain user data." },
  compatibility: { required: false, reason: "No user-product fit or compatibility dependency." },
  lifecycle: { required: true },
  preferences: { required: true },
  ownership: { required: false, reason: "No material ongoing costs." },
  deal: { required: false, reason: "User did not ask about timing." },
  ...overrides,
});

function productInput(overrides = {}) {
  return {
    phase: "product_recommendation",
    evaluated_at: NOW,
    product_id: "product-a",
    applicability: applicability(),
    stages: {
      product_evidence: artifact("evidence", { product_id: "product-a", status: "verified" }),
      safety: artifact("safety", { product_id: "product-a", action: "eligible", safety_cleared_for_ranking: true }),
      lifecycle: artifact("lifecycle", { product_id: "product-a", purchase_gate: "eligible_for_ranking", user_accepted_tradeoff: false }),
      preferences: artifact("preferences", { action: "select", selected_candidate: "product-a", reason: "robust_preference_winner" }),
    },
    ...overrides,
  };
}

function offerInput(overrides = {}) {
  const base = productInput();
  return {
    ...base,
    phase: "offer_recommendation",
    offer_id: "offer-a",
    stages: {
      ...base.stages,
      identity: artifact("identity", { offer_id: "offer-a", product_id: "product-a", classification: "exact_match", safe_to_compare_offers: true }),
      merchant: artifact("merchant", { product_id: "product-a", offer_id: "offer-a", purchase_gate: "eligible_for_other_shopping_checks" }),
      counterfeit: artifact("counterfeit", { product_id: "product-a", offer_id: "offer-a", risk_status: "low" }),
      protection: artifact("protection", { product_id: "product-a", offer_id: "offer-a", status: "eligible" }),
      fulfillment: artifact("fulfillment", { product_id: "product-a", offer_id: "offer-a", action: "eligible", fully_landed_total_usd: { low_usd: 100, expected_usd: 100, high_usd: 100 }, fully_landed_status: "verified", safe_for_offer_comparison: true }),
      offer: artifact("offer", { product_id: "product-a", offer_id: "offer-a", action: "select", selected_offer: "offer-a", landed_total_usd: 100, landed_total_range_usd: { low_usd: 100, expected_usd: 100, high_usd: 100 }, landed_price_verified: true, stock: "in_stock" }),
    },
    ...overrides,
  };
}

const checkoutConsent = (fields = {}, evaluatedAt = NOW) => artifact("checkout-consent", { product_id: "product-a", offer_id: "offer-a", status: "ready_for_confirmation", consent_cleared_for_confirmation: true, confirmation_required: true, purchase_allowed: false, ...fields }, evaluatedAt);

test("complete product dossier recommends without granting purchase authority", () => {
  const result = composeShoppingDossier(productInput());
  assert.equal(result.decision.action, "recommend_product");
  assert.equal(result.decision.selected_product, "product-a");
  assert.equal(result.decision.purchase_allowed, false);
  assert.equal(result.decision.model_override_allowed, false);
  assert.match(result.clearance_attestation, /^v1\.[a-f0-9]{64}$/);
});

test("production dossier composition rejects unsigned model-authored stages by default", () => {
  const result = composeShoppingDossierProduction(productInput());
  assert.equal(result.decision.action, "block");
  assert.deepEqual(result.audit.invalid_artifacts.sort(), ["lifecycle", "preferences", "product_evidence", "safety"]);
  assert.equal(result.clearance_attestation, null);
});

test("product clearance accepts only a fresh unchanged successful product dossier", () => {
  const artifact = composeShoppingDossier(productInput());
  assert.equal(validateProductClearance({ artifact, product_id: "product-a", evaluated_at: NOW }), artifact);

  for (const mutation of [
    (value) => { value.product_id = "product-b"; value.decision.selected_product = "product-b"; },
    (value) => { value.evaluated_at = "2026-08-22T18:00:00.000Z"; },
    (value) => { value.offer_id = "offer-a"; },
    (value) => { value.decision.research.push("missing_stage:compatibility"); },
    (value) => { value.audit.stale.push("safety"); },
    (value) => { value.decision.purchase_allowed = true; },
    (value) => { value.clearance_attestation = `v1.${"0".repeat(64)}`; },
  ]) {
    const changed = structuredClone(artifact);
    mutation(changed);
    assert.equal(validateProductClearance({ artifact: changed, product_id: "product-a", evaluated_at: NOW }), null);
  }
});

test("product clearance authority expires when the deterministic harness process restarts", () => {
  const artifact = composeShoppingDossier(productInput());
  const moduleUrl = new URL("../lib/shopping-dossier.mjs", import.meta.url).href;
  const script = `import { validateProductClearance } from ${JSON.stringify(moduleUrl)}; const artifact = JSON.parse(process.argv[1]); process.stdout.write(String(Boolean(validateProductClearance({ artifact, product_id: "product-a", evaluated_at: ${JSON.stringify(NOW)} }))));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(artifact)], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "false");
});

test("safety clearance is mandatory for every recommendation and dominates ranking", () => {
  const missing = productInput();
  delete missing.stages.safety;
  let result = composeShoppingDossier(missing);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("missing_stage:safety"));

  const recalled = productInput();
  recalled.stages.safety.action = "avoid_product";
  recalled.stages.safety.safety_cleared_for_ranking = false;
  result = composeShoppingDossier(recalled);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("safety:avoid_product"));
});

test("safety research, tradeoffs, and false clearance remain distinct", () => {
  const researchInput = productInput();
  researchInput.stages.safety.action = "research_more";
  researchInput.stages.safety.safety_cleared_for_ranking = false;
  assert.equal(composeShoppingDossier(researchInput).decision.action, "research_more");
  const tradeoff = productInput();
  tradeoff.stages.safety.action = "clarify_tradeoff";
  tradeoff.stages.safety.safety_cleared_for_ranking = false;
  assert.equal(composeShoppingDossier(tradeoff).decision.action, "clarify");
  const invalid = productInput();
  invalid.stages.safety.safety_cleared_for_ranking = false;
  assert.ok(composeShoppingDossier(invalid).decision.blockers.includes("safety:clearance_violation"));
});

test("discovered-product recommendations require fresh candidate-set clearance containing the winner", () => {
  const missing = productInput({ applicability: applicability({ candidate_coverage: { required: true } }) });
  assert.ok(composeShoppingDossier(missing).decision.research.includes("missing_stage:candidate_coverage"));
  const input = productInput({ applicability: applicability({ candidate_coverage: { required: true } }) });
  input.stages.candidate_coverage = artifact("coverage", { action: "research_more", candidate_set_cleared_for_ranking: false, eligible_candidate_ids: ["product-a"] });
  assert.equal(composeShoppingDossier(input).decision.action, "research_more");
  input.stages.candidate_coverage.action = "coverage_sufficient";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("candidate_coverage:clearance_violation"));
  input.stages.candidate_coverage.candidate_set_cleared_for_ranking = true;
  input.stages.candidate_coverage.eligible_candidate_ids = ["product-b"];
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("scope_mismatch:candidate_coverage"));
});

test("review-derived ranking requires a fresh exact integrity artifact", () => {
  const missing = productInput({ applicability: applicability({ review_integrity: { required: true } }) });
  assert.ok(composeShoppingDossier(missing).decision.research.includes("missing_stage:review_integrity"));
  const input = productInput({ applicability: applicability({ review_integrity: { required: true } }) });
  input.stages.review_integrity = artifact("reviews", { product_id: "product-a", action: "research_more", review_evidence_cleared_for_ranking: false });
  assert.equal(composeShoppingDossier(input).decision.action, "research_more");
  input.stages.review_integrity.action = "exclude_reviews";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("review_integrity:reviews_must_be_excluded"));
  input.stages.review_integrity.action = "eligible_for_review_ranking";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("review_integrity:clearance_violation"));
  input.stages.review_integrity.review_evidence_cleared_for_ranking = true;
  input.stages.review_integrity.product_id = "product-b";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("scope_mismatch:review_integrity"));
});

test("measured-performance ranking requires a fresh comparable same-product artifact", () => {
  const missing = productInput({ applicability: applicability({ performance: { required: true } }) });
  assert.ok(composeShoppingDossier(missing).decision.research.includes("missing_stage:performance"));
  const input = productInput({ applicability: applicability({ performance: { required: true } }) });
  input.stages.performance = artifact("performance", { product_id: "product-a", action: "research_more", performance_cleared_for_ranking: false });
  assert.equal(composeShoppingDossier(input).decision.action, "research_more");
  input.stages.performance.action = "conflict";
  assert.ok(composeShoppingDossier(input).decision.research.includes("performance:conflict"));
  input.stages.performance.action = "comparable";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("performance:clearance_violation"));
  input.stages.performance.performance_cleared_for_ranking = true;
  input.stages.performance.product_id = "product-b";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("scope_mismatch:performance"));
});

test("unit-value ranking requires a fresh comparable artifact containing the selected scope", () => {
  const missing = productInput({ applicability: applicability({ value: { required: true } }) });
  assert.ok(composeShoppingDossier(missing).decision.research.includes("missing_stage:value"));
  const input = productInput({ applicability: applicability({ value: { required: true } }) });
  input.stages.value = artifact("value", { action: "research_more", safe_for_value_ranking: false, eligible_product_ids: ["product-a"], eligible_offer_ids: [] });
  assert.equal(composeShoppingDossier(input).decision.action, "research_more");
  input.stages.value.action = "comparable";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("value:clearance_violation"));
  input.stages.value.safe_for_value_ranking = true;
  input.stages.value.eligible_product_ids = ["product-b"];
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("scope_mismatch:value"));
});

test("offer-level unit value must contain both selected product and offer", () => {
  const input = offerInput({ applicability: applicability({ value: { required: true } }) });
  input.stages.value = artifact("value", { action: "comparable", safe_for_value_ranking: true, eligible_product_ids: ["product-a"], eligible_offer_ids: ["offer-b"] });
  let result = composeShoppingDossier(input);
  assert.ok(result.decision.blockers.includes("scope_mismatch:value"));
  input.stages.value.eligible_offer_ids = ["offer-a"];
  result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "recommend_offer");
});

test("non-new offers require a fresh exact-offer condition artifact", () => {
  const input = offerInput({ applicability: applicability({ condition: { required: true } }) });
  let result = composeShoppingDossier(input);
  assert.ok(result.decision.research.includes("missing_stage:condition"));
  input.stages.condition = artifact("condition", { product_id: "product-a", offer_id: "offer-a", action: "research_more", condition_cleared_for_offer_comparison: false });
  result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "research_more");
  input.stages.condition.action = "clarify_tradeoff";
  result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "clarify");
  input.stages.condition.action = "avoid_offer";
  result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "block");
  input.stages.condition.action = "eligible";
  result = composeShoppingDossier(input);
  assert.ok(result.decision.blockers.includes("condition:clearance_violation"));
  input.stages.condition.condition_cleared_for_offer_comparison = true;
  result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "recommend_offer");
});

test("condition artifacts cannot be spliced across products or offers", () => {
  const input = offerInput({ applicability: applicability({ condition: { required: true } }) });
  input.stages.condition = artifact("condition", { product_id: "product-b", offer_id: "offer-a", action: "eligible", condition_cleared_for_offer_comparison: true });
  let result = composeShoppingDossier(input);
  assert.ok(result.decision.blockers.includes("scope_mismatch:condition"));
  input.stages.condition.product_id = "product-a";
  input.stages.condition.offer_id = "offer-b";
  result = composeShoppingDossier(input);
  assert.ok(result.decision.blockers.includes("scope_mismatch:condition"));
});

test("promotion-dependent offers require fresh exact-offer pricing clearance", () => {
  const missing = offerInput({ applicability: applicability({ promotion: { required: true } }) });
  let result = composeShoppingDossier(missing);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("missing_stage:promotion"));

  const input = offerInput({ applicability: applicability({ promotion: { required: true } }) });
  input.stages.promotion = artifact("promotion", { product_id: "product-a", offer_id: "offer-a", action: "clarify", pricing_cleared: false });
  result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "clarify");
  assert.ok(result.decision.clarifications.includes("promotion:fresh_acceptance_required"));

  input.stages.promotion = artifact("promotion", { product_id: "product-a", offer_id: "offer-b", action: "eligible", pricing_cleared: true });
  result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("scope_mismatch:promotion"));

  const detected = offerInput();
  detected.stages.offer.promotion_affects_price = true;
  result = composeShoppingDossier(detected);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("missing_stage:promotion"));
});

test("applicable privacy is mandatory and hard failures dominate ranking", () => {
  const missing = productInput({ applicability: applicability({ privacy: { required: true } }) });
  let result = composeShoppingDossier(missing);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("missing_stage:privacy"));

  const rejected = productInput({ applicability: applicability({ privacy: { required: true } }) });
  rejected.stages.privacy = artifact("privacy", { product_id: "product-a", action: "reject", privacy_cleared_for_ranking: false });
  result = composeShoppingDossier(rejected);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("privacy:rejected"));
});

test("privacy research, tradeoffs, false clearance, and wrong scope remain distinct", () => {
  const input = productInput({ applicability: applicability({ privacy: { required: true } }) });
  input.stages.privacy = artifact("privacy", { product_id: "product-a", action: "research_more", privacy_cleared_for_ranking: false });
  assert.equal(composeShoppingDossier(input).decision.action, "research_more");
  input.stages.privacy.action = "clarify_tradeoff";
  assert.equal(composeShoppingDossier(input).decision.action, "clarify");
  input.stages.privacy.action = "eligible";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("privacy:clearance_violation"));
  input.stages.privacy.privacy_cleared_for_ranking = true;
  input.stages.privacy.product_id = "product-b";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("scope_mismatch:privacy"));
});

test("applicable composition is mandatory and conflicts dominate ranking", () => {
  const missing = productInput({ applicability: applicability({ composition: { required: true } }) });
  let result = composeShoppingDossier(missing);
  assert.ok(result.decision.research.includes("missing_stage:composition"));
  const rejected = productInput({ applicability: applicability({ composition: { required: true } }) });
  rejected.stages.composition = artifact("composition", { product_id: "product-a", action: "reject", composition_cleared_for_ranking: false });
  result = composeShoppingDossier(rejected);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("composition:rejected"));
});

test("composition research, cross-contact clarification, false clearance, and scope stay distinct", () => {
  const input = productInput({ applicability: applicability({ composition: { required: true } }) });
  input.stages.composition = artifact("composition", { product_id: "product-a", action: "research_more", composition_cleared_for_ranking: false });
  assert.equal(composeShoppingDossier(input).decision.action, "research_more");
  input.stages.composition.action = "clarify";
  assert.equal(composeShoppingDossier(input).decision.action, "clarify");
  input.stages.composition.action = "eligible";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("composition:clearance_violation"));
  input.stages.composition.composition_cleared_for_ranking = true;
  input.stages.composition.product_id = "product-b";
  assert.ok(composeShoppingDossier(input).decision.blockers.includes("scope_mismatch:composition"));
});

test("applicable compatibility is mandatory and dominates preference ranking", () => {
  const missing = productInput({ applicability: applicability({ compatibility: { required: true } }) });
  let result = composeShoppingDossier(missing);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("missing_stage:compatibility"));

  const incompatible = productInput({ applicability: applicability({ compatibility: { required: true } }) });
  incompatible.stages.compatibility = artifact("compatibility", { product_id: "product-a", action: "incompatible", safe_for_ranking: false });
  result = composeShoppingDossier(incompatible);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("compatibility:incompatible"));
});

test("compatibility cannot claim safe ranking with missing evidence or wrong scope", () => {
  const input = productInput({ applicability: applicability({ compatibility: { required: true } }) });
  input.stages.compatibility = artifact("compatibility", { product_id: "product-a", action: "compatible", safe_for_ranking: false });
  let result = composeShoppingDossier(input);
  assert.ok(result.decision.blockers.includes("compatibility:ranking_safety_violation"));
  input.stages.compatibility.safe_for_ranking = true;
  input.stages.compatibility.product_id = "product-b";
  result = composeShoppingDossier(input);
  assert.ok(result.decision.blockers.includes("scope_mismatch:compatibility"));
});

test("a missing required stage produces targeted research", () => {
  const input = productInput();
  delete input.stages.lifecycle;
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "research_more");
  assert.deepEqual(result.decision.research, ["missing_stage:lifecycle"]);
});

test("skipping a stage requires an explicit applicability reason", () => {
  const input = productInput({ applicability: applicability({ lifecycle: { required: false } }) });
  delete input.stages.lifecycle;
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("unjustified_stage_skip:lifecycle"));
});

test("stale evidence cannot support a current recommendation", () => {
  const input = productInput();
  input.stages.product_evidence.evaluated_at = "2026-07-01T20:00:00.000Z";
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("stale_stage:product_evidence"));
});

test("future-dated artifacts and missing artifact identity are blocked", () => {
  const input = productInput();
  input.stages.lifecycle.evaluated_at = "2026-08-22T21:00:00.000Z";
  input.stages.preferences.artifact_id = "";
  const result = composeShoppingDossier(input);
  assert.ok(result.decision.blockers.includes("future_dated_stage:lifecycle"));
  assert.ok(result.decision.blockers.includes("invalid_artifact:preferences"));
});

test("a stage for another product cannot be spliced into the dossier", () => {
  const input = productInput();
  input.stages.lifecycle.product_id = "product-b";
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "block");
  assert.deepEqual(result.decision.blockers, ["scope_mismatch:lifecycle"]);
});

test("failed lifecycle gate overrides a favorable preference selection", () => {
  const input = productInput();
  input.stages.lifecycle.purchase_gate = "avoid_product";
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("lifecycle:avoid_product"));
  assert.equal(result.decision.selected_product, null);
});

test("lifecycle exposure needs explicit acceptance before ranking", () => {
  const input = productInput();
  input.stages.lifecycle.purchase_gate = "clarify_tradeoff";
  let result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "clarify");
  input.stages.lifecycle.user_accepted_tradeoff = true;
  result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "recommend_product");
});

test("preference and ownership selections must match the dossier product", () => {
  const input = productInput({ applicability: applicability({ ownership: { required: true } }) });
  input.stages.ownership = artifact("ownership", { action: "select", selected_candidate: "product-b", reason: "robust_ownership_cost_winner" });
  const result = composeShoppingDossier(input);
  assert.ok(result.decision.blockers.includes("scope_mismatch:ownership"));
});

test("complete offer dossier recommends only the exact scoped offer", () => {
  const result = composeShoppingDossier(offerInput());
  assert.equal(result.decision.action, "recommend_offer");
  assert.equal(result.decision.selected_offer, "offer-a");
  assert.deepEqual(result.audit.required, ["product_evidence", "safety", "lifecycle", "preferences", "identity", "merchant", "counterfeit", "protection", "fulfillment", "offer"]);
});

test("fully landed cost and fulfillment safety are mandatory for an offer recommendation", () => {
  const missing = offerInput();
  delete missing.stages.fulfillment;
  let result = composeShoppingDossier(missing);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("missing_stage:fulfillment"));

  const unsafe = offerInput();
  unsafe.stages.fulfillment.action = "avoid_offer";
  unsafe.stages.fulfillment.safe_for_offer_comparison = false;
  result = composeShoppingDossier(unsafe);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("fulfillment:avoid_offer"));
});

test("unknown or internally unsafe fulfillment cannot be rescued by a selected cheap offer", () => {
  const unknown = offerInput();
  unknown.stages.fulfillment.action = "research_more";
  unknown.stages.fulfillment.fully_landed_status = "unknown";
  unknown.stages.fulfillment.safe_for_offer_comparison = false;
  let result = composeShoppingDossier(unknown);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("fulfillment:fully_landed_cost_unknown"));

  const inconsistent = offerInput();
  inconsistent.stages.fulfillment.safe_for_offer_comparison = false;
  result = composeShoppingDossier(inconsistent);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("fulfillment:comparison_safety_violation"));
});

test("offer and fulfillment stages must agree on the exact landed-cost range", () => {
  const input = offerInput();
  input.stages.offer.landed_total_usd = 90;
  input.stages.offer.landed_total_range_usd = { low_usd: 90, expected_usd: 90, high_usd: 90 };
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("offer:fulfillment_cost_mismatch"));
});

test("identity, merchant, counterfeit, and protection safety gates dominate price", () => {
  for (const [stage, field, value, expected] of [
    ["identity", "classification", "different_product", "identity:different_product"],
    ["merchant", "purchase_gate", "avoid_offer", "merchant:avoid_offer"],
    ["counterfeit", "risk_status", "elevated", "counterfeit:risk_elevated"],
    ["protection", "status", "rejected", "protection:rejected"],
  ]) {
    const input = offerInput();
    input.stages[stage][field] = value;
    if (stage === "identity") input.stages.identity.safe_to_compare_offers = false;
    const result = composeShoppingDossier(input);
    assert.equal(result.decision.action, "block");
    assert.ok(result.decision.blockers.includes(expected));
  }
});

test("authorized-seller requirement failure dominates price without becoming a counterfeit finding", () => {
  const failed = offerInput();
  Object.assign(failed.stages.counterfeit, {
    risk_status: "acceptable",
    authorization_requirement_status: "failed",
    purchase_gate: "avoid_offer",
  });
  let result = composeShoppingDossier(failed);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("counterfeit:authorized_seller_required"));
  assert.ok(!result.decision.blockers.includes("counterfeit:risk_elevated"));

  const unresolved = offerInput();
  Object.assign(unresolved.stages.counterfeit, {
    risk_status: "low",
    authorization_requirement_status: "unknown",
    purchase_gate: "research_more",
  });
  result = composeShoppingDossier(unresolved);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("counterfeit:authorized_seller_unresolved"));
  assert.ok(!result.decision.research.includes("counterfeit:risk_unknown"));

  const inconsistent = offerInput();
  Object.assign(inconsistent.stages.counterfeit, {
    risk_status: "acceptable",
    authorization_requirement_status: "failed",
    purchase_gate: "eligible_for_other_shopping_checks",
  });
  result = composeShoppingDossier(inconsistent);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("counterfeit:purchase_gate_inconsistent"));
});

test("offer-scoped stages bind both product and offer even when offer IDs collide", () => {
  for (const name of ["merchant", "counterfeit", "protection", "fulfillment", "offer"]) {
    const input = offerInput();
    input.stages[name].product_id = "different-product";
    const result = composeShoppingDossier(input);
    assert.equal(result.decision.action, "block", name);
    assert.ok(result.audit.mismatched.includes(name), name);
  }
});

test("unknown offer safety evidence requests research", () => {
  const input = offerInput();
  input.stages.counterfeit.risk_status = "unknown";
  input.stages.protection.status = "needs_research";
  input.stages.offer.landed_price_verified = false;
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "research_more");
  assert.deepEqual(result.decision.research, ["counterfeit:risk_unknown", "protection:needs_research", "offer:landed_price_unverified"]);
});

test("deal timing can defer purchase without erasing the safe offer", () => {
  const input = offerInput({ applicability: applicability({ deal: { required: true } }) });
  input.stages.deal = artifact("deal", { product_id: "product-a", offer_id: "offer-a", timing_action: "wait" });
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "defer_purchase");
  assert.equal(result.decision.selected_offer, "offer-a");
  assert.deepEqual(result.decision.warnings, ["deal:wait"]);
});

test("checkout review requires a fresh preflight and preserves confirmation authority", () => {
  const base = offerInput();
  const input = { ...base, phase: "checkout_review", stages: { ...base.stages, checkout: artifact("checkout", { product_id: "product-a", offer_id: "offer-a", status: "ready_for_confirmation", confirmation_required: true, purchase_allowed: false }), checkout_consent: checkoutConsent() } };
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "present_checkout_for_confirmation");
  assert.equal(result.decision.purchase_allowed, false);
  assert.equal(result.decision.new_explicit_confirmation_required, true);
});

test("checkout stage can never claim purchase authority", () => {
  const base = offerInput();
  const input = { ...base, phase: "checkout_review", stages: { ...base.stages, checkout: artifact("checkout", { product_id: "product-a", offer_id: "offer-a", status: "ready_for_confirmation", confirmation_required: true, purchase_allowed: true }), checkout_consent: checkoutConsent() } };
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("checkout:purchase_authority_violation"));
});

test("checkout freshness is stricter than research evidence freshness", () => {
  const base = offerInput();
  const input = { ...base, phase: "checkout_review", stages: { ...base.stages, checkout: artifact("checkout", { product_id: "product-a", offer_id: "offer-a", status: "ready_for_confirmation", confirmation_required: true, purchase_allowed: false }, "2026-08-22T19:57:00.000Z"), checkout_consent: checkoutConsent() } };
  const result = composeShoppingDossier(input);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.includes("stale_stage:checkout"));
});

test("checkout review requires a fresh consent artifact for the exact offer", () => {
  const base = offerInput();
  const stages = { ...base.stages, checkout: artifact("checkout", { product_id: "product-a", offer_id: "offer-a", status: "ready_for_confirmation", confirmation_required: true, purchase_allowed: false }) };
  let result = composeShoppingDossier({ ...base, phase: "checkout_review", stages });
  assert.ok(result.decision.research.includes("missing_stage:checkout_consent"));
  stages.checkout_consent = checkoutConsent({ offer_id: "offer-b" });
  result = composeShoppingDossier({ ...base, phase: "checkout_review", stages });
  assert.ok(result.decision.blockers.includes("scope_mismatch:checkout_consent"));
  stages.checkout_consent = checkoutConsent({}, "2026-08-22T19:57:00.000Z");
  result = composeShoppingDossier({ ...base, phase: "checkout_review", stages });
  assert.ok(result.decision.research.includes("stale_stage:checkout_consent"));
});

test("unrequested add-ons and inferred consent cannot pass dossier composition", () => {
  const base = offerInput();
  const checkout = artifact("checkout", { product_id: "product-a", offer_id: "offer-a", status: "ready_for_confirmation", confirmation_required: true, purchase_allowed: false });
  let checkout_consent = checkoutConsent({ status: "remove_unrequested_items", consent_cleared_for_confirmation: false });
  let result = composeShoppingDossier({ ...base, phase: "checkout_review", stages: { ...base.stages, checkout, checkout_consent } });
  assert.equal(result.decision.action, "block");
  assert.ok(result.decision.blockers.includes("checkout_consent:unrequested_items_selected"));
  checkout_consent = checkoutConsent({ status: "clarify_consent", consent_cleared_for_confirmation: false });
  result = composeShoppingDossier({ ...base, phase: "checkout_review", stages: { ...base.stages, checkout, checkout_consent } });
  assert.equal(result.decision.action, "clarify");
});

test("dossier identifier is deterministic regardless of object key order", () => {
  const first = composeShoppingDossier(productInput());
  const source = productInput();
  const reordered = { stages: source.stages, product_id: source.product_id, evaluated_at: source.evaluated_at, applicability: source.applicability, phase: source.phase };
  const second = composeShoppingDossier(reordered);
  assert.equal(first.dossier_id, second.dossier_id);
  assert.equal(first.clearance_attestation, second.clearance_attestation);
});
