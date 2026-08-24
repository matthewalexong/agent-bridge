import assert from "node:assert/strict";
import test from "node:test";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "../lib/shopping-attestation.mjs";
import { bindShoppingCandidateOffers } from "../lib/shopping-candidate-offer-evidence.mjs";
import { shoppingListingUrlKey } from "../lib/shopping-listing-candidates.mjs";

const NOW = "2026-08-24T21:00:00.000Z";

function receipt(id, url) {
  return attestShoppingArtifact("browser_snapshot", {
    source_id: id, snapshot_id: id, tab_id: 1, url, captured_at: NOW, truncated: false,
    content_sha256: id.padEnd(64, "a").slice(0, 64), elements_sha256: id.padEnd(64, "b").slice(0, 64),
  });
}

function candidateSet() {
  return attestShoppingArtifact("listing_candidates", {
    candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa",
    source_receipt: receipt("search-snapshot", "https://www.amazon.com/s?k=camera"),
    candidates: [
      { id: "listing_bbbbbbbbbbbbbbbb", title: "Camera One", url: "https://www.amazon.com/Camera-One/dp/B0ABCDEF12?tag=affiliate", image: null, price: { display: "$99.00", amount_usd: 99 } },
      { id: "listing_cccccccccccccccc", title: "Camera Two", url: "https://shop.example/products/camera-two", image: null, price: null },
    ],
  });
}

function page(id, url, kind = "retailer_listing") {
  return attestShoppingArtifact("page_evidence", {
    source: { url, page_kind: kind, captured_at: NOW },
    extraction_scope: { directory_complete: false },
    facts: { price_usd: { value: 99, status: "explicit", evidence: [] } },
    source_receipt: receipt(id, url),
  });
}

test("exact retailer identity binds fresh product evidence to signed candidates", () => {
  const result = bindShoppingCandidateOffers({
    candidate_set: candidateSet(),
    evaluated_at: NOW,
    bindings: [
      { candidate_id: "listing_bbbbbbbbbbbbbbbb", listing_evidence: page("detail-a", "https://www.amazon.com/dp/B0ABCDEF12?ref=redirect") },
      { candidate_id: "listing_cccccccccccccccc", listing_evidence: page("detail-b", "https://shop.example/products/camera-two?utm_source=search") },
    ],
  });
  assert.equal(verifyShoppingArtifactAttestation("candidate_offers", result), true);
  assert.equal(result.offers.length, 2);
  assert.equal(result.offers[0].url_binding.candidate_key, "amazon:B0ABCDEF12");
  assert.equal(result.offers[0].url_binding.status, "exact_listing");
  assert.equal(result.all_requested_candidates_hydrated, true);
  assert.equal(result.selects_product, false);
  assert.equal(result.selects_offer, false);
  assert.equal(result.purchase_allowed, false);
});

test("canonical listing keys tolerate tracking and retailer redirects but not different offers", () => {
  assert.equal(shoppingListingUrlKey("https://www.amazon.com/title/dp/B0ABCDEF12?tag=x"), "amazon:B0ABCDEF12");
  assert.equal(shoppingListingUrlKey("https://amazon.com/gp/product/B0ABCDEF12?ref=x"), "amazon:B0ABCDEF12");
  assert.equal(shoppingListingUrlKey("https://www.walmart.com/ip/title/123456?utm_source=x"), "walmart:123456");
  assert.notEqual(shoppingListingUrlKey("https://shop.example/products/a"), shoppingListingUrlKey("https://shop.example/products/b"));
});

test("candidate hydration rejects cross-listing, duplicate, unsigned, and wrong-kind evidence", () => {
  const set = candidateSet();
  assert.throws(() => bindShoppingCandidateOffers({ candidate_set: set, bindings: [
    { candidate_id: "listing_bbbbbbbbbbbbbbbb", listing_evidence: page("wrong", "https://www.amazon.com/dp/B0ZZZZZZ99") },
  ] }), { code: "shopping_candidate_snapshot_mismatch" });
  assert.throws(() => bindShoppingCandidateOffers({ candidate_set: set, bindings: [
    { candidate_id: "listing_bbbbbbbbbbbbbbbb", listing_evidence: page("a", "https://www.amazon.com/dp/B0ABCDEF12") },
    { candidate_id: "listing_bbbbbbbbbbbbbbbb", listing_evidence: page("b", "https://www.amazon.com/dp/B0ABCDEF12") },
  ] }), { code: "shopping_candidate_binding_invalid" });
  const tampered = page("tampered", "https://www.amazon.com/dp/B0ABCDEF12");
  tampered.source.url = "https://attacker.example/products/fake";
  assert.throws(() => bindShoppingCandidateOffers({ candidate_set: set, bindings: [{ candidate_id: "listing_bbbbbbbbbbbbbbbb", listing_evidence: tampered }] }), { code: "shopping_candidate_evidence_invalid" });
  assert.throws(() => bindShoppingCandidateOffers({ candidate_set: set, bindings: [
    { candidate_id: "listing_bbbbbbbbbbbbbbbb", listing_evidence: page("review", "https://www.amazon.com/dp/B0ABCDEF12", "reviews") },
  ] }), { code: "shopping_candidate_evidence_invalid" });
});
