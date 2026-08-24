import test from "node:test";
import assert from "node:assert/strict";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { adaptShoppingEvaluatorResult, verifyShoppingDossierStage } from "../lib/shopping-dossier-stage.mjs";
import { SHOPPING_EVALUATOR_STAGES } from "../lib/shopping-evaluator-batch.mjs";
import { createShoppingDecisionContext as createShoppingDecisionContextProduction } from "../lib/shopping-decision-context.mjs";
import { issueShoppingRequestReceipt } from "../lib/shopping-request-intent.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const createShoppingDecisionContext = (input) => createShoppingDecisionContextProduction(input, () => Date.parse(NOW));
const skipped = { required: false, reason: "Not applicable to this adapter fixture." };
const APPLICABILITY = Object.fromEntries(["candidate_coverage", "performance", "value", "condition", "promotion", "review_integrity", "composition", "privacy", "compatibility", "lifecycle", "preferences", "ownership", "deal"].map((name) => [name, skipped]));
const REQUEST = issueShoppingRequestReceipt({ request_id: "request-a", text: "Research the exact camera.", captured_at: NOW });
const REQUEST_CLAUSE = REQUEST.clauses[0].clause_id;
const contextFields = { request_receipt: REQUEST, profile_state_revision: 1, objective: "Research the exact camera.", objective_clause_ids: [REQUEST_CLAUSE], clause_dispositions: [{ clause_id: REQUEST_CLAUSE, role: "objective" }], market_country_code: "US", destination: { country_code: "US" }, constraints: [], applicability: APPLICABILITY };
const context = (phase = "product_recommendation", offer_id = null) => createShoppingDecisionContext({ ...contextFields, phase, product_id: "camera-x", offer_id });

test("adapters issue exact process-attested product and offer stages", () => {
  const productEvidence = adaptShoppingEvaluatorResult({
    tool: "shopping_product_evidence", subject: { product_id: "camera-x" }, input: {}, decision_context: context(), evaluated_at: NOW,
    result: { policy: { evaluated_at: NOW }, products: [{ id: "camera-x", attribute_evidence: { model: "verified" }, verified_attributes: { model: "CX-1" } }] },
  });
  assert.equal(productEvidence.status, "verified");
  assert.match(productEvidence.evaluator_input_sha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyShoppingDossierStage("product_evidence", productEvidence), true);

  const identityResult = attestShoppingArtifact("identity", { evaluated_at: NOW, target_product_id: "camera-x", resolutions: [{ candidate_id: "offer-a", classification: "exact_match", safe_to_compare_offers: true }] });
  const identity = adaptShoppingEvaluatorResult({ tool: "shopping_identity_resolve", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: {}, result: identityResult, decision_context: context("offer_recommendation", "offer-a"), evaluated_at: NOW });
  assert.deepEqual({ product_id: identity.product_id, offer_id: identity.offer_id, classification: identity.classification }, { product_id: "camera-x", offer_id: "offer-a", classification: "exact_match" });
  assert.equal(verifyShoppingDossierStage("identity", identity), true);

  const offer = adaptShoppingEvaluatorResult({
    tool: "shopping_offer_analyze", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: { evaluated_at: NOW }, decision_context: context("offer_recommendation", "offer-a"), evaluated_at: NOW,
    result: { normalized_offers: [{ id: "offer-a", product_key: "camera-x", landed_price_verified: true, promotion_claimed: false, immediate_checkout_discount_usd: 0, stock: "in_stock" }], verified_decision: { action: "select", selected_offer: "offer-a", landed_total_usd: 100, landed_total_range_usd: { low_usd: 100, expected_usd: 100, high_usd: 100 } } },
  });
  assert.equal(offer.action, "select");
  assert.equal(offer.promotion_affects_price, false);
  assert.equal(verifyShoppingDossierStage("offer", offer), true);
});

test("adapters fail closed on ambiguous or mismatched evaluator subjects", () => {
  assert.throws(() => adaptShoppingEvaluatorResult({
    tool: "shopping_compatibility_assess", subject: { product_id: "camera-x" }, input: {}, decision_context: context(), evaluated_at: NOW,
    result: { assessments: [{ id: "camera-x", action: "compatible", safe_for_ranking: true }, { id: "camera-x", action: "compatible", safe_for_ranking: true }] },
  }), { code: "shopping_dossier_stage_scope" });

  const identityResult = attestShoppingArtifact("identity", { evaluated_at: NOW, target_product_id: "other-product", resolutions: [{ candidate_id: "offer-a", classification: "exact_match", safe_to_compare_offers: true }] });
  assert.throws(() => adaptShoppingEvaluatorResult({ tool: "shopping_identity_resolve", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: {}, result: identityResult, decision_context: context("offer_recommendation", "offer-a"), evaluated_at: NOW }), { code: "shopping_dossier_stage_source_invalid" });
});

