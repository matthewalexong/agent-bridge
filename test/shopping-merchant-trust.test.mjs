import assert from "node:assert/strict";
import test from "node:test";
import { assessMerchantTrust } from "../lib/shopping-merchant-trust.mjs";

const fact = (name, evidence_status = "verified") => ({ name, evidence_status });
const base = (overrides = {}) => ({
  id: "offer",
  channel: "marketplace",
  marketplace: fact("Market Hub"),
  seller: fact("Camera Shop"),
  legal_seller: fact("Camera Shop LLC"),
  fulfiller: fact("Market Hub"),
  merchant_of_record: fact("Camera Shop LLC"),
  payment_processor: fact("Market Payments"),
  return_recipient: { ...fact("Camera Shop Returns"), country: "US", address_verified: true },
  domain: { registrable_domain_verified: true, age_days: 2000, age_evidence_status: "verified", brand_domain_match: true },
  contact: { business_address_verified: true, email_domain_match: true, support_channel_verified: true },
  policies: { terms_available: true, privacy_available: true, return_policy_available: true, identity_consistent: true, checkout_consistent: true, return_terms_consistent: true },
  recourse: { payment_method: "credit_card", chargeback_eligible: true, marketplace_protection: true, buyer_protection_days: 120 },
  complaints: [],
  ...overrides,
});

test("marketplace, seller, fulfiller, merchant, and processor remain separate roles", () => {
  const result = assessMerchantTrust({ candidates: [base()] }).assessments[0];
  assert.equal(result.roles.marketplace.name, "Market Hub");
  assert.equal(result.roles.seller.name, "Camera Shop");
  assert.equal(result.roles.fulfiller.name, "Market Hub");
  assert.equal(result.roles.merchant_of_record.name, "Camera Shop LLC");
  assert.equal(result.roles.payment_processor.name, "Market Payments");
  assert.equal(result.role_relationships.seller_is_marketplace, false);
  assert.equal(result.role_relationships.seller_is_fulfiller, false);
  assert.equal(result.status, "verified_established");
});

test("platform fulfillment never becomes seller or merchant evidence", () => {
  const candidate = base({ seller: fact(null, "unknown"), legal_seller: fact(null, "unknown"), merchant_of_record: fact(null, "unknown"), fulfiller: fact("Market Hub") });
  const result = assessMerchantTrust({ candidates: [candidate] }).assessments[0];
  assert.equal(result.status, "unknown");
  assert.ok(result.critical_unknowns.includes("seller_identity"));
  assert.ok(result.critical_unknowns.includes("merchant_of_record"));
  assert.equal(result.purchase_gate, "research_more");
});

test("conflicting legal roles reject an offer without calling it fraud", () => {
  const result = assessMerchantTrust({ candidates: [base({ merchant_of_record: fact("Conflicting Company", "conflict") })] }).assessments[0];
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.failures, ["merchant_of_record_conflict"]);
  assert.equal(result.purchase_gate, "avoid_offer");
  assert.equal("fraud" in result, false);
});

test("irreversible payment is elevated and fails a reversible-payment requirement", () => {
  const candidate = base({ recourse: { payment_method: "crypto", chargeback_eligible: false, marketplace_protection: false } });
  const ordinary = assessMerchantTrust({ candidates: [candidate] }).assessments[0];
  assert.equal(ordinary.status, "elevated");
  assert.ok(ordinary.elevated_signals.includes("irreversible_payment_method"));
  const required = assessMerchantTrust({ requirements: { reversible_payment_required: true }, candidates: [candidate] }).assessments[0];
  assert.ok(required.failures.includes("reversible_payment_unavailable"));
});

test("a recent domain is only a weak signal when business identity is verified", () => {
  const candidate = base({ domain: { registrable_domain_verified: true, age_days: 5, age_evidence_status: "verified", brand_domain_match: true } });
  const result = assessMerchantTrust({ candidates: [candidate] }).assessments[0];
  assert.equal(result.status, "verified_established");
  assert.deepEqual(result.weak_signals, ["recent_domain"]);
  assert.equal(result.elevated_signals.length, 0);
});

