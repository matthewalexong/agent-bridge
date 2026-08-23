import test from "node:test";
import assert from "node:assert/strict";
import { analyzeShoppingOffers } from "../lib/shopping-decision.mjs";
import { composeShoppingDossier as composeShoppingDossierProduction } from "../lib/shopping-dossier.mjs";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { deriveShoppingRiskFeatures } from "../lib/shopping-risk.mjs";
import { deriveShoppingResearchFeatures } from "../lib/shopping-sufficiency.mjs";

const NOW = "2026-08-22T20:00:40.000Z";
const composeShoppingDossier = (input) => composeShoppingDossierProduction(input, { require_stage_attestations: false, require_decision_context: false });
function productClearance(productId) {
  const skipped = (reason) => ({ required: false, reason });
  return composeShoppingDossier({
    evaluated_at: NOW,
    phase: "product_recommendation",
    product_id: productId,
    applicability: {
      candidate_coverage: skipped("The caller supplied one exact product."), performance: skipped("No measured metric affects this offer-ranking fixture."), value: skipped("No normalized value metric affects this fixture."), condition: skipped("Ordinary new inventory has no condition conflict."), promotion: skipped("No promotion affects this product decision."), review_integrity: skipped("No review-derived metric affects this fixture."), composition: skipped("No composition dependency affects this fixture."), privacy: skipped("No connected-data dependency affects this fixture."), compatibility: skipped("No compatibility dependency affects this fixture."), lifecycle: skipped("No lifecycle dependency affects this fixture."), preferences: skipped("The product was supplied exactly."), ownership: skipped("No ownership-cost dependency affects this fixture."), deal: skipped("Purchase timing was not requested."),
    },
    stages: {
      product_evidence: { artifact_id: `evidence-${productId}`, evaluated_at: NOW, product_id: productId, status: "verified" },
      safety: { artifact_id: `safety-${productId}`, evaluated_at: NOW, product_id: productId, action: "eligible", safety_cleared_for_ranking: true },
    },
  });
}
function analyze(input, ranges = {}) {
  const offers = input.offers.map((offer) => ({ seller: "Test Seller", ...offer }));
  const promotionArtifacts = (input.promotion_artifacts || []).map((artifact) => attestShoppingArtifact("promotion", artifact));
  const fulfillmentPayload = input.fulfillment || {
    artifact_id: "fulfillment-test", evaluated_at: NOW, destination_country: "US",
    assessments: offers.map((offer) => {
      const promotion = promotionArtifacts.find((artifact) => artifact.offer_id === offer.id);
      const fallback = typeof offer.price_usd === "number" && typeof offer.shipping_usd === "number" ? offer.price_usd + offer.shipping_usd : null;
      const specified = ranges[offer.id];
      const range = specified || (promotion?.guaranteed_economic_cost_usd != null ? { low_usd: promotion.guaranteed_economic_cost_usd, expected_usd: promotion.guaranteed_economic_cost_usd, high_usd: promotion.guaranteed_economic_cost_usd } : fallback == null ? null : { low_usd: fallback, expected_usd: fallback, high_usd: fallback });
      return { id: offer.id, product_id: offer.product_key, action: range ? "eligible" : "research_more", fully_landed_total_usd: range, fully_landed_status: range ? "verified" : "unknown", safe_for_offer_comparison: Boolean(range), promotion: promotion ? { artifact_evaluated_at: promotion.evaluated_at, immediate_checkout_discount_usd: promotion.immediate_checkout_discount_usd, required_incremental_cost_usd: promotion.required_incremental_cost_usd } : null, purchase_allowed: false };
    }),
  };
  const fulfillment = fulfillmentPayload.artifact_attestation ? fulfillmentPayload : attestShoppingArtifact("fulfillment", fulfillmentPayload);
  const counterfeit = attestShoppingArtifact("counterfeit", input.counterfeit || {
    evaluated_at: NOW,
    assessments: offers.map((offer) => ({ offer_id: offer.id, product_id: offer.product_key, variant: offer.variant ?? null, seller: offer.seller, availability: { status: "in_stock", evidence_status: "verified" }, risk_status: "low", purchase_gate: "eligible_for_other_shopping_checks", distinctions: { identity_exact: true, condition: offer.condition || "new" } })),
  });
  const merchant = attestShoppingArtifact("merchant", input.merchant || {
    evaluated_at: NOW,
    assessments: offers.map((offer) => ({ id: offer.id, status: "verified_established", purchase_gate: "eligible_for_other_shopping_checks", roles: { seller: { name: offer.seller }, merchant_of_record: { name: offer.seller } } })),
  });
  const protection = attestShoppingArtifact("protection", input.protection || {
    evaluated_at: NOW,
    assessments: offers.map((offer) => ({ id: offer.id, product_id: offer.product_key, variant: offer.variant ?? null, condition: offer.condition || "new", seller: offer.seller, status: "eligible", purchase_gate: "eligible_for_offer_analysis", deadlines: {} })),
  });
  const identity = attestShoppingArtifact("identity", input.identity || {
    evaluated_at: NOW,
    target_product_id: input.requirements?.product_key || offers[0]?.product_key,
    resolutions: offers.map((offer) => ({ candidate_id: offer.id, offer_variant: offer.variant ?? null, classification: "exact_match", safe_to_compare_offers: true, confidence: 1, canonical: { condition: offer.condition || "new" } })),
  });
  const safety = attestShoppingArtifact("safety", input.safety || {
    evaluated_at: NOW, jurisdiction: "US",
    assessments: offers.map((offer) => ({ id: offer.id, product_key: offer.product_key, variant: offer.variant ?? null, condition: offer.condition || "new", seller: offer.seller, serial_number: null, action: "eligible", safety_cleared_for_ranking: true, purchase_allowed: false, warnings: [] })),
  });
  const product_clearance = Object.hasOwn(input, "product_clearance") ? input.product_clearance : productClearance(input.requirements?.product_key || offers[0]?.product_key);
  return analyzeShoppingOffers({ evaluated_at: NOW, destination_country: "US", ...input, offers, promotion_artifacts: promotionArtifacts, fulfillment, counterfeit, merchant, protection, identity, safety, product_clearance });
}

