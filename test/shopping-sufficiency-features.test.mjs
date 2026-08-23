import test from "node:test";
import assert from "node:assert/strict";
import { deriveSufficiencyFeatures } from "../eval/shopping/sufficiency/lib/state-features.mjs";

test("sufficiency features distinguish exact identity from availability", () => {
  const got = deriveSufficiencyFeatures({
    policy: { min_independent_sources: 2 },
    sources: ["Retailer A", "Retailer B"],
    offers: [
      { id: "A", exact_product: true, stock_verified: true, in_stock: false },
      { id: "B", exact_product: true, stock_verified: true, in_stock: false },
    ],
  });
  assert.deepEqual(got.exact_offer_ids, ["A", "B"]);
  assert.equal(got.all_exact_offers_verified_unavailable, true);
  assert.equal(got.source_coverage_sufficient, true);
});

test("search snippets do not satisfy independent-retailer coverage", () => {
  const got = deriveSufficiencyFeatures({
    policy: { min_independent_sources: 2 },
    sources: ["Search snippet", "Retailer A"],
    offers: [{ id: "A", exact_product: true, stock_verified: false }],
  });
  assert.equal(got.independent_retailer_count, 1);
  assert.equal(got.source_coverage_sufficient, false);
  assert.deepEqual(got.critical_unknown_offer_ids, ["A"]);
});

test("critical unknowns preserve the offer id the main brain should verify", () => {
  const got = deriveSufficiencyFeatures({
    policy: { min_independent_sources: 2 },
    sources: ["Retailer A", "Retailer B"],
    offers: [
      { id: "A", exact_product: true, stock_verified: true },
      { id: "B", exact_product: true, stock_verified: true, unknown_fields: ["pack quantity"] },
    ],
  });
  assert.deepEqual(got.critical_unknown_offer_ids, ["B"]);
});