test("offer stages preserve bounded verified delivery and protection facts for final explanations", () => {
  const decisionContext = context("offer_recommendation", "offer-a");
  const protection = adaptShoppingEvaluatorResult({
    tool: "shopping_protection_assess", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: {}, decision_context: decisionContext, evaluated_at: NOW,
    result: attestShoppingArtifact("protection", { evaluated_at: NOW, assessments: [{ id: "offer-a", product_id: "camera-x", status: "eligible", metrics: { return_window: 30, warranty_duration: 12, buyer_protection: 60 } }] }),
  });
  assert.deepEqual({ return_window_days: protection.return_window_days, warranty_duration_months: protection.warranty_duration_months, buyer_protection_days: protection.buyer_protection_days }, { return_window_days: 30, warranty_duration_months: 12, buyer_protection_days: 60 });
  const fulfillment = adaptShoppingEvaluatorResult({
    tool: "shopping_fulfillment_assess", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: { destination_country: "US" }, decision_context: decisionContext, evaluated_at: NOW,
    result: { evaluated_at: NOW, assessments: [{ id: "offer-a", product_id: "camera-x", action: "eligible", fully_landed_total_usd: { low_usd: 100, expected_usd: 100, high_usd: 100 }, fully_landed_status: "verified", safe_for_offer_comparison: true, delivery: { earliest_at: "2026-08-28T00:00:00.000Z", latest_at: "2026-08-30T00:00:00.000Z", tracking_available: true } }] },
  });
  assert.deepEqual({ delivery_earliest_at: fulfillment.delivery_earliest_at, delivery_latest_at: fulfillment.delivery_latest_at, tracking_available: fulfillment.tracking_available }, { delivery_earliest_at: "2026-08-28T00:00:00.000Z", delivery_latest_at: "2026-08-30T00:00:00.000Z", tracking_available: true });
});

test("dossier stage attestation detects field, stage, and subject tampering", () => {
  const stage = adaptShoppingEvaluatorResult({
    tool: "shopping_condition_assess", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: {}, decision_context: context("offer_recommendation", "offer-a"), evaluated_at: NOW,
    result: { evaluated_at: NOW, product_id: "camera-x", offer_id: "offer-a", action: "eligible", condition_cleared_for_offer_comparison: true },
  });
  for (const mutate of [
    (value) => { value.action = "avoid_offer"; },
    (value) => { value.stage = "promotion"; },
    (value) => { value.offer_id = "offer-b"; },
    (value) => { value.evaluator_input_sha256 = "0".repeat(64); },
    (value) => { value.artifact_id = "forged"; },
  ]) {
    const changed = structuredClone(stage);
    mutate(changed);
    assert.equal(verifyShoppingDossierStage("condition", changed), false);
  }
});

test("checkout adaptation requires exact offer binding and never grants authority", () => {
  assert.throws(() => adaptShoppingEvaluatorResult({
    tool: "shopping_checkout_preflight", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: { expected: { evaluated_at: NOW, destination_country: "CA", product_key: "camera-x", offer_id: "offer-a" }, cart: { items: [{ id: "offer-a", product_key: "camera-x" }] } }, decision_context: context("checkout_review", "offer-a"), evaluated_at: NOW,
    result: { status: "ready_for_confirmation", confirmation_required: true, purchase_allowed: false },
  }), { code: "shopping_dossier_stage_context_mismatch" });
  assert.throws(() => adaptShoppingEvaluatorResult({
    tool: "shopping_checkout_preflight", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: { expected: { evaluated_at: NOW, destination_country: "US" } }, decision_context: context("checkout_review", "offer-a"), evaluated_at: NOW,
    result: { status: "ready_for_confirmation", confirmation_required: true, purchase_allowed: false },
  }), { code: "shopping_dossier_stage_scope" });
  const stage = adaptShoppingEvaluatorResult({
    tool: "shopping_checkout_preflight", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: { expected: { evaluated_at: NOW, destination_country: "US", product_key: "camera-x", offer_id: "offer-a" }, cart: { items: [{ id: "offer-a", product_key: "camera-x" }] } }, decision_context: context("checkout_review", "offer-a"), evaluated_at: NOW,
    result: attestShoppingArtifact("checkout_preflight", { evaluated_at: NOW, status: "needs_verification", applied_discount_usd: 0, confirmation_required: true, purchase_allowed: false }),
  });
  assert.equal(stage.status, "needs_research");
  assert.equal(stage.purchase_allowed, false);

  assert.throws(() => adaptShoppingEvaluatorResult({
    tool: "shopping_checkout_preflight", subject: { product_id: "camera-x", offer_id: "offer-a" }, input: { expected: { evaluated_at: NOW, destination_country: "US", product_key: "camera-x", offer_id: "offer-a" }, cart: { items: [{ id: "offer-a", product_key: "camera-x" }] } }, decision_context: context("checkout_review", "offer-a"), evaluated_at: NOW,
    result: { evaluated_at: NOW, status: "ready_for_confirmation", confirmation_required: true, purchase_allowed: false },
  }), { code: "shopping_dossier_stage_source_invalid" });
});