test("offer ranking requires the fresh exact product-level decision clearance", () => {
  const input = { requirements: { product_key: "camera" }, offers: [{ id: "A", product_key: "camera", price_usd: 100, shipping_usd: 0, stock: "in_stock" }] };
  let result = analyze({ ...input, product_clearance: null });
  assert.equal(result.verified_decision.action, "research_more");
  assert.ok(result.normalized_offers[0].requirement_failures.includes("product decision clearance unverified"));

  for (const mutation of [
    (artifact) => { artifact.product_id = "other-camera"; artifact.decision.selected_product = "other-camera"; },
    (artifact) => { artifact.evaluated_at = "2026-08-22T18:00:00.000Z"; },
    (artifact) => { artifact.decision.action = "research_more"; },
    (artifact) => { artifact.decision.purchase_allowed = true; },
    (artifact) => { artifact.clearance_attestation = `v1.${"0".repeat(64)}`; },
  ]) {
    const artifact = productClearance("camera");
    mutation(artifact);
    result = analyze({ ...input, product_clearance: artifact });
    assert.equal(result.normalized_offers[0].product_decision_clearance_verified, false);
  }
});

test("production shopping decision never treats unknown shipping as free", () => {
  const result = analyze({
    requirements: { product_key: "kettle", condition: "new" },
    offers: [
      { id: "A", product_key: "kettle", condition: "new", quantity: 1, price_usd: 39, shipping_usd: null, stock: "in_stock" },
      { id: "B", product_key: "kettle", condition: "new", quantity: 1, price_usd: 46, shipping_usd: 0, stock: "in_stock" },
    ],
  });
  assert.equal(result.normalized_offers[0].landed_price_verified, false);
  assert.deepEqual(result.verified_decision, { action: "select", selected_offer: "B", landed_total_usd: 46, landed_total_range_usd: { low_usd: 46, expected_usd: 46, high_usd: 46 } });
});

