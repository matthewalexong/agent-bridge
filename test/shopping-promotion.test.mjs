import test from "node:test";
import assert from "node:assert/strict";
import { assessShoppingPromotion } from "../lib/shopping-promotion.mjs";

const NOW = "2026-08-22T20:00:30.000Z";
const evidence = (fields = {}) => ({ evidence_status: "verified", source_id: "checkout", ...fields });
const base = {
  evaluated_at: NOW,
  offer: {
    id: "offer-a", product_id: "product-a", exact_identity: true, captured_at: "2026-08-22T20:00:00.000Z",
    base_price: evidence({ value: 100 }), shipping: evidence({ value: 5 }),
    promotion_inventory_complete: true, promotion_inventory_evidence_status: "verified", promotion_inventory_source_id: "checkout",
    promotions: [],
  },
};

const coupon = (fields = {}) => ({
  id: "save20", type: "coupon", application_status: "applied", affects_advertised_price: true, amount_applied_usd: 20,
  eligibility_complete: true, eligibility: [], stacking: { verified: true, source_id: "checkout" }, obligations_complete: true, obligations: [],
  ...evidence(), ...fields,
});

test("only an applied, verified, exact-offer coupon reduces checkout cost", () => {
  const input = structuredClone(base);
  input.offer.promotions = [coupon()];
  const result = assessShoppingPromotion(input);
  assert.equal(result.action, "eligible");
  assert.equal(result.immediate_checkout_discount_usd, 20);
  assert.equal(result.checkout_landed_total_usd, 85);
  assert.equal(result.guaranteed_economic_cost_usd, 85);
  assert.deepEqual(result.included_promotion_ids, ["save20"]);
  assert.equal(result.purchase_allowed, false);
});

test("advertised or available coupons are not treated as applied discounts", () => {
  const input = structuredClone(base);
  input.offer.promotions = [coupon({ application_status: "available" })];
  const result = assessShoppingPromotion(input);
  assert.equal(result.action, "research_more");
  assert.equal(result.immediate_checkout_discount_usd, 0);
  assert.equal(result.checkout_landed_total_usd, null);
  assert.ok(result.excluded_promotions[0].reasons.includes("advertised_discount_not_applied"));
});

test("user-specific eligibility cannot be inferred by a model or listing", () => {
  const input = structuredClone(base);
  input.offer.promotions = [coupon({ eligibility: [evidence({ id: "student", status: "satisfied", user_specific: true, user_fact_source: "agent_inference" })] })];
  const result = assessShoppingPromotion(input);
  assert.equal(result.action, "research_more");
  assert.ok(result.excluded_promotions[0].reasons.includes("user_eligibility_inferred:student"));
});

test("cashback, rebates, points, gift cards, and financing never reduce checkout price", () => {
  const input = structuredClone(base);
  input.offer.promotions = [
    coupon({ id: "cash", type: "cashback", amount_applied_usd: undefined, deferred_value_usd: 25 }),
    coupon({ id: "points", type: "loyalty_points", amount_applied_usd: undefined, deferred_value_usd: 10 }),
    coupon({ id: "gift", type: "gift_card", amount_applied_usd: 50 }),
    coupon({ id: "finance", type: "financing", amount_applied_usd: 100 }),
  ];
  const result = assessShoppingPromotion(input);
  assert.equal(result.action, "eligible");
  assert.equal(result.immediate_checkout_discount_usd, 0);
  assert.equal(result.checkout_landed_total_usd, 105);
  assert.equal(result.deferred_value_usd, 35);
  assert.ok(result.warnings.includes("promotion:gift:gift_card_is_not_a_discount"));
  assert.ok(result.warnings.includes("promotion:finance:financing_is_not_a_discount"));
});

test("membership and subscription prices require fresh exact user acceptance", () => {
  const input = structuredClone(base);
  input.offer.promotions = [coupon({
    id: "member", type: "membership_price", obligations: [evidence({ id: "annual-plan", kind: "membership", status: "satisfied", user_acceptance_required: true, acceptance_source: "ui_default", accepted_at: "2026-08-22T20:00:20.000Z", incremental_cost_usd: 40, recurring: true })],
  })];
  let result = assessShoppingPromotion(input);
  assert.equal(result.action, "clarify");
  assert.equal(result.immediate_checkout_discount_usd, 0);
  input.offer.promotions[0].obligations[0].acceptance_source = "current_user_message";
  result = assessShoppingPromotion(input);
  assert.equal(result.action, "eligible");
  assert.equal(result.checkout_landed_total_usd, 85);
  assert.equal(result.required_incremental_cost_usd, 40);
  assert.equal(result.guaranteed_economic_cost_usd, 125);
});

test("multiple applied promotions need verified stacking evidence", () => {
  const input = structuredClone(base);
  input.offer.promotions = [coupon(), coupon({ id: "auto10", type: "automatic_discount", amount_applied_usd: 10, stacking: { verified: false } })];
  const result = assessShoppingPromotion(input);
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("promotion_stacking_unverified"));
  assert.equal(result.checkout_landed_total_usd, null);
});

test("expired and ineligible promotions are excluded without inventing savings", () => {
  const input = structuredClone(base);
  input.offer.promotions = [coupon({ application_status: "rejected", expires_at: "2026-08-21T20:00:00.000Z", eligibility: [evidence({ id: "member", status: "not_satisfied", user_specific: true, user_fact_source: "current_user_message" })] })];
  const result = assessShoppingPromotion(input);
  assert.equal(result.action, "eligible");
  assert.equal(result.immediate_checkout_discount_usd, 0);
  assert.equal(result.checkout_landed_total_usd, 105);
  assert.ok(result.excluded_promotions[0].reasons.includes("expired"));
  assert.ok(result.excluded_promotions[0].reasons.includes("ineligible:member"));
});
