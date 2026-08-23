import assert from "node:assert/strict";
import test from "node:test";
import { assessShoppingProtection } from "../lib/shopping-protection.mjs";

const verifiedMoney = (expected_usd) => ({ expected_usd, evidence_status: "verified" });
const base = (id, overrides = {}) => ({
  id,
  product_id: "camera-x",
  condition: "new",
  seller: "Camera Shop",
  item_price_usd: 100,
  price_verified: true,
  shipping_usd: 5,
  shipping_verified: true,
  landed_total_usd: 105,
  landed_price_verified: true,
  seller_authorized: true,
  purchase_date: "2026-01-31T12:00:00.000Z",
  delivered_at: "2026-02-02T12:00:00.000Z",
  returns: { policy_verified: true, final_sale: false, window_days: 30, window_starts_on: "delivery", opened_items: "accepted", restocking_fee_percent: 0, return_shipping_paid_by: "seller", original_shipping_refundable: true },
  warranty: { policy_verified: true, provider: "manufacturer", duration_months: 12, authorized_seller_required: true, registration_required: false, parts_covered: true, labor_covered: true, deductible_usd: verifiedMoney(0), claim_shipping_paid_by: "provider", estimated_downtime_days_high: 7 },
  repairability: { evidence_verified: true, parts_availability: "widely_available", manual_availability: "official", critical_components_replaceable: true },
  buyer_protection: { window_days: 120 },
  ...overrides,
});

test("return exposure includes restocking, outbound shipping, and buyer-paid return shipping", () => {
  const candidate = base("a", { returns: { policy_verified: true, final_sale: false, window_days: 30, window_starts_on: "delivery", opened_items: "accepted", restocking_fee_percent: 15, return_shipping_paid_by: "buyer", return_shipping_cost_usd: { low_usd: 8, expected_usd: 10, high_usd: 12, evidence_status: "estimated" }, original_shipping_refundable: false } });
  const result = assessShoppingProtection({ candidates: [candidate] });
  assert.deepEqual(result.assessments[0].return_exposure.cost, { low_usd: 28, expected_usd: 30, high_usd: 32 });
});

test("final-sale and opened-item restrictions are hard failures when returns matter", () => {
  const result = assessShoppingProtection({ requirements: { returns_required: true, opened_returns_required: true }, candidates: [
    base("final", { returns: { ...base("x").returns, final_sale: true } }),
    base("sealed", { returns: { ...base("x").returns, opened_items: "not_accepted" } }),
  ] });
  assert.deepEqual(result.assessments[0].failures, ["final_sale"]);
  assert.deepEqual(result.assessments[1].failures, ["opened_returns_not_allowed"]);
});

test("manufacturer warranty can be invalidated by an unauthorized seller", () => {
  const result = assessShoppingProtection({ requirements: { warranty_required: true, manufacturer_warranty_required: true }, candidates: [base("gray", { seller_authorized: false })] });
  assert.equal(result.assessments[0].warranty_validity.status, "invalid");
  assert.ok(result.assessments[0].failures.includes("seller_not_authorized_for_warranty"));
});

test("warranty claim exposure includes deductible, shipping, and uncovered work", () => {
  const result = assessShoppingProtection({ candidates: [base("a", { warranty: { ...base("x").warranty, parts_covered: true, labor_covered: false, deductible_usd: verifiedMoney(25), claim_shipping_paid_by: "buyer", claim_shipping_cost_usd: verifiedMoney(10), uncovered_repair_cost_usd: { low_usd: 40, expected_usd: 60, high_usd: 80, evidence_status: "estimated" } } })] });
  assert.deepEqual(result.assessments[0].warranty_claim_exposure.cost, { low_usd: 75, expected_usd: 95, high_usd: 115 });
});

test("unknown return costs remain research items rather than zero", () => {
  const candidate = base("unknown", { returns: { ...base("x").returns, restocking_fee_percent: null, return_shipping_paid_by: "conditional", original_shipping_refundable: null } });
  const result = assessShoppingProtection({ requirements: { max_return_cost_usd: 20 }, candidates: [candidate, base("known")] });
  assert.equal(result.assessments[0].return_exposure.cost.high_usd, null);
  assert.equal(result.decision.action, "research_more");
  assert.ok(result.decision.research.some((item) => item.candidate_id === "unknown" && item.field === "returns:restocking_fee"));
});