test("raw coupon claims cannot reduce or clear an offer price", () => {
  const result = analyze({
    requirements: { product_key: "camera" },
    offers: [
      { id: "A", product_key: "camera", price_usd: 100, shipping_usd: 0, coupon_usd: 50, coupon_eligible: true, stock: "in_stock" },
      { id: "B", product_key: "camera", price_usd: 80, shipping_usd: 0, stock: "in_stock" },
    ],
  });
  assert.equal(result.normalized_offers[0].computed_landed_total_usd, null);
  assert.equal(result.normalized_offers[0].fulfillment_verified, false);
  assert.equal(result.normalized_offers[0].promotion_pricing_verified, false);
  assert.ok(result.normalized_offers[0].requirement_failures.includes("promotion price unverified"));
  assert.equal(result.verified_decision.selected_offer, "B");
});

test("offer ranking accepts only a matching cleared promotion artifact and includes obligations", () => {
  const offers = [
    { id: "A", product_key: "camera", price_usd: 100, shipping_usd: 0, promotion_claimed: true, stock: "in_stock" },
    { id: "B", product_key: "camera", price_usd: 95, shipping_usd: 0, stock: "in_stock" },
  ];
  const promotion_artifacts = [{ offer_id: "A", product_id: "camera", evaluated_at: "2026-08-22T20:00:30.000Z", action: "eligible", pricing_cleared: true, base_price_usd: 100, shipping_usd: 0, immediate_checkout_discount_usd: 20, checkout_landed_total_usd: 80, deferred_value_usd: 0, required_incremental_cost_usd: 30, guaranteed_economic_cost_usd: 110, purchase_allowed: false }];
  let result = analyze({ requirements: { product_key: "camera" }, offers, promotion_artifacts });
  assert.equal(result.normalized_offers[0].computed_landed_total_usd, 110);
  assert.equal(result.verified_decision.selected_offer, "B");
  promotion_artifacts[0].required_incremental_cost_usd = 0;
  promotion_artifacts[0].guaranteed_economic_cost_usd = 80;
  result = analyze({ requirements: { product_key: "camera" }, offers, promotion_artifacts });
  assert.equal(result.verified_decision.selected_offer, "A");
  promotion_artifacts[0].guaranteed_economic_cost_usd = 1;
  result = analyze({ requirements: { product_key: "camera" }, offers, promotion_artifacts });
  assert.equal(result.verified_decision.selected_offer, "B");
  assert.equal(result.normalized_offers[0].promotion_pricing_verified, false);
  promotion_artifacts[0].guaranteed_economic_cost_usd = 80;
  promotion_artifacts[0].evaluated_at = "2026-08-22T19:00:00.000Z";
  result = analyze({ requirements: { product_key: "camera" }, offers, promotion_artifacts });
  assert.equal(result.verified_decision.selected_offer, "B");
});

test("unit-cost optimization cannot divide by raw listing quantity", () => {
  const input = {
    objective: "unit_cost",
    requirements: { product_key: "filter-x", condition: "new" },
    offers: [
      { id: "A", product_key: "filter-x", condition: "new", quantity: 100, price_usd: 20, shipping_usd: 0, stock: "in_stock" },
      { id: "B", product_key: "filter-x", condition: "new", quantity: 2, price_usd: 30, shipping_usd: 0, stock: "in_stock" },
    ],
  };
  let result = analyze(input);
  assert.equal(result.verified_decision.action, "research_more");
  assert.equal(result.verified_decision.reason, "unit_value_not_cleared");
  assert.equal(result.normalized_offers[0].computed_unit_cost_usd, null);

  input.unit_value = {
    action: "comparable", safe_for_value_ranking: true,
    assessments: [
      { offer_id: "A", status: "comparable", normalized_quantity: 1, normalized_unit: "each", landed_total_usd: 20 },
      { offer_id: "B", status: "comparable", normalized_quantity: 2, normalized_unit: "each", landed_total_usd: 30 },
    ],
  };
  result = analyze(input);
  assert.equal(result.verified_decision.action, "select");
  assert.equal(result.verified_decision.selected_offer, "B");
  assert.equal(result.normalized_offers[0].computed_unit_cost_usd, 20);
  assert.equal(result.normalized_offers[1].computed_unit_cost_usd, 15);
});

