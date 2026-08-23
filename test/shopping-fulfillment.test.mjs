import assert from "node:assert/strict";
import test from "node:test";
import { assessShoppingFulfillment } from "../lib/shopping-fulfillment.mjs";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const amount = (amount_usd, evidence_status = "verified") => ({ treatment: "amount", amount_usd, evidence_status });
const zero = (kind, treatment = "not_applicable") => ({ kind, treatment, evidence_status: "verified" });
const offer = (overrides = {}) => ({
  id: "import-a", product_id: "camera-x", exact_identity: true, promotion_claimed: true, ships_from_country: "JP", destination_eligible: true,
  item_price: { amount_usd: 100, evidence_status: "verified" }, discount: { amount_usd: 10, evidence_status: "verified" },
  charges: [
    { kind: "shipping", ...amount(15) }, { kind: "tax", ...amount(8) }, { kind: "import_duty", ...amount(5) },
    { kind: "brokerage", ...amount(3) }, zero("carrier_surcharge"), { kind: "currency_conversion", ...amount(2) },
  ],
  incoterm: "DAP", incoterm_evidence_status: "verified",
  customs: { restricted_or_prohibited: false, clearance_responsibility: "buyer", documents_complete: true },
  delivery: { earliest_at: "2026-08-28T00:00:00.000Z", latest_at: "2026-09-02T00:00:00.000Z", evidence_status: "verified", tracking_available: true },
  returns: { policy_verified: true, destination_country: "JP", shipping_paid_by: "buyer", shipping_cost: { low_usd: 20, expected_usd: 25, high_usd: 30, evidence_status: "estimated" }, refundable_import_charges: false },
  ...overrides,
});
const promotion = (overrides = {}) => attestShoppingArtifact("promotion", { offer_id: "import-a", product_id: "camera-x", evaluated_at: NOW, action: "eligible", pricing_cleared: true, base_price_usd: 100, shipping_usd: 15, immediate_checkout_discount_usd: 10, checkout_landed_total_usd: 105, deferred_value_usd: 0, required_incremental_cost_usd: 0, guaranteed_economic_cost_usd: 105, purchase_allowed: false, ...overrides });
const assess = (candidate = offer(), requirements = {}, promotion_artifacts = [promotion()]) => assessShoppingFulfillment({ evaluated_at: NOW, destination_country: "US", requirements, offers: [candidate], promotion_artifacts }).assessments[0];

test("cross-border ledger calculates every acquisition charge without hiding return exposure", () => {
  const result = assess();
  assert.equal(result.action, "eligible");
  assert.deepEqual(result.fully_landed_total_usd, { low_usd: 123, expected_usd: 123, high_usd: 123 });
  assert.equal(result.cross_border, true);
  assert.equal(result.return_exposure.shipping_cost_usd.high_usd, 30);
  assert.equal(result.purchase_allowed, false);
});

test("missing duty and brokerage never become zero", () => {
  const candidate = offer({ charges: offer().charges.filter((item) => !["import_duty", "brokerage"].includes(item.kind)) });
  const result = assess(candidate);
  assert.equal(result.action, "research_more");
  assert.equal(result.fully_landed_total_usd, null);
  assert.ok(result.research.includes("charges:import_duty"));
  assert.ok(result.research.includes("charges:brokerage"));
});

test("included wording only zeroes a charge with verified evidence", () => {
  const candidate = offer();
  candidate.charges = candidate.charges.map((item) => item.kind === "import_duty" ? { kind: "import_duty", treatment: "included", evidence_status: "estimated" } : item);
  assert.ok(assess(candidate).research.includes("charges:import_duty"));
  candidate.charges = candidate.charges.map((item) => item.kind === "import_duty" ? { ...item, evidence_status: "verified" } : item);
  assert.equal(assess(candidate).fully_landed_total_usd.expected_usd, 118);
});

test("estimated charge ranges propagate conservatively", () => {
  const candidate = offer();
  candidate.charges = candidate.charges.map((item) => item.kind === "tax" ? { kind: "tax", treatment: "amount", low_usd: 6, expected_usd: 8, high_usd: 11, evidence_status: "estimated" } : item);
  const result = assess(candidate);
  assert.deepEqual(result.fully_landed_total_usd, { low_usd: 121, expected_usd: 123, high_usd: 126 });
  assert.equal(result.fully_landed_status, "estimated");
  assert.equal(result.action, "eligible");
});

