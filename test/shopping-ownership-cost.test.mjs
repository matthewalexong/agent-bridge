import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOwnershipCosts } from "../lib/shopping-ownership-cost.mjs";

const verified = (expected) => ({ expected, evidence_status: "verified" });
const estimated = (low, high, expected = (low + high) / 2) => ({ low, high, expected, evidence_status: "estimated" });
const unknown = () => ({ evidence_status: "unknown" });
const candidate = (id, acquisition, extra = {}) => ({ id, identity_verified: true, acquisition_usd: acquisition, ...extra });

test("a cheap device with a required subscription can lose on ownership cost", () => {
  const result = analyzeOwnershipCosts({ horizon_months: 36, candidates: [
    candidate("cheap-upfront", verified(100), { cost_components: [{ name: "Required cloud plan", category: "subscription", kind: "recurring", amount_usd: verified(10), interval_months: 1, start_month: 1 }] }),
    candidate("no-subscription", verified(300)),
  ] });
  assert.equal(result.candidates[0].nominal_total.expected_usd, 460);
  assert.equal(result.decision.action, "select");
  assert.equal(result.decision.selected_candidate, "no-subscription");
});

test("consumable usage is multiplied deterministically over the horizon", () => {
  const result = analyzeOwnershipCosts({ horizon_months: 24, candidates: [
    candidate("printer", verified(100), { consumables: [{ name: "Ink", unit_cost_usd: verified(20), units_per_month: verified(0.5) }] }),
  ] });
  assert.equal(result.candidates[0].nominal_total.expected_usd, 340);
  assert.equal(result.candidates[0].breakdown.find((item) => item.name === "Ink").nominal.expected_usd, 240);
});

test("energy cost uses power, daily use, annual days, and utility rate", () => {
  const result = analyzeOwnershipCosts({ horizon_months: 12, candidates: [
    candidate("heater", verified(100), { energy: [{ name: "Electricity", power_watts: verified(1000), hours_per_day: verified(2), days_per_year: verified(365), electricity_rate_usd_per_kwh: verified(0.2) }] }),
  ] });
  assert.equal(result.candidates[0].breakdown.find((item) => item.category === "energy").nominal.expected_usd, 146);
  assert.equal(result.candidates[0].nominal_total.expected_usd, 246);
});

test("unknown included costs remain unbounded and trigger targeted research", () => {
  const result = analyzeOwnershipCosts({ horizon_months: 36, candidates: [
    candidate("unknown-plan", verified(100), { cost_components: [{ name: "Required service", category: "subscription", kind: "recurring", amount_usd: unknown(), interval_months: 1 }] }),
    candidate("known", verified(300)),
  ] });
  const first = result.candidates[0];
  assert.equal(first.nominal_total.high_usd, null);
  assert.deepEqual(first.critical_unknowns, ["component:Required service"]);
  assert.equal(result.decision.action, "research_more");
  assert.deepEqual(result.decision.research, [{ candidate_id: "unknown-plan", field: "component:Required service" }]);
});

test("an unknown cost cannot block a winner it cannot possibly beat", () => {
  const result = analyzeOwnershipCosts({ candidates: [
    candidate("winner", verified(100)),
    candidate("expensive", verified(500), { cost_components: [{ name: "Unknown upkeep", category: "maintenance", kind: "recurring", amount_usd: unknown() }] }),
  ] });
  assert.equal(result.decision.action, "select");
  assert.equal(result.decision.selected_candidate, "winner");
});

test("verified residual value is a benefit while an unknown benefit is ignored conservatively", () => {
  const verifiedResidual = analyzeOwnershipCosts({ candidates: [
    candidate("resale", verified(500), { residual_value_usd: verified(200) }),
    candidate("discard", verified(350)),
  ] });
  assert.equal(verifiedResidual.candidates[0].nominal_total.expected_usd, 300);
  assert.equal(verifiedResidual.decision.selected_candidate, "resale");

  const unknownResidual = analyzeOwnershipCosts({ candidates: [candidate("a", verified(500), { residual_value_usd: unknown() })] });
  assert.equal(unknownResidual.candidates[0].nominal_total.expected_usd, 500);
  assert.ok(unknownResidual.candidates[0].warnings.includes("residual_value:ignored_unverified_benefit"));
});

test("overlapping estimated ranges do not become a confident winner by default", () => {
  const input = { candidates: [candidate("a", estimated(200, 400, 250)), candidate("b", estimated(220, 380, 300))] };
  const conservative = analyzeOwnershipCosts(input);
  const expectedAllowed = analyzeOwnershipCosts({ ...input, allow_expected_value_selection: true });
  assert.equal(conservative.decision.action, "clarify");
  assert.equal(conservative.decision.reason, "ownership_cost_ranges_overlap");
  assert.equal(conservative.decision.expected_leader, "a");
  assert.equal(expectedAllowed.decision.action, "select");
  assert.equal(expectedAllowed.decision.selected_candidate, "a");
  assert.equal(expectedAllowed.decision.uncertainty_ranges_overlap, true);
});

test("present value discounts future costs without changing nominal disclosure", () => {
  const result = analyzeOwnershipCosts({ horizon_months: 24, annual_discount_rate_percent: 12, decision_basis: "present_value", candidates: [
    candidate("subscription", verified(0), { cost_components: [{ name: "Plan", category: "subscription", kind: "recurring", amount_usd: verified(10), interval_months: 1, start_month: 1 }] }),
  ] });
  assert.equal(result.candidates[0].nominal_total.expected_usd, 240);
  assert.ok(result.candidates[0].present_value_total.expected_usd < 240);
  assert.equal(result.decision.basis, "present_value");
});

test("excluded optional components are disclosed but do not enter totals", () => {
  const result = analyzeOwnershipCosts({ candidates: [
    candidate("a", verified(100), { cost_components: [{ name: "Premium support", category: "subscription", kind: "recurring", amount_usd: verified(50), included: false }] }),
  ] });
  assert.equal(result.candidates[0].nominal_total.expected_usd, 100);
  assert.deepEqual(result.candidates[0].excluded_optional_components, ["Premium support"]);
});

test("unverified candidate identity is a decision-relevant unknown", () => {
  const result = analyzeOwnershipCosts({ candidates: [
    { ...candidate("unknown-id", verified(50)), identity_verified: false },
    candidate("known", verified(100)),
  ] });
  assert.equal(result.decision.action, "research_more");
  assert.deepEqual(result.decision.research, [{ candidate_id: "unknown-id", field: "identity" }]);
});