test("unit-value artifact must match current landed totals for every viable offer", () => {
  const result = analyze({
    objective: "unit_cost", requirements: { product_key: "soap" },
    offers: [{ id: "A", product_key: "soap", quantity: 2, price_usd: 10, shipping_usd: 0, stock: "in_stock" }],
    unit_value: { action: "comparable", safe_for_value_ranking: true, assessments: [{ offer_id: "A", status: "comparable", normalized_quantity: 2, normalized_unit: "each", landed_total_usd: 9 }] },
  });
  assert.equal(result.verified_decision.action, "research_more");
  assert.equal(result.normalized_offers[0].unit_value_verified, false);
});

test("multi-unit hard requirements also require normalized quantity evidence", () => {
  const result = analyze({
    requirements: { product_key: "filter-x", min_quantity: 2, quantity_unit: "each" },
    offers: [{ id: "A", product_key: "filter-x", quantity: 200, price_usd: 10, shipping_usd: 0, stock: "in_stock" }],
  });
  assert.equal(result.verified_decision.action, "research_more");
  assert.deepEqual(result.normalized_offers[0].requirement_failures, ["quantity unverified in each"]);
});

test("offer ranking uses tax and fee inclusive fulfillment cost, not listing price", () => {
  const input = {
    requirements: { product_key: "laptop" },
    offers: [
      { id: "A", product_key: "laptop", price_usd: 90, shipping_usd: 0, stock: "in_stock" },
      { id: "B", product_key: "laptop", price_usd: 100, shipping_usd: 0, stock: "in_stock" },
    ],
  };
  const result = analyze(input, {
    A: { low_usd: 120, expected_usd: 120, high_usd: 120 },
    B: { low_usd: 105, expected_usd: 105, high_usd: 105 },
  });
  assert.equal(result.verified_decision.selected_offer, "B");
  assert.equal(result.verified_decision.landed_total_usd, 105);
});

test("offer ranking preserves strict under-budget semantics at equality", () => {
  const base = { offers: [{ id: "A", product_key: "camera", price_usd: 100, shipping_usd: 0, stock: "in_stock" }] };
  assert.equal(analyze({ ...base, requirements: { product_key: "camera", max_landed_usd: 100, max_landed_operator: "lte" } }).verified_decision.selected_offer, "A");
  const strict = analyze({ ...base, requirements: { product_key: "camera", max_landed_usd: 100, max_landed_operator: "lt" } });
  assert.equal(strict.verified_decision.action, "research_more");
  assert.ok(strict.normalized_offers[0].requirement_failures.includes("landed total may exceed $100"));
});

