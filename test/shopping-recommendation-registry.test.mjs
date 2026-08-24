import test from "node:test";
import assert from "node:assert/strict";
import { appendShoppingRecommendationSummary, createShoppingRecommendationRegistry, formatShoppingRecommendationSummary, shoppingRecommendationCardDetails, shoppingRecommendationEvidenceCards } from "../lib/shopping-recommendation-registry.mjs";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";

const NOW = Date.parse("2026-08-24T20:00:00.000Z");
const candidate = "listing_aaaaaaaaaaaaaaaa";
const candidateSet = "cset_aaaaaaaaaaaaaaaaaaaaaaaa";
const contextId = "shopping_context_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const candidateOffers = (candidate_id = candidate, price = 99, factOverrides = {}) => {
  const listing_evidence = attestShoppingArtifact("page_evidence", {
    source: { url: `https://shop.example/${candidate_id}`, page_kind: "retailer_listing", captured_at: new Date(NOW).toISOString() },
    facts: { price_usd: { value: price, status: "explicit" }, seller: { value: "Exact Shop", status: "explicit" }, stock: { value: "in_stock", status: "explicit" }, ...factOverrides },
  });
  return attestShoppingArtifact("candidate_offers", {
    candidate_set_id: candidateSet,
    evaluated_at: new Date(NOW).toISOString(),
    offers: [{ candidate_id, listing_evidence }],
  });
};
const dossier = (overrides = {}) => ({
  dossier_id: "dossier-ready",
  decision_context_id: contextId,
  evaluated_at: new Date(NOW).toISOString(),
  phase: "product_recommendation",
  decision: { action: "recommend_product", selected_product: candidate, selected_offer: null, blockers: [], research: [], clarifications: [], purchase_allowed: false, model_override_allowed: false },
  ...overrides,
});

test("recommendation registry authorizes the exact cleared candidate", () => {
  const registry = createShoppingRecommendationRegistry({ now: () => NOW });
  const offers = candidateOffers();
  registry.bindCandidateOffers(contextId, offers);
  const reference = registry.store(dossier());
  assert.match(reference.recommendation_id, /^shopping_recommendation_[a-f0-9]{32}$/);
  const binding = { candidate_set_id: candidateSet, candidate_id: candidate, evidence_attestation: offers.offers[0].listing_evidence.artifact_attestation, candidate_offers_attestation: offers.artifact_attestation };
  assert.deepEqual(registry.authorize(reference, candidate, binding), {
    candidate_id: candidate,
    landed_total_usd: null,
    landed_total_range_usd: null,
    landed_total_status: "unknown",
    item_price_usd: 99,
    seller: "Exact Shop",
    stock: "in_stock",
    exact_identity: false,
    safety_cleared: false,
    counterfeit_risk: null,
    seller_authorization_verified: false,
    protection_requirements_met: false,
    return_window_days: null,
    warranty_duration_months: null,
    buyer_protection_days: null,
    delivery_earliest_at: null,
    delivery_latest_at: null,
    tracking_available: null,
    cost_breakdown: [],
    evidence_links: [],
  });
  assert.throws(() => registry.authorize(reference, "listing_bbbbbbbbbbbbbbbb", binding), { code: "shopping_recommendation_reference_mismatch" });
});

test("recommendation registry issues no authority for unresolved or non-card decisions", () => {
  const registry = createShoppingRecommendationRegistry({ now: () => NOW });
  registry.bindCandidateOffers(contextId, candidateOffers());
  assert.equal(registry.store(dossier({ decision: { ...dossier().decision, action: "research_more", research: ["missing safety"] } })), null);
  assert.equal(registry.store(dossier({ decision: { ...dossier().decision, selected_product: "camera-x" } })), null);
  assert.equal(registry.store(dossier({ decision: { ...dossier().decision, purchase_allowed: true } })), null);
});

test("recommendation registry rejects alteration, expiry, and restart-like unknown references", () => {
  let clock = NOW;
  const registry = createShoppingRecommendationRegistry({ max_entries: 1, max_age_ms: 10_000, now: () => clock });
  const offers = candidateOffers();
  registry.bindCandidateOffers(contextId, offers);
  const first = registry.store(dossier());
  const binding = { candidate_set_id: candidateSet, candidate_id: candidate, evidence_attestation: offers.offers[0].listing_evidence.artifact_attestation, candidate_offers_attestation: offers.artifact_attestation };
  assert.throws(() => registry.authorize({ ...first, dossier_id: "changed" }, candidate, binding), { code: "shopping_recommendation_reference_mismatch" });
  clock += 10_001;
  assert.throws(() => registry.authorize(first, candidate, binding), { code: "shopping_recommendation_reference_expired" });
  const fresh = createShoppingRecommendationRegistry({ now: () => NOW });
  assert.throws(() => fresh.authorize(first, candidate, binding), { code: "shopping_recommendation_reference_unknown" });
});

