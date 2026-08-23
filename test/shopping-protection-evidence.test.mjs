import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedShoppingPageEvidence } from "../lib/shopping-browser-evidence.mjs";
import { resolveProductIdentities } from "../lib/shopping-identity.mjs";
import { assessShoppingProtectionFromEvidence } from "../lib/shopping-protection-evidence.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

function identity() {
  return resolveProductIdentities({
    evaluated_at: NOW,
    target_product_id: "camera-x",
    target: { brand: "Acme", model: "Camera X", condition: "new" },
    candidates: [{ id: "offer-a", brand: "Acme", model: "Camera X", condition: "new", offer_variant: "black" }],
    required_fields: ["brand", "model", "condition"],
  });
}

function page(id, text, page_kind, options = {}) {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 11, captured_at: NOW, snapshot: {
    snapshotId: id,
    title: id,
    url: `https://protection.example/${id}`,
    text,
    truncated: false,
  } });
  return extractBrowserObservedShoppingPageEvidence(registry.resolve, { snapshot_id: id, evaluated_at: NOW, page_kind, ...options });
}

const listing = () => page("protection-listing", "Current Price: $100.00\nFREE delivery\nSold by: Acme Camera\nCondition: new", "retailer_listing");
const returnPolicy = () => page("protection-returns", "Return Policy\nReturns accepted within 30 days\nReturn window starts after delivery\nOpened items accepted\nNo restocking fee\nReturn shipping paid by seller\nOriginal shipping refundable\nRefund method: original payment", "return_policy");
const warranty = () => page("protection-warranty", "Limited Warranty\nWarranty provider: manufacturer\nWarranty duration: 1 year\nWarranty applies only when purchased from an authorized seller\nWarranty registration not required\nWarranty covers parts and labor\nWarranty deductible: $0\nWarranty claim shipping paid by provider\nEstimated repair downtime: 7 days", "manufacturer_warranty");
const authorization = () => page("protection-directory", "Authorized Seller: Acme Camera", "manufacturer_authorized_sellers", { seller_query: "Acme Camera", directory_complete: true });
const repairability = () => page("protection-repair", "Official repair manual\nReplacement parts are widely available\nCritical components are replaceable", "repairability");
const buyerProtection = () => page("protection-buyer", "Terms and Conditions\nBuyer protection window: 120 days", "merchant_terms");

test("protection assessment derives exact-offer returns, warranty, repairability, and buyer protection from signed pages", () => {
  const result = assessShoppingProtectionFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    requirements: { warranty_required: true, manufacturer_warranty_required: true, min_warranty_months: 12, parts_and_labor_required: true, repair_parts_required: true, repair_manual_required: true, min_buyer_protection_days: 90 },
    candidates: [{ id: "offer-a", listing_evidence: listing(), return_policy_evidence: returnPolicy(), warranty_evidence: warranty(), authorization_evidence: authorization(), repairability_evidence: repairability(), buyer_protection_evidence: buyerProtection() }],
  });
  const assessment = result.assessments[0];
  assert.equal(assessment.product_id, "camera-x");
  assert.equal(assessment.variant, "black");
  assert.equal(assessment.seller, "Acme Camera");
  assert.equal(assessment.metrics.return_window, 30);
  assert.equal(assessment.metrics.warranty_duration, 12);
  assert.equal(assessment.metrics.repairability, 2);
  assert.equal(assessment.metrics.buyer_protection, 120);
  assert.equal(assessment.status, "eligible");
  assert.equal(assessment.purchase_gate, "eligible_for_offer_analysis");
});

test("model-authored protection objects cannot manufacture policy clearance", () => {
  const result = assessShoppingProtectionFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    candidates: [{
      id: "offer-a",
      listing_evidence: listing(),
      returns: { policy_verified: true, final_sale: false, window_days: 365 },
      warranty: { policy_verified: true, provider: "manufacturer", duration_months: 120 },
      repairability: { evidence_verified: true, parts_availability: "widely_available", manual_availability: "official", critical_components_replaceable: true },
      buyer_protection: { window_days: 365 },
    }],
  });
  const assessment = result.assessments[0];
  assert.equal(assessment.status, "needs_research");
  assert.ok(assessment.critical_unknowns.includes("returns:policy"));
  assert.ok(assessment.critical_unknowns.includes("warranty:policy"));
});

test("tampered, stale, marker-free, and wrong-seller protection evidence fails closed", () => {
  const tampered = returnPolicy();
  tampered.facts.return_days.value = 365;
  assert.throws(() => assessShoppingProtectionFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    candidates: [{ id: "offer-a", listing_evidence: listing(), return_policy_evidence: tampered }],
  }), { code: "shopping_protection_page_evidence_invalid" });

  assert.throws(() => assessShoppingProtectionFromEvidence({
    evaluated_at: "2026-08-22T20:06:00.000Z",
    identity: identity(),
    max_identity_age_seconds: 600,
    candidates: [{ id: "offer-a", listing_evidence: listing() }],
  }), { code: "shopping_protection_page_evidence_stale" });

  const markerFree = page("warranty-marker-free", "We may help with repairs.", "manufacturer_warranty");
  assert.throws(() => assessShoppingProtectionFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    candidates: [{ id: "offer-a", listing_evidence: listing(), warranty_evidence: markerFree }],
  }), { code: "shopping_protection_page_evidence_scope" });

  const wrongSeller = page("protection-wrong-directory", "Authorized Seller: Other Shop", "manufacturer_authorized_sellers", { seller_query: "Other Shop", directory_complete: true });
  assert.throws(() => assessShoppingProtectionFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    candidates: [{ id: "offer-a", listing_evidence: listing(), authorization_evidence: wrongSeller }],
  }), { code: "shopping_protection_page_evidence_scope" });
});