test("missing, stale, wrong-destination, and authority-violating fulfillment cannot rank", () => {
  const input = { requirements: { product_key: "phone" }, offers: [{ id: "A", product_key: "phone", price_usd: 100, shipping_usd: 0, stock: "in_stock" }] };
  let result = analyzeShoppingOffers({ evaluated_at: NOW, destination_country: "US", ...input });
  assert.equal(result.verified_decision.action, "research_more");
  assert.ok(result.normalized_offers[0].requirement_failures.includes("fully landed cost unverified"));

  const valid = analyze(input).normalized_offers;
  assert.equal(valid[0].fulfillment_verified, true);
  for (const mutation of [
    (artifact) => { artifact.evaluated_at = "2026-08-22T19:00:00.000Z"; },
    (artifact) => { artifact.destination_country = "CA"; },
    (artifact) => { artifact.assessments[0].purchase_allowed = true; },
    (artifact) => { artifact.assessments[0].product_id = "other-phone"; },
  ]) {
    const artifact = { artifact_id: "fulfillment-a", evaluated_at: NOW, destination_country: "US", assessments: [{ id: "A", product_id: "phone", action: "eligible", fully_landed_total_usd: { low_usd: 100, expected_usd: 100, high_usd: 100 }, fully_landed_status: "verified", safe_for_offer_comparison: true, purchase_allowed: false }] };
    mutation(artifact);
    result = analyze({ ...input, fulfillment: artifact });
    assert.equal(result.verified_decision.action, "research_more");
  }
  const forged = attestShoppingArtifact("fulfillment", { artifact_id: "fulfillment-forged", evaluated_at: NOW, destination_country: "US", assessments: [{ id: "A", product_id: "phone", action: "eligible", fully_landed_total_usd: { low_usd: 100, expected_usd: 100, high_usd: 100 }, fully_landed_status: "verified", safe_for_offer_comparison: true, purchase_allowed: false }] });
  forged.assessments[0].fully_landed_total_usd.expected_usd = 1;
  result = analyze({ ...input, fulfillment: forged });
  assert.equal(result.verified_decision.action, "research_more");
  assert.equal(result.normalized_offers[0].fulfillment_verified, false);
});

test("offer ranking requires a fresh exact-scope cleared counterfeit artifact", () => {
  const input = { requirements: { product_key: "watch" }, offers: [
    { id: "A", product_key: "watch", variant: "steel", seller: "Authorized Shop", price_usd: 100, shipping_usd: 0, stock: "in_stock" },
    { id: "B", product_key: "watch", variant: "steel", seller: "Marketplace Seller", price_usd: 60, shipping_usd: 0, stock: "in_stock" },
  ] };
  let result = analyze(input);
  assert.equal(result.verified_decision.selected_offer, "B");

  const artifact = {
    evaluated_at: NOW,
    assessments: [
      { offer_id: "A", product_id: "watch", variant: "steel", seller: "Authorized Shop", availability: { status: "in_stock", evidence_status: "verified" }, risk_status: "low", purchase_gate: "eligible_for_other_shopping_checks", distinctions: { identity_exact: true, condition: "new" } },
      { offer_id: "B", product_id: "watch", variant: "steel", seller: "Marketplace Seller", availability: { status: "in_stock", evidence_status: "verified" }, risk_status: "elevated", purchase_gate: "avoid_offer", distinctions: { identity_exact: true, condition: "new" } },
    ],
  };
  result = analyze({ ...input, counterfeit: artifact });
  assert.equal(result.verified_decision.selected_offer, "A");
  assert.ok(result.normalized_offers[1].requirement_failures.includes("counterfeit risk elevated"));

  artifact.assessments[0].risk_status = "unknown";
  artifact.assessments[0].purchase_gate = "research_more";
  result = analyze({ ...input, counterfeit: artifact });
  assert.equal(result.verified_decision.action, "research_more");

  for (const mutation of [
    (value) => { value.evaluated_at = "2026-08-22T18:00:00.000Z"; },
    (value) => { value.assessments[0].product_id = "other-watch"; },
    (value) => { value.assessments[0].seller = "Other Seller"; },
    (value) => { value.assessments[0].distinctions.identity_exact = false; },
  ]) {
    const changed = structuredClone(artifact);
    changed.assessments[0].risk_status = "low";
    changed.assessments[0].purchase_gate = "eligible_for_other_shopping_checks";
    mutation(changed);
    result = analyze({ ...input, counterfeit: changed });
    assert.equal(result.normalized_offers[0].counterfeit_risk_verified, false);
    assert.ok(result.normalized_offers[0].requirement_failures.includes("counterfeit risk unverified"));
  }
});