test("recent domain plus unverified legal identity and address is a composite concern", () => {
  const candidate = base({ legal_seller: fact("Camera Shop LLC", "explicit"), domain: { registrable_domain_verified: true, age_days: 5, age_evidence_status: "verified", brand_domain_match: true }, contact: { business_address_verified: false, email_domain_match: true, support_channel_verified: true } });
  const result = assessMerchantTrust({ candidates: [candidate] }).assessments[0];
  assert.equal(result.status, "elevated");
  assert.ok(result.elevated_signals.includes("recent_domain_with_unverified_business_identity"));
});

test("one complaint or duplicated complaints cannot create a repeated pattern", () => {
  const complaint = { category: "non_delivery", source_id: "review-1", independence_key: "person-1", source_type: "customer_review", verified: true, resolved: false };
  const result = assessMerchantTrust({ candidates: [base({ complaints: [complaint, { ...complaint, source_id: "syndicated-copy" }] })] }).assessments[0];
  assert.equal(result.complaint_evidence.deduplicated, 1);
  assert.equal(result.complaint_evidence.repeated_patterns.length, 0);
  assert.equal(result.status, "verified_established");
});

test("three independent unresolved reports expose an allegation pattern with guardrail", () => {
  const complaints = [1, 2, 3].map((number) => ({ category: "refund_denial", source_id: `source-${number}`, independence_key: `person-${number}`, source_type: "customer_review", verified: true, resolved: false }));
  const result = assessMerchantTrust({ candidates: [base({ complaints })] }).assessments[0];
  assert.equal(result.status, "elevated");
  assert.deepEqual(result.elevated_signals, ["repeated_unresolved_refund_denial"]);
  assert.match(result.language_guardrail, /allegations, not findings/i);
});

test("search snippets and resolved reports do not establish an unresolved pattern", () => {
  const complaints = [
    { category: "non_delivery", source_id: "snippet", source_type: "search_snippet", verified: true, resolved: false },
    { category: "non_delivery", source_id: "one", source_type: "customer_review", verified: true, resolved: true },
    { category: "non_delivery", source_id: "two", source_type: "customer_review", verified: false, resolved: false },
  ];
  const result = assessMerchantTrust({ candidates: [base({ complaints })] }).assessments[0];
  assert.equal(result.complaint_evidence.usable, 1);
  assert.equal(result.complaint_evidence.unresolved, 0);
  assert.equal(result.status, "verified_established");
});

test("policy contradictions elevate even when the storefront looks established", () => {
  const result = assessMerchantTrust({ candidates: [base({ policies: { ...base().policies, checkout_consistent: false, return_terms_consistent: false } })] }).assessments[0];
  assert.equal(result.status, "elevated");
  assert.deepEqual(result.elevated_signals, ["checkout_terms_conflict", "return_terms_conflict"]);
});

test("return destination and country requirements are deterministic", () => {
  const requirements = { return_destination_required: true, allowed_return_countries: ["US"] };
  const unknown = assessMerchantTrust({ requirements, candidates: [base({ return_recipient: fact(null, "unknown") })] }).assessments[0];
  assert.ok(unknown.critical_unknowns.includes("return_destination"));
  assert.ok(unknown.critical_unknowns.includes("return_country"));
  const offshore = assessMerchantTrust({ requirements, candidates: [base({ return_recipient: { ...fact("Returns Center"), country: "CN", address_verified: true } })] }).assessments[0];
  assert.deepEqual(offshore.failures, ["return_country_not_allowed"]);
});

test("decision partitions eligible, research, and avoid offers but never selects", () => {
  const result = assessMerchantTrust({ candidates: [
    base({ id: "safe" }),
    base({ id: "unknown", seller: fact(null, "unknown") }),
    base({ id: "avoid", recourse: { payment_method: "wire_transfer", chargeback_eligible: false, marketplace_protection: false } }),
  ] });
  assert.deepEqual(result.decision.eligible_offer_ids, ["safe"]);
  assert.deepEqual(result.decision.research_offer_ids, ["unknown"]);
  assert.deepEqual(result.decision.avoid_offer_ids, ["avoid"]);
  assert.equal(result.decision.selects_offer, false);
});
