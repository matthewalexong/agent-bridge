import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedShoppingPageEvidence } from "../lib/shopping-browser-evidence.mjs";
import { assessCounterfeitRiskFromEvidence } from "../lib/shopping-counterfeit-evidence.mjs";
import { resolveProductIdentities } from "../lib/shopping-identity.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

function identity() {
  return resolveProductIdentities({
    evaluated_at: NOW,
    target_product_id: "drive-x",
    target: { brand: "Acme", model: "Drive X", condition: "new" },
    candidates: [{ id: "offer-a", brand: "Acme", model: "Drive X", condition: "new", offer_variant: "1tb" }],
    required_fields: ["brand", "model", "condition"],
  });
}

function page(id, text, page_kind, options = {}) {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 7, captured_at: NOW, snapshot: {
    snapshotId: id,
    title: id,
    url: `https://evidence.example/${id}`,
    text,
    truncated: false,
  } });
  return extractBrowserObservedShoppingPageEvidence(registry.resolve, {
    snapshot_id: id,
    evaluated_at: NOW,
    page_kind,
    ...options,
  });
}

const listing = () => page(
  "listing-a",
  "Current Price: $99.00\nFREE delivery\nSold by: Acme Retail\nIn stock\nManufacturer warranty: included\n30-day returns\nCondition: new",
  "retailer_listing",
);

const authorization = () => page(
  "directory-a",
  "Authorized Seller: Acme Retail",
  "manufacturer_authorized_sellers",
  { seller_query: "Acme Retail", directory_complete: true },
);

test("counterfeit assessment derives a low-risk chain only from signed listing and manufacturer directory facts", () => {
  const result = assessCounterfeitRiskFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    offers: [{ id: "offer-a", listing_evidence: listing(), authorization_evidence: authorization() }],
  });
  const assessment = result.assessments[0];
  assert.equal(assessment.seller, "Acme Retail");
  assert.equal(assessment.product_id, "drive-x");
  assert.equal(assessment.variant, "1tb");
  assert.deepEqual(assessment.availability, { status: "in_stock", evidence_status: "verified" });
  assert.equal(assessment.risk_status, "low");
  assert.ok(assessment.signals.some((signal) => signal.code === "authorized_seller"));
  assert.ok(assessment.signals.some((signal) => signal.code === "manufacturer_warranty"));
});

test("missing listing availability stays unknown instead of inheriting a model stock claim", () => {
  const noStockListing = page(
    "listing-no-stock",
    "Current Price: $99.00\nFREE delivery\nSold by: Acme Retail\nManufacturer warranty: included\nCondition: new",
    "retailer_listing",
  );
  const assessment = assessCounterfeitRiskFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    offers: [{ id: "offer-a", listing_evidence: noStockListing, authorization_evidence: authorization(), stock: "in_stock" }],
  }).assessments[0];
  assert.deepEqual(assessment.availability, { status: "unknown", evidence_status: "unknown" });
});

test("signed manufacturer-directory evidence is the only authority for an authorized-seller-only requirement", () => {
  const satisfied = assessCounterfeitRiskFromEvidence({
    evaluated_at: NOW,
    requirements: { authorized_seller_required: true },
    identity: identity(),
    offers: [{ id: "offer-a", listing_evidence: listing(), authorization_evidence: authorization() }],
  }).assessments[0];
  assert.equal(satisfied.authorization_requirement.status, "satisfied");
  assert.equal(satisfied.purchase_gate, "eligible_for_other_shopping_checks");

  const completeNoMatch = page(
    "directory-no-match",
    "Authorized Seller: Other Retail",
    "manufacturer_authorized_sellers",
    { seller_query: "Acme Retail", directory_complete: true },
  );
  const failed = assessCounterfeitRiskFromEvidence({
    evaluated_at: NOW,
    requirements: { authorized_seller_required: true },
    identity: identity(),
    offers: [{ id: "offer-a", listing_evidence: listing(), authorization_evidence: completeNoMatch }],
  }).assessments[0];
  assert.equal(failed.authorization_requirement.status, "failed");
  assert.equal(failed.purchase_gate, "avoid_offer");
  assert.equal(failed.definitive_counterfeit_finding, false);
  assert.equal(failed.accusation_allowed, false);

  const unresolved = assessCounterfeitRiskFromEvidence({
    evaluated_at: NOW,
    requirements: { authorized_seller_required: true },
    identity: identity(),
    offers: [{ id: "offer-a", listing_evidence: listing() }],
  }).assessments[0];
  assert.equal(unresolved.authorization_requirement.status, "unknown");
  assert.equal(unresolved.purchase_gate, "research_more");
});

test("model-only verified claims cannot manufacture counterfeit clearance", () => {
  const result = assessCounterfeitRiskFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    authorized_market_median_usd: 500,
    authorized_market_median_verified: true,
    offers: [{
      id: "offer-a",
      listing_evidence: listing(),
      authorization: { status: "authorized", evidence_status: "verified" },
      warranty: { applies: true, evidence_status: "verified" },
      official_finding: { counterfeit: false, authority_type: "manufacturer", evidence_status: "verified" },
    }],
  });
  assert.equal(result.assessments[0].risk_status, "unknown");
  assert.ok(result.assessments[0].critical_unknowns.includes("seller_authorization"));
  assert.ok(result.assessments[0].critical_unknowns.includes("verified_authorized_market_price_comparison"));
});

test("tampered, stale, and wrong-seller page artifacts fail closed", () => {
  const tampered = listing();
  tampered.facts.seller.value = "Injected Seller";
  assert.throws(() => assessCounterfeitRiskFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    offers: [{ id: "offer-a", listing_evidence: tampered }],
  }), { code: "shopping_counterfeit_page_evidence_invalid" });

  assert.throws(() => assessCounterfeitRiskFromEvidence({
    evaluated_at: "2026-08-22T20:06:00.000Z",
    identity: identity(),
    max_identity_age_seconds: 600,
    offers: [{ id: "offer-a", listing_evidence: listing() }],
  }), { code: "shopping_counterfeit_page_evidence_stale" });

  const wrongSellerDirectory = page(
    "directory-other",
    "Authorized Seller: Other Retail",
    "manufacturer_authorized_sellers",
    { seller_query: "Other Retail", directory_complete: true },
  );
  assert.throws(() => assessCounterfeitRiskFromEvidence({
    evaluated_at: NOW,
    identity: identity(),
    offers: [{ id: "offer-a", listing_evidence: listing(), authorization_evidence: wrongSellerDirectory }],
  }), { code: "shopping_counterfeit_page_evidence_scope" });
});