test("offer ranking uses signed authorization evidence and never trusts a raw seller flag", () => {
  const input = {
    requirements: { product_key: "watch", authorized_seller: true },
    offers: [
      { id: "A", product_key: "watch", seller: "Authorized Shop", authorized_seller: false, price_usd: 100, shipping_usd: 0, stock: "in_stock" },
      { id: "B", product_key: "watch", seller: "Gray Shop", authorized_seller: true, price_usd: 60, shipping_usd: 0, stock: "in_stock" },
    ],
    counterfeit: {
      evaluated_at: NOW,
      assessments: [
        { offer_id: "A", product_id: "watch", seller: "Authorized Shop", availability: { status: "in_stock", evidence_status: "verified" }, risk_status: "low", purchase_gate: "eligible_for_other_shopping_checks", authorization_requirement: { required: true, status: "satisfied", gate: "eligible_for_other_shopping_checks" }, distinctions: { identity_exact: true, condition: "new" } },
        { offer_id: "B", product_id: "watch", seller: "Gray Shop", availability: { status: "in_stock", evidence_status: "verified" }, risk_status: "acceptable", purchase_gate: "avoid_offer", authorization_requirement: { required: true, status: "failed", gate: "avoid_offer" }, requirement_failures: ["authorized_seller_required"], distinctions: { identity_exact: true, condition: "new" } },
      ],
    },
  };
  const result = analyze(input);
  assert.equal(result.verified_decision.selected_offer, "A");
  assert.deepEqual(result.normalized_offers[1].requirement_failures.filter((failure) => failure.includes("authorized seller")), ["authorized seller requirement failed"]);
  assert.ok(!result.normalized_offers[1].requirement_failures.includes("counterfeit risk elevated"));
  assert.equal(result.normalized_offers[1].counterfeit_risk_status, "acceptable");
});

test("offer ranking uses signed listing availability and ignores raw stock claims", () => {
  const input = {
    requirements: { product_key: "camera" },
    offers: [
      { id: "A", product_key: "camera", seller: "Store A", stock: "out_of_stock", price_usd: 100, shipping_usd: 0 },
      { id: "B", product_key: "camera", seller: "Store B", stock: "in_stock", price_usd: 50, shipping_usd: 0 },
    ],
    counterfeit: {
      evaluated_at: NOW,
      assessments: [
        { offer_id: "A", product_id: "camera", seller: "Store A", availability: { status: "in_stock", evidence_status: "verified" }, risk_status: "low", purchase_gate: "eligible_for_other_shopping_checks", distinctions: { identity_exact: true, condition: "new" } },
        { offer_id: "B", product_id: "camera", seller: "Store B", availability: { status: "out_of_stock", evidence_status: "verified" }, risk_status: "low", purchase_gate: "eligible_for_other_shopping_checks", distinctions: { identity_exact: true, condition: "new" } },
      ],
    },
  };
  let result = analyze(input);
  assert.equal(result.verified_decision.selected_offer, "A");
  assert.equal(result.normalized_offers[0].stock, "in_stock");
  assert.equal(result.normalized_offers[0].stock_verified, true);
  assert.ok(result.normalized_offers[1].requirement_failures.includes("not in stock"));

  input.counterfeit.assessments[0].availability = { status: "unknown", evidence_status: "unknown" };
  result = analyze(input);
  assert.equal(result.verified_decision.action, "research_more");
  assert.ok(result.normalized_offers[0].requirement_failures.includes("stock unverified"));
});