test("a candidate that is no worse on every priority and better on one is selected", () => {
  const strong = base("strong", { returns: { ...base("x").returns, window_days: 45 }, warranty: { ...base("x").warranty, duration_months: 24, estimated_downtime_days_high: 4 }, buyer_protection: { window_days: 180 } });
  const standard = base("standard", { returns: { ...base("x").returns, window_days: 30, restocking_fee_percent: 10 }, warranty: { ...base("x").warranty, duration_months: 12, deductible_usd: verifiedMoney(20), estimated_downtime_days_high: 8 }, repairability: { evidence_verified: true, parts_availability: "manufacturer_only", manual_availability: "official", critical_components_replaceable: true }, buyer_protection: { window_days: 120 } });
  const priorities = ["return_window", "return_cost", "warranty_duration", "warranty_claim_cost", "repairability", "downtime", "buyer_protection"];
  const result = assessShoppingProtection({ priorities, candidates: [strong, standard] });
  assert.equal(result.decision.action, "select");
  assert.equal(result.decision.selected_candidate, "strong");
  assert.equal(result.decision.reason, "pareto_dominant_protection");
});

test("crossing return and warranty advantages require user priority", () => {
  const returnsWinner = base("returns", { returns: { ...base("x").returns, window_days: 60 }, warranty: { ...base("x").warranty, duration_months: 12 } });
  const warrantyWinner = base("warranty", { returns: { ...base("x").returns, window_days: 30 }, warranty: { ...base("x").warranty, duration_months: 36 } });
  const result = assessShoppingProtection({ priorities: ["return_window", "warranty_duration"], candidates: [returnsWinner, warrantyWinner] });
  assert.equal(result.decision.action, "clarify");
  assert.equal(result.decision.reason, "protection_tradeoffs_require_user_priority");
});

test("lexicographic mode follows the explicit priority order", () => {
  const result = assessShoppingProtection({ decision_mode: "lexicographic", priorities: ["warranty_duration", "return_window"], candidates: [
    base("returns", { returns: { ...base("x").returns, window_days: 60 }, warranty: { ...base("x").warranty, duration_months: 12 } }),
    base("warranty", { returns: { ...base("x").returns, window_days: 30 }, warranty: { ...base("x").warranty, duration_months: 36 } }),
  ] });
  assert.equal(result.decision.selected_candidate, "warranty");
  assert.equal(result.decision.decisive_priority, "warranty_duration");
});

test("calendar deadlines handle month ends and delivery-based return windows", () => {
  const result = assessShoppingProtection({ candidates: [base("a", { warranty: { ...base("x").warranty, duration_months: 1, registration_required: true, registration_deadline_days: 10 } })] });
  assert.equal(result.assessments[0].deadlines.return_deadline, "2026-03-04T12:00:00.000Z");
  assert.equal(result.assessments[0].deadlines.warranty_expiration, "2026-02-28T12:00:00.000Z");
  assert.equal(result.assessments[0].deadlines.warranty_registration_deadline, "2026-02-10T12:00:00.000Z");
  assert.equal(result.assessments[0].deadlines.buyer_protection_deadline, "2026-05-31T12:00:00.000Z");
});

test("repairability evidence distinguishes strong, moderate, weak, and unknown", () => {
  const result = assessShoppingProtection({ candidates: [
    base("strong"),
    base("moderate", { repairability: { evidence_verified: true, parts_availability: "manufacturer_only", manual_availability: "official", critical_components_replaceable: true } }),
    base("weak", { repairability: { evidence_verified: true, parts_availability: "unavailable", manual_availability: "none", critical_components_replaceable: false } }),
    base("unknown", { repairability: { evidence_verified: false } }),
  ] });
  assert.deepEqual(result.assessments.map((item) => item.repairability), ["strong", "moderate", "weak", "unknown"]);
});
