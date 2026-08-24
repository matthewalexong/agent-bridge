import test from "node:test";
import assert from "node:assert/strict";
import { createShoppingRecommendationRegistry } from "../lib/shopping-recommendation-registry.mjs";

const NOW = Date.parse("2026-08-24T20:00:00.000Z");
const candidate = "listing_aaaaaaaaaaaaaaaa";
const dossier = (overrides = {}) => ({
  dossier_id: "dossier-ready",
  evaluated_at: new Date(NOW).toISOString(),
  phase: "product_recommendation",
  decision: { action: "recommend_product", selected_product: candidate, selected_offer: null, blockers: [], research: [], clarifications: [], purchase_allowed: false, model_override_allowed: false },
  ...overrides,
});

test("recommendation registry authorizes the exact cleared candidate", () => {
  const registry = createShoppingRecommendationRegistry({ now: () => NOW });
  const reference = registry.store(dossier());
  assert.match(reference.recommendation_id, /^shopping_recommendation_[a-f0-9]{32}$/);
  assert.equal(registry.authorize(reference, candidate), true);
  assert.throws(() => registry.authorize(reference, "listing_bbbbbbbbbbbbbbbb"), { code: "shopping_recommendation_reference_mismatch" });
});

test("recommendation registry issues no authority for unresolved or non-card decisions", () => {
  const registry = createShoppingRecommendationRegistry({ now: () => NOW });
  assert.equal(registry.store(dossier({ decision: { ...dossier().decision, action: "research_more", research: ["missing safety"] } })), null);
  assert.equal(registry.store(dossier({ decision: { ...dossier().decision, selected_product: "camera-x" } })), null);
  assert.equal(registry.store(dossier({ decision: { ...dossier().decision, purchase_allowed: true } })), null);
});

test("recommendation registry rejects alteration, expiry, and restart-like unknown references", () => {
  let clock = NOW;
  const registry = createShoppingRecommendationRegistry({ max_entries: 1, max_age_ms: 10_000, now: () => clock });
  const first = registry.store(dossier());
  assert.throws(() => registry.authorize({ ...first, dossier_id: "changed" }, candidate), { code: "shopping_recommendation_reference_mismatch" });
  clock += 10_001;
  assert.throws(() => registry.authorize(first, candidate), { code: "shopping_recommendation_reference_expired" });
  const fresh = createShoppingRecommendationRegistry({ now: () => NOW });
  assert.throws(() => fresh.authorize(first, candidate), { code: "shopping_recommendation_reference_unknown" });
});