test("offer ranking cannot bypass merchant identity and payment-recourse gates", () => {
  const input = { requirements: { product_key: "console" }, offers: [
    { id: "A", product_key: "console", seller: "Established Store", price_usd: 500, shipping_usd: 0, stock: "in_stock" },
    { id: "B", product_key: "console", seller: "Wire Only Seller", price_usd: 350, shipping_usd: 0, stock: "in_stock" },
  ] };
  const merchant = { evaluated_at: NOW, assessments: [
    { id: "A", status: "verified_established", purchase_gate: "eligible_for_other_shopping_checks", roles: { seller: { name: "Established Store" }, merchant_of_record: { name: "Established Store" } } },
    { id: "B", status: "elevated", purchase_gate: "avoid_offer", roles: { seller: { name: "Wire Only Seller" }, merchant_of_record: { name: "Wire Only Seller" } } },
  ] };
  let result = analyze({ ...input, merchant });
  assert.equal(result.verified_decision.selected_offer, "A");
  assert.ok(result.normalized_offers[1].requirement_failures.includes("merchant trust rejected"));

  merchant.assessments[0].status = "unknown";
  merchant.assessments[0].purchase_gate = "research_more";
  result = analyze({ ...input, merchant });
  assert.equal(result.verified_decision.action, "research_more");

  merchant.assessments[0].status = "verified_established";
  merchant.assessments[0].purchase_gate = "eligible_for_other_shopping_checks";
  merchant.assessments[0].roles.seller.name = "Different Seller";
  result = analyze({ ...input, merchant });
  assert.equal(result.normalized_offers[0].merchant_trust_verified, false);
  assert.ok(result.normalized_offers[0].requirement_failures.includes("merchant trust unverified"));
});

test("offer ranking fails closed on exact-offer purchase protection", () => {
  const input = { requirements: { product_key: "camera" }, offers: [
    { id: "A", product_key: "camera", condition: "new", seller: "Returnable Shop", price_usd: 110, shipping_usd: 0, stock: "in_stock" },
    { id: "B", product_key: "camera", condition: "new", seller: "Final Sale Shop", price_usd: 80, shipping_usd: 0, stock: "in_stock" },
  ] };
  const protection = { evaluated_at: NOW, assessments: [
    { id: "A", product_id: "camera", condition: "new", seller: "Returnable Shop", status: "eligible", purchase_gate: "eligible_for_offer_analysis", deadlines: {} },
    { id: "B", product_id: "camera", condition: "new", seller: "Final Sale Shop", status: "rejected", purchase_gate: "avoid_offer", deadlines: {} },
  ] };
  let result = analyze({ ...input, protection });
  assert.equal(result.verified_decision.selected_offer, "A");
  assert.ok(result.normalized_offers[1].requirement_failures.includes("purchase protection rejected"));

  protection.assessments[0].status = "needs_research";
  protection.assessments[0].purchase_gate = "research_more";
  result = analyze({ ...input, protection });
  assert.equal(result.verified_decision.action, "research_more");

  protection.assessments[0].status = "eligible";
  protection.assessments[0].purchase_gate = "eligible_for_offer_analysis";
  protection.assessments[0].seller = "Other Shop";
  result = analyze({ ...input, protection });
  assert.equal(result.normalized_offers[0].purchase_protection_verified, false);
});

test("offer ranking requires fresh canonical exact-product identity", () => {
  const input = { requirements: { product_key: "phone-x" }, offers: [
    { id: "A", product_key: "phone-x", variant: "US-256-black", condition: "new", seller: "Phone Shop", price_usd: 900, shipping_usd: 0, stock: "in_stock" },
    { id: "B", product_key: "phone-x", variant: "US-256-black", condition: "new", seller: "Discount Shop", price_usd: 700, shipping_usd: 0, stock: "in_stock" },
  ] };
  const identity = { evaluated_at: NOW, target_product_id: "phone-x", resolutions: [
    { candidate_id: "A", offer_variant: "US-256-black", classification: "exact_match", safe_to_compare_offers: true, confidence: 1, canonical: { condition: "new" } },
    { candidate_id: "B", offer_variant: "UK-128-black", classification: "different_variant", safe_to_compare_offers: false, confidence: 1, canonical: { condition: "new" } },
  ] };
  let result = analyze({ ...input, identity });
  assert.equal(result.verified_decision.selected_offer, "A");
  assert.equal(result.normalized_offers[1].canonical_identity_verified, false);

  identity.resolutions[0].classification = "different_edition";
  identity.resolutions[0].safe_to_compare_offers = false;
  result = analyze({ ...input, identity });
  assert.equal(result.verified_decision.action, "research_more");

  identity.resolutions[0].classification = "exact_match";
  identity.resolutions[0].safe_to_compare_offers = true;
  identity.evaluated_at = "2026-08-22T18:00:00.000Z";
  result = analyze({ ...input, identity });
  assert.ok(result.normalized_offers[0].requirement_failures.includes("canonical product identity unverified"));
});