test("recommendation registry rejects a rehydrated card and mixed offer evidence", () => {
  const registry = createShoppingRecommendationRegistry({ now: () => NOW });
  const offers = candidateOffers(candidate, 99);
  registry.bindCandidateOffers(contextId, offers);
  const reference = registry.store(dossier());
  const changed = candidateOffers(candidate, 79);
  assert.throws(() => registry.bindCandidateOffers(contextId, changed), { code: "shopping_recommendation_offer_binding_conflict" });
  assert.throws(() => registry.authorize(reference, candidate, {
    candidate_set_id: candidateSet,
    candidate_id: candidate,
    evidence_attestation: changed.offers[0].listing_evidence.artifact_attestation,
    candidate_offers_attestation: changed.artifact_attestation,
  }), { code: "shopping_recommendation_card_evidence_mismatch" });
});

test("recommendation registry issues no verified authority without exact offer evidence", () => {
  const registry = createShoppingRecommendationRegistry({ now: () => NOW });
  assert.equal(registry.store(dossier()), null);
});

test("verified card authority requires signed price, seller, and in-stock availability", () => {
  for (const facts of [
    { price_usd: { value: null, status: "unknown" } },
    { seller: { value: null, status: "unknown" } },
    { stock: { value: "unknown", status: "unknown" } },
    { stock: { value: "out_of_stock", status: "explicit" } },
  ]) {
    const registry = createShoppingRecommendationRegistry({ now: () => NOW });
    registry.bindCandidateOffers(contextId, candidateOffers(candidate, 99, facts));
    assert.equal(registry.store(dossier()), null);
  }
});

test("verified recommendation summaries expose only process-derived decisive facts", () => {
  const registry = createShoppingRecommendationRegistry({ now: () => NOW });
  const offers = candidateOffers();
  registry.bindCandidateOffers(contextId, offers);
  const reference = registry.store(dossier(), {
    offer: { landed_price_verified: true, landed_total_usd: 106, stock: "in_stock" },
    identity: { classification: "exact_match", safe_to_compare_offers: true },
    counterfeit: { risk_status: "low", authorization_requirement_status: "satisfied" },
    protection: { status: "eligible", return_window_days: 30, warranty_duration_months: 12, buyer_protection_days: 60, evidence_links: [
      { kind: "return_policy", url: "https://shop.example/returns" }, { kind: "warranty", url: "https://maker.example/warranty" },
    ] },
    fulfillment: { fully_landed_total_usd: { low_usd: 106, expected_usd: 106, high_usd: 106 }, fully_landed_status: "verified", delivery_earliest_at: "2026-08-28T00:00:00.000Z", delivery_latest_at: "2026-08-30T00:00:00.000Z", tracking_available: true, cost_breakdown: [{ kind: "item_price", amount_usd: 99 }, { kind: "shipping", amount_usd: 7 }, { kind: "immediate_discount", amount_usd: 0 }], evidence_links: [] },
    safety: { action: "eligible", safety_cleared_for_ranking: true, evidence_links: [{ kind: "safety_authority", url: "https://regulator.example/search" }] },
  });
  const summary = registry.authorize(reference, candidate, {
    candidate_set_id: candidateSet,
    candidate_id: candidate,
    evidence_attestation: offers.offers[0].listing_evidence.artifact_attestation,
    candidate_offers_attestation: offers.artifact_attestation,
  });
  assert.equal(formatShoppingRecommendationSummary([summary]), "Verified details: $106.00 landed total · sold by Exact Shop · in stock · delivery Aug 28–Aug 30 · 30-day returns · 12-month warranty · 60-day buyer protection · tracking available · exact identity matched · safety checks cleared · counterfeit risk low · seller authorization verified");
  assert.equal(appendShoppingRecommendationSummary("My pick.", [summary]), `My pick.\n\n${formatShoppingRecommendationSummary([summary])}`);
  assert.deepEqual(shoppingRecommendationCardDetails(summary), {
    verification: "Verified pick",
    landed_total: "$106.00",
    landed_total_label: "Landed total",
    delivery: "Delivery Aug 28–Aug 30",
    cost_breakdown: [{ label: "Item", amount: "$99.00" }, { label: "Shipping", amount: "$7.00" }],
    protections: ["30-day returns", "12-month warranty", "60-day buyer protection"],
    checks: ["Exact item", "Safety checked", "Authorized seller"],
  });
  assert.deepEqual(shoppingRecommendationEvidenceCards([summary]), [
    { url: "https://regulator.example/search", title: "Evidence · Official safety search" },
    { url: "https://shop.example/returns", title: "Evidence · Return policy" },
    { url: "https://maker.example/warranty", title: "Evidence · Warranty policy" },
  ]);
  const estimated = { ...summary, landed_total_usd: null, landed_total_range_usd: { low_usd: 101, expected_usd: 104, high_usd: 108 }, landed_total_status: "estimated", cost_breakdown: [] };
  assert.match(formatShoppingRecommendationSummary([estimated]), /^Verified details: \$101\.00–\$108\.00 estimated landed total/);
  assert.deepEqual(shoppingRecommendationCardDetails(estimated), {
    verification: "Verified pick",
    landed_total: "$101.00–$108.00",
    landed_total_label: "Estimated landed range",
    delivery: "Delivery Aug 28–Aug 30",
    protections: ["30-day returns", "12-month warranty", "60-day buyer protection"],
    checks: ["Exact item", "Safety checked", "Authorized seller"],
  });
  const bounded = appendShoppingRecommendationSummary("x".repeat(30), [summary], 80);
  assert.ok(bounded.length <= 80);
  assert.match(bounded, /^Verified details: .*…$/);
});
