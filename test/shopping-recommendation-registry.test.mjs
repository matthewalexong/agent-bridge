import test from "node:test";
import assert from "node:assert/strict";
import { createShoppingRecommendationRegistry } from "../lib/shopping-recommendation-registry.mjs";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";

const NOW = Date.parse("2026-08-24T20:00:00.000Z");
const candidate = "listing_aaaaaaaaaaaaaaaa";
const candidateSet = "cset_aaaaaaaaaaaaaaaaaaaaaaaa";
const contextId = "shopping_context_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const candidateOffers = (candidate_id = candidate, price = 99) => {
  const listing_evidence = attestShoppingArtifact("page_evidence", {
    source: { url: `https://shop.example/${candidate_id}`, page_kind: "retailer_listing", captured_at: new Date(NOW).toISOString() },
    facts: { price_usd: { value: price, status: "explicit" }, seller: { value: "Exact Shop", status: "explicit" }, stock: { value: "in_stock", status: "explicit" } },
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
  assert.equal(registry.authorize(reference, candidate, binding), true);
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