test("official recalls and certification failures override offer price", () => {
  const input = { requirements: { product_key: "kettle" }, offers: [
    { id: "A", product_key: "kettle", condition: "new", seller: "Safe Shop", price_usd: 80, shipping_usd: 0, stock: "in_stock" },
    { id: "B", product_key: "kettle", condition: "new", seller: "Recall Shop", price_usd: 40, shipping_usd: 0, stock: "in_stock" },
  ] };
  const safety = { evaluated_at: NOW, jurisdiction: "US", assessments: [
    { id: "A", product_key: "kettle", condition: "new", seller: "Safe Shop", action: "eligible", safety_cleared_for_ranking: true, purchase_allowed: false, warnings: [] },
    { id: "B", product_key: "kettle", condition: "new", seller: "Recall Shop", action: "avoid_product", safety_cleared_for_ranking: false, purchase_allowed: false, warnings: [] },
  ] };
  let result = analyze({ ...input, safety });
  assert.equal(result.verified_decision.selected_offer, "A");
  assert.ok(result.normalized_offers[1].requirement_failures.includes("official product safety blocked"));

  safety.assessments[0].action = "research_more";
  safety.assessments[0].safety_cleared_for_ranking = false;
  result = analyze({ ...input, safety });
  assert.equal(result.verified_decision.action, "research_more");

  safety.assessments[0].action = "eligible";
  safety.assessments[0].safety_cleared_for_ranking = true;
  safety.jurisdiction = "CA";
  result = analyze({ ...input, safety });
  assert.equal(result.normalized_offers[0].official_safety_verified, false);
});

test("overlapping landed-cost ranges clarify while a robust range winner may select", () => {
  const input = { requirements: { product_key: "monitor" }, offers: [
    { id: "A", product_key: "monitor", price_usd: 90, shipping_usd: 0, stock: "in_stock" },
    { id: "B", product_key: "monitor", price_usd: 95, shipping_usd: 0, stock: "in_stock" },
  ] };
  let result = analyze(input, { A: { low_usd: 100, expected_usd: 110, high_usd: 120 }, B: { low_usd: 105, expected_usd: 112, high_usd: 118 } });
  assert.equal(result.verified_decision.action, "clarify");
  assert.equal(result.verified_decision.reason, "fully_landed_cost_ranges_overlap");
  result = analyze(input, { A: { low_usd: 90, expected_usd: 95, high_usd: 100 }, B: { low_usd: 110, expected_usd: 115, high_usd: 120 } });
  assert.equal(result.verified_decision.selected_offer, "A");
  result = analyze({ ...input, allow_expected_landed_selection: true }, { A: { low_usd: 100, expected_usd: 110, high_usd: 120 }, B: { low_usd: 105, expected_usd: 112, high_usd: 118 } });
  assert.equal(result.verified_decision.selected_offer, "A");
});

test("production risk features keep price evidence separate from judgment", () => {
  const [result] = deriveShoppingRiskFeatures({
    authorized_market_median_usd: 100,
    offers: [{ id: "A", landed_total_usd: 60, authorized_seller: null }],
  });
  assert.equal(result.price_discount_pct_vs_authorized_median, 40);
  assert.deepEqual(result.evidence_flags, ["authorization_unknown", "extreme_price_anomaly"]);
  assert.equal("risk_level" in result, false);
});

test("production research features preserve verify-before-search precedence facts", () => {
  const result = deriveShoppingResearchFeatures({
    policy: { min_independent_sources: 2 },
    sources: ["Search snippet", "Retailer A"],
    offers: [{ id: "A", exact_product: true, stock_verified: false, stock_claims: ["in stock", "unavailable"] }],
  });
  assert.deepEqual(result.critical_unknown_offer_ids, ["A"]);
  assert.equal(result.independent_retailer_count, 1);
  assert.equal(result.source_coverage_sufficient, false);
});
