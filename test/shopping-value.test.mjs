import test from "node:test";
import assert from "node:assert/strict";
import { assessShoppingValue } from "../lib/shopping-value.mjs";

const verified = (value, source_id = "listing") => ({ value, evidence_status: "verified", source_id });
const base = {
  evaluated_at: "2026-08-22T20:00:00.000Z",
  basis: { id: "net-mass", source: "net_quantity", dimension: "mass", unit: "g", conditions_complete: true, conditions: {}, quality_equivalence_required: false },
  offers: [
    { id: "A", product_id: "coffee-x", variant_id: "whole-bean", exact_identity: true, captured_at: "2026-08-22T19:00:00.000Z", landed_total: verified(12), package: { pack_count: verified(1), net_quantity: { ...verified(12), unit: "oz" } } },
    { id: "B", product_id: "coffee-x", variant_id: "whole-bean", exact_identity: true, captured_at: "2026-08-22T19:00:00.000Z", landed_total: verified(28), package: { pack_count: verified(2), net_quantity: { ...verified(500), unit: "g" } } },
  ],
};

test("normalizes verified pack counts and compatible physical units", () => {
  const result = assessShoppingValue(base);
  assert.equal(result.action, "comparable");
  assert.equal(result.safe_for_value_ranking, true);
  assert.equal(result.assessments[0].normalized_quantity, 340.194277);
  assert.equal(result.assessments[1].normalized_quantity, 1000);
  assert.ok(result.assessments[1].landed_unit_cost_usd < result.assessments[0].landed_unit_cost_usd);
  assert.equal(result.selected_offer, null);
  assert.equal(result.purchase_allowed, false);
});

test("raw listing quantity cannot replace verified package and net quantity", () => {
  const input = structuredClone(base);
  input.offers[0].quantity = 24;
  delete input.offers[0].package.net_quantity.source_id;
  const result = assessShoppingValue(input);
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("A:net_quantity_unverified"));
  assert.equal(result.assessments[0].normalized_quantity, null);
});

test("mass and volume never convert implicitly", () => {
  const input = structuredClone(base);
  input.offers[0].package.net_quantity.unit = "ml";
  const result = assessShoppingValue(input);
  assert.ok(result.research.includes("A:quantity_unit_incompatible"));
});

test("usable-yield comparison requires one verified protocol and exact conditions", () => {
  const input = structuredClone(base);
  input.basis = { id: "laundry-loads", source: "usable_yield", dimension: "loads", unit: "load", conditions_complete: true, conditions: { load_kg: 4.5, soil: "normal", dose_mode: "label" }, quality_equivalence_required: false };
  input.offers = input.offers.map((offer, index) => ({ ...offer, usable_yield: { ...verified(index ? 64 : 32, "label-directions"), unit: "load", protocol_id: "brand-standard-load-v1", protocol_evidence_status: "verified", protocol_source_id: "label-directions", conditions_complete: true, conditions: { load_kg: 4.5, soil: "normal", dose_mode: "label" } } }));
  let result = assessShoppingValue(input);
  assert.equal(result.action, "comparable");
  input.offers[1].usable_yield.conditions.soil = "light";
  result = assessShoppingValue(input);
  assert.ok(result.research.includes("B:yield_conditions_incomparable"));
});

test("serving and dose claims are not interchangeable", () => {
  const input = structuredClone(base);
  input.basis = { id: "verified-servings", source: "usable_yield", dimension: "servings", unit: "serving", conditions_complete: true, conditions: { serving_definition: "manufacturer_label" }, quality_equivalence_required: false };
  input.offers[0].usable_yield = { ...verified(30), unit: "dose", protocol_id: "label", protocol_evidence_status: "verified", protocol_source_id: "label", conditions_complete: true, conditions: input.basis.conditions };
  const result = assessShoppingValue(input);
  assert.ok(result.research.includes("A:quantity_unit_incompatible"));
});

test("cross-product value ranking requires verified quality equivalence", () => {
  const input = structuredClone(base);
  input.basis.quality_equivalence_required = true;
  input.offers[0].quality_equivalent = { value: true, evidence_status: "estimated", source_id: "model-guess" };
  input.offers[1].quality_equivalent = verified(true, "verified-standard");
  const result = assessShoppingValue(input);
  assert.ok(result.research.includes("A:quality_equivalence_unverified"));
  assert.equal(result.safe_for_value_ranking, false);
});

test("detects package reduction plus unit-cost increase without calling it fraud", () => {
  const input = structuredClone(base);
  input.offers = [structuredClone(base.offers[0])];
  input.offers[0].landed_total = verified(12);
  input.offers[0].package.net_quantity = { ...verified(10), unit: "oz" };
  input.offers[0].prior_version = {
    product_id: "coffee-x", variant_id: "whole-bean", observed_at: "2026-01-01T00:00:00.000Z", evidence_status: "verified", source_id: "archived-package",
    landed_total: verified(11, "archived-price"), package: { pack_count: verified(1, "archived-package"), net_quantity: { ...verified(12, "archived-package"), unit: "oz" } },
  };
  const result = assessShoppingValue(input);
  assert.equal(result.action, "comparable");
  assert.equal(result.assessments[0].shrinkflation.package_reduced, true);
  assert.equal(result.assessments[0].shrinkflation.unit_cost_increased, true);
  assert.equal(result.assessments[0].shrinkflation.shrinkflation_signal, true);
});

test("stale prices and wrong prior-version scope abstain", () => {
  const input = structuredClone(base);
  input.offers[0].captured_at = "2025-01-01T00:00:00.000Z";
  input.offers[1].prior_version = { product_id: "other", variant_id: "whole-bean", observed_at: "2026-01-01T00:00:00.000Z", evidence_status: "verified", source_id: "history", landed_total: verified(20), package: structuredClone(input.offers[1].package) };
  const result = assessShoppingValue(input);
  assert.ok(result.research.includes("A:offer_value_evidence_stale_or_invalid"));
  assert.ok(result.research.includes("B:prior_version_scope_mismatch"));
});