test("a total range crossing the budget requires clarification", () => {
  const candidate = offer();
  candidate.charges = candidate.charges.map((item) => item.kind === "tax" ? { kind: "tax", treatment: "amount", low_usd: 6, expected_usd: 8, high_usd: 14, evidence_status: "estimated" } : item);
  const result = assess(candidate, { max_fully_landed_usd: 125 });
  assert.equal(result.action, "clarify");
  assert.deepEqual(result.clarifications, ["cost:range_crosses_budget"]);
});

test("a minimum total above budget rejects the offer", () => {
  const result = assess(offer(), { max_fully_landed_usd: 120 });
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("cost:minimum_exceeds_budget"));
});

test("strict under-budget semantics reject equality without weakening it to less-than-or-equal", () => {
  assert.equal(assess(offer(), { max_fully_landed_usd: 123, max_fully_landed_operator: "lte" }).action, "eligible");
  const strict = assess(offer(), { max_fully_landed_usd: 123, max_fully_landed_operator: "lt" });
  assert.equal(strict.action, "avoid_offer");
  assert.ok(strict.blockers.includes("cost:minimum_exceeds_budget"));
});

test("customs restrictions dominate a complete attractive price", () => {
  const candidate = offer({ customs: { restricted_or_prohibited: true, clearance_responsibility: "seller", documents_complete: true } });
  const result = assess(candidate);
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("customs:restricted_or_prohibited"));
});

test("unknown incoterm, customs responsibility, and documents remain research", () => {
  const result = assess(offer({ incoterm: "unknown", incoterm_evidence_status: "unknown", customs: { restricted_or_prohibited: null, clearance_responsibility: "unknown", documents_complete: null } }));
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("customs:incoterm"));
  assert.ok(result.research.includes("customs:clearance_responsibility"));
  assert.ok(result.research.includes("customs:documents_complete"));
});

test("delivery definitely after a required date rejects while an overlapping window clarifies", () => {
  let result = assess(offer(), { required_by: "2026-08-27T00:00:00.000Z" });
  assert.ok(result.blockers.includes("delivery:misses_required_date"));
  result = assess(offer(), { required_by: "2026-08-30T00:00:00.000Z" });
  assert.deepEqual(result.clarifications, ["delivery:window_crosses_required_date"]);
});

test("tracking and return geography can be hard requirements", () => {
  const candidate = offer({ delivery: { ...offer().delivery, tracking_available: false } });
  const result = assess(candidate, { require_tracking: true, require_verified_return_destination: true, allowed_return_countries: ["US", "CA"] });
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("delivery:tracking_unavailable"));
  assert.ok(result.blockers.includes("returns:country_not_allowed"));
});

test("domestic offers still require explicit not-applicable import charges", () => {
  const candidate = offer({ ships_from_country: "US", incoterm: "unknown", incoterm_evidence_status: "unknown", customs: {} });
  candidate.charges = candidate.charges.map((item) => ["import_duty", "brokerage", "currency_conversion"].includes(item.kind) ? zero(item.kind) : item);
  const result = assess(candidate);
  assert.equal(result.action, "eligible");
  assert.equal(result.cross_border, false);
});

test("duplicate components and incoherent ranges are rejected", () => {
  const candidate = offer();
  candidate.charges.push({ kind: "tax", ...amount(1) });
  candidate.item_price = { low_usd: 100, expected_usd: 90, high_usd: 110, evidence_status: "estimated" };
  const result = assess(candidate);
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("charges:tax:duplicate"));
  assert.ok(result.blockers.includes("item_price:invalid_range"));
});

test("raw discount evidence cannot bypass promotion eligibility", () => {
  const result = assess(offer(), {}, []);
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("promotion:artifact_required_or_invalid"));
  assert.equal(result.fully_landed_total_usd.expected_usd, 133);
  assert.equal(result.safe_for_offer_comparison, false);
});

test("verified promotion obligations enter fully landed economic cost", () => {
  const artifact = promotion({ required_incremental_cost_usd: 20, guaranteed_economic_cost_usd: 125 });
  const result = assess(offer(), {}, [artifact]);
  assert.equal(result.action, "eligible");
  assert.equal(result.fully_landed_total_usd.expected_usd, 143);
  assert.equal(result.components.promotion_obligation.expected_usd, 20);
  assert.equal(result.promotion.immediate_checkout_discount_usd, 10);
});
