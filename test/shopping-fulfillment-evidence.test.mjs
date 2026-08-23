import assert from "node:assert/strict";
import test from "node:test";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { extractShoppingPageEvidence } from "../lib/shopping-page-evidence.mjs";
import { assessShoppingFulfillmentFromEvidence, validateShoppingFulfillmentArtifact } from "../lib/shopping-fulfillment-evidence.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

function page(id, kind, text, overrides = {}) {
  const captured_at = overrides.captured_at || NOW;
  const url = overrides.url || `https://shop.example/${id}`;
  const receipt = attestShoppingArtifact("browser_snapshot", { source_id: id, snapshot_id: id, tab_id: 1, url, captured_at, content_sha256: id.padEnd(64, "a").slice(0, 64), truncated: false });
  return attestShoppingArtifact("page_evidence", { ...extractShoppingPageEvidence({ page_text: text, page_kind: kind, url, captured_at }), source_receipt: receipt });
}

function identity() {
  return attestShoppingArtifact("identity", { evaluated_at: NOW, target_product_id: "camera-x", resolutions: [{ candidate_id: "offer-a", classification: "exact_match", safe_to_compare_offers: true, confidence: 1, offer_variant: null, canonical: { condition: "new" } }] });
}

const listingText = "Brand: Acme\nModel: Camera X\nCurrent Price: $100.00\nShipping: $10.00\nSold by: Camera Store\nIn stock\nCondition: new";
const checkoutText = "Checkout\nOffer ID: offer-a\nProduct Key: camera-x\nSeller: Camera Store\nItem Price: $100.00\nShipping: $10.00\nTax: $8.00\nImport Duty Treatment: not applicable\nBrokerage Treatment: not applicable\nCarrier Surcharge Treatment: not applicable\nCurrency Conversion Treatment: not applicable\nShips From Country: US\nDestination Country: US\nDestination Eligible: yes\nIncoterm: domestic\nDelivery Earliest: 2026-08-25T00:00:00.000Z\nDelivery Latest: 2026-08-27T00:00:00.000Z\nTracking Available: yes";

function input(overrides = {}) {
  return { evaluated_at: NOW, destination_country: "US", requirements: { require_tracking: true }, identity: identity(), offers: [{ id: "offer-a", listing_evidence: page("listing-a", "retailer_listing", listingText), checkout_evidence: page("checkout-a", "checkout", checkoutText) }], ...overrides };
}

test("fresh signed listing and checkout facts produce an attested landed-cost artifact", () => {
  const result = assessShoppingFulfillmentFromEvidence(input());
  assert.equal(result.assessments[0].action, "eligible");
  assert.deepEqual(result.assessments[0].fully_landed_total_usd, { low_usd: 118, expected_usd: 118, high_usd: 118 });
  assert.equal(result.assessments[0].safe_for_offer_comparison, true);
  assert.equal(validateShoppingFulfillmentArtifact(result, NOW), true);
  assert.match(result.artifact_attestation, /^v1\.fulfillment\./);
});

test("missing signed charges remain research instead of becoming zero", () => {
  const sparse = page("checkout-sparse", "checkout", "Checkout\nOffer ID: offer-a\nProduct Key: camera-x\nSeller: Camera Store\nItem Price: $100.00\nShipping: $10.00\nShips From Country: US\nDestination Country: US\nDestination Eligible: yes\nIncoterm: domestic");
  const result = assessShoppingFulfillmentFromEvidence(input({ offers: [{ id: "offer-a", listing_evidence: page("listing-sparse", "retailer_listing", listingText), checkout_evidence: sparse }] }));
  assert.equal(result.assessments[0].action, "research_more");
  assert.equal(result.assessments[0].fully_landed_total_usd, null);
  assert.ok(result.assessments[0].research.includes("charges:tax"));
  assert.equal(result.assessments[0].safe_for_offer_comparison, false);
});

test("forged, stale, wrong-scope, and conflicting page facts fail closed", () => {
  const forgedInput = input();
  forgedInput.offers[0].checkout_evidence.facts.fulfillment.tax_usd.value = 0;
  assert.throws(() => assessShoppingFulfillmentFromEvidence(forgedInput), { code: "shopping_fulfillment_page_evidence_invalid" });

  const stale = input({ offers: [{ id: "offer-a", listing_evidence: page("listing-stale", "retailer_listing", listingText, { captured_at: "2026-08-22T19:00:00.000Z" }), checkout_evidence: page("checkout-stale", "checkout", checkoutText, { captured_at: "2026-08-22T19:00:00.000Z" }) }] });
  assert.throws(() => assessShoppingFulfillmentFromEvidence(stale), { code: "shopping_fulfillment_page_evidence_stale" });

  const wrongDestination = checkoutText.replace("Destination Country: US", "Destination Country: CA");
  assert.throws(() => assessShoppingFulfillmentFromEvidence(input({ offers: [{ id: "offer-a", listing_evidence: page("listing-destination", "retailer_listing", listingText), checkout_evidence: page("checkout-destination", "checkout", wrongDestination) }] })), { code: "shopping_fulfillment_page_evidence_scope" });

  const conflicting = checkoutText.replace("Item Price: $100.00", "Item Price: $1.00");
  assert.throws(() => assessShoppingFulfillmentFromEvidence(input({ offers: [{ id: "offer-a", listing_evidence: page("listing-conflict", "retailer_listing", listingText), checkout_evidence: page("checkout-conflict", "checkout", conflicting) }] })), { code: "shopping_fulfillment_page_evidence_conflict" });

  const contradictoryTotal = `${checkoutText}\nOrder Total: $1.00`;
  assert.throws(() => assessShoppingFulfillmentFromEvidence(input({ offers: [{ id: "offer-a", listing_evidence: page("listing-total", "retailer_listing", listingText), checkout_evidence: page("checkout-total", "checkout", contradictoryTotal) }] })), { code: "shopping_fulfillment_page_evidence_conflict" });
});

test("tampering with the calculated artifact invalidates its process signature", () => {
  const result = assessShoppingFulfillmentFromEvidence(input());
  result.assessments[0].fully_landed_total_usd.expected_usd = 1;
  assert.equal(validateShoppingFulfillmentArtifact(result, NOW), false);
});

test("unsigned promotion output cannot be laundered through the signed fulfillment ledger", () => {
  assert.throws(() => assessShoppingFulfillmentFromEvidence(input({ promotion_artifacts: [{ offer_id: "offer-a", immediate_checkout_discount_usd: 99 }] })), { code: "shopping_fulfillment_promotion_evidence_invalid" });
});
