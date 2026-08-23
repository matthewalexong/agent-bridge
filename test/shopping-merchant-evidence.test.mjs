import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedShoppingPageEvidence } from "../lib/shopping-browser-evidence.mjs";
import { assessMerchantTrustFromEvidence } from "../lib/shopping-merchant-evidence.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

function page(id, text, page_kind) {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 9, captured_at: NOW, snapshot: {
    snapshotId: id,
    title: id,
    url: `https://merchant.example/${id}`,
    text,
    truncated: false,
  } });
  return extractBrowserObservedShoppingPageEvidence(registry.resolve, { snapshot_id: id, evaluated_at: NOW, page_kind });
}

const listing = () => page("merchant-listing", "Sold by: Acme Camera\nFulfilled by: Acme Logistics\n30-day returns", "retailer_listing");
const terms = () => page("merchant-terms", "Terms and Conditions\nLegal seller: Acme Camera LLC\nMerchant of record: Acme Camera LLC\nPayment method: credit card\nChargebacks: available", "merchant_terms");
const privacy = () => page("merchant-privacy", "Privacy Policy\nThis policy explains personal information we collect.", "merchant_privacy");
const returns = () => page("merchant-returns", "Return Policy\n30-day returns\nReturns sent to: Acme Returns Center", "return_policy");
const checkout = () => page("merchant-checkout", "Order Summary\nMerchant of record: Acme Camera LLC\nPayment method: credit card", "checkout");

test("merchant trust derives roles, policies, and reversible payment only from signed pages", () => {
  const result = assessMerchantTrustFromEvidence({
    evaluated_at: NOW,
    requirements: { verified_legal_seller_required: true, reversible_payment_required: true },
    candidates: [{ id: "offer-a", listing_evidence: listing(), terms_evidence: terms(), privacy_evidence: privacy(), return_policy_evidence: returns(), checkout_evidence: checkout() }],
  });
  const assessment = result.assessments[0];
  assert.equal(assessment.roles.seller.name, "Acme Camera");
  assert.equal(assessment.roles.legal_seller.name, "Acme Camera LLC");
  assert.equal(assessment.roles.merchant_of_record.name, "Acme Camera LLC");
  assert.equal(assessment.evidence_scope.checkout.source_id, "merchant-checkout");
  assert.equal(assessment.evidence_scope.checkout.url, "https://merchant.example/merchant-checkout");
  assert.equal(assessment.status, "verified_established");
  assert.equal(assessment.purchase_gate, "eligible_for_other_shopping_checks");
  assert.ok(assessment.positive_signals.includes("reversible_payment_method"));
});

test("model-authored verified merchant fields are ignored when signed pages do not support them", () => {
  const result = assessMerchantTrustFromEvidence({
    evaluated_at: NOW,
    requirements: { reversible_payment_required: true },
    candidates: [{
      id: "offer-a",
      listing_evidence: listing(),
      seller: { name: "Injected Seller", evidence_status: "verified" },
      legal_seller: { name: "Injected LLC", evidence_status: "verified" },
      merchant_of_record: { name: "Injected LLC", evidence_status: "verified" },
      policies: { terms_available: true, privacy_available: true, return_policy_available: true },
      recourse: { payment_method: "credit_card", chargeback_eligible: true },
    }],
  });
  const assessment = result.assessments[0];
  assert.equal(assessment.roles.seller.name, "Acme Camera");
  assert.equal(assessment.roles.merchant_of_record.name, null);
  assert.equal(assessment.purchase_gate, "research_more");
  assert.ok(assessment.critical_unknowns.includes("merchant_of_record"));
  assert.ok(assessment.critical_unknowns.includes("payment_recourse"));
});

test("tampered, stale, mislabeled, and marker-free merchant pages fail closed", () => {
  const tampered = terms();
  tampered.facts.legal_seller.value = "Injected LLC";
  assert.throws(() => assessMerchantTrustFromEvidence({
    evaluated_at: NOW,
    candidates: [{ id: "offer-a", listing_evidence: listing(), terms_evidence: tampered }],
  }), { code: "shopping_merchant_page_evidence_invalid" });

  assert.throws(() => assessMerchantTrustFromEvidence({
    evaluated_at: "2026-08-22T20:06:00.000Z",
    candidates: [{ id: "offer-a", listing_evidence: listing() }],
  }), { code: "shopping_merchant_page_evidence_stale" });

  assert.throws(() => assessMerchantTrustFromEvidence({
    evaluated_at: NOW,
    candidates: [{ id: "offer-a", listing_evidence: listing(), terms_evidence: privacy() }],
  }), { code: "shopping_merchant_page_evidence_scope" });

  const markerFree = page("marker-free", "Welcome to our merchant information page", "merchant_terms");
  assert.throws(() => assessMerchantTrustFromEvidence({
    evaluated_at: NOW,
    candidates: [{ id: "offer-a", listing_evidence: listing(), terms_evidence: markerFree }],
  }), { code: "shopping_merchant_page_evidence_scope" });
});