test("every allowlisted evaluator has a schema-valid exact-subject adapter", () => {
  const product = "product-a";
  const offer = "offer-a";
  const subject = { product_id: product, offer_id: offer };
  const decisionContext = createShoppingDecisionContext({ ...contextFields, phase: "offer_recommendation", product_id: product, offer_id: offer, objective: "Exercise all adapters." });
  const signed = (kind, value) => attestShoppingArtifact(kind, { evaluated_at: NOW, ...value });
  const fixtures = {
    shopping_candidate_coverage: { input: { market_country: "US" }, result: { evaluated_at: NOW, action: "coverage_sufficient", candidate_set_cleared_for_ranking: true, eligible_candidate_ids: [product] } },
    shopping_performance_assess: { result: { evaluated_at: NOW, assessments: [{ product_id: product, action: "comparable", performance_cleared_for_ranking: true }] } },
    shopping_value_assess: { result: { evaluated_at: NOW, action: "comparable", safe_for_value_ranking: true, eligible_product_ids: [product], eligible_offer_ids: [offer] } },
    shopping_condition_assess: { result: { evaluated_at: NOW, product_id: product, offer_id: offer, action: "eligible", condition_cleared_for_offer_comparison: true } },
    shopping_promotion_assess: { result: { evaluated_at: NOW, product_id: product, offer_id: offer, action: "eligible", pricing_cleared: true } },
    shopping_review_integrity: { result: { evaluated_at: NOW, product_id: product, action: "eligible_for_review_ranking", review_evidence_cleared_for_ranking: true } },
    shopping_safety_assess: { input: { jurisdiction: "US" }, result: signed("safety", { assessments: [{ id: offer, product_key: product, action: "eligible", safety_cleared_for_ranking: true }] }) },
    shopping_composition_assess: { result: { assessments: [{ id: product, action: "eligible", composition_cleared_for_ranking: true }] } },
    shopping_privacy_assess: { result: { evaluated_at: NOW, assessments: [{ id: product, action: "eligible", privacy_cleared_for_ranking: true }] } },
    shopping_compatibility_assess: { result: { assessments: [{ id: product, action: "compatible", safe_for_ranking: true }] } },
    shopping_lifecycle_assess: { result: { evaluated_at: NOW, assessments: [{ id: product, purchase_gate: "eligible_for_ranking" }] } },
    shopping_preference_rank: { result: { decision: { action: "select", selected_candidate: product, reason: "winner" } } },
    shopping_ownership_cost: { result: { decision: { action: "select", selected_candidate: product, reason: "winner" } } },
    shopping_identity_resolve: { result: signed("identity", { target_product_id: product, resolutions: [{ candidate_id: offer, classification: "exact_match", safe_to_compare_offers: true }] }) },
    shopping_merchant_trust: { result: signed("merchant", { assessments: [{ id: offer, product_id: product, purchase_gate: "eligible_for_other_shopping_checks" }] }) },
    shopping_counterfeit_assess: { result: signed("counterfeit", { assessments: [{ offer_id: offer, product_id: product, risk_status: "low" }] }) },
    shopping_protection_assess: { result: signed("protection", { assessments: [{ id: offer, product_id: product, status: "eligible" }] }) },
    shopping_fulfillment_assess: { input: { destination_country: "US" }, result: { evaluated_at: NOW, assessments: [{ id: offer, product_id: product, action: "eligible", fully_landed_total_usd: { low_usd: 10, expected_usd: 10, high_usd: 10 }, fully_landed_status: "verified", safe_for_offer_comparison: true }] } },
    shopping_offer_analyze: { input: { evaluated_at: NOW }, result: { normalized_offers: [{ id: offer, product_key: product, landed_price_verified: true, stock: "in_stock", immediate_checkout_discount_usd: 0 }], verified_decision: { action: "select", selected_offer: offer, landed_total_usd: 10, landed_total_range_usd: { low_usd: 10, expected_usd: 10, high_usd: 10 } } } },
    shopping_deal_quality: { input: { policy: { evaluated_at: NOW }, current: { offer_id: offer, product_key: product } }, result: { timing: { action: "buy_now" } } },
    shopping_checkout_preflight: { input: { expected: { evaluated_at: NOW, destination_country: "US", product_key: product, offer_id: offer }, cart: { items: [{ id: offer, product_key: product }] } }, result: signed("checkout_preflight", { status: "ready_for_confirmation", applied_discount_usd: 0, confirmation_required: true, purchase_allowed: false }) },
    shopping_checkout_consent_assess: { input: { product_id: product, offer_id: offer }, result: signed("checkout_consent", { product_id: product, offer_id: offer, status: "ready_for_confirmation", consent_cleared_for_confirmation: true, confirmation_required: true, purchase_allowed: false }) },
    shopping_product_evidence: { result: { policy: { evaluated_at: NOW }, products: [{ id: product, attribute_evidence: { model: "verified" } }] } },
  };
  assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(SHOPPING_EVALUATOR_STAGES).sort());
  for (const [tool, fixture] of Object.entries(fixtures)) {
    const stage = adaptShoppingEvaluatorResult({ tool, subject, input: fixture.input || {}, result: fixture.result, decision_context: decisionContext, evaluated_at: NOW });
    assert.equal(stage.stage, SHOPPING_EVALUATOR_STAGES[tool], tool);
    assert.equal(verifyShoppingDossierStage(stage.stage, stage), true, tool);
  }
});
