import assert from "node:assert/strict";
import test from "node:test";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { extractShoppingPageEvidence } from "../lib/shopping-page-evidence.mjs";
import { assessShoppingPromotionFromEvidence } from "../lib/shopping-promotion-evidence.mjs";
import { validateShoppingPromotionArtifact } from "../lib/shopping-promotion.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

function page(id, kind, text, captured_at = NOW) {
  const url = `https://shop.example/${id}`;
  const receipt = attestShoppingArtifact("browser_snapshot", { source_id: id, snapshot_id: id, tab_id: 1, url, captured_at, content_sha256: "a".repeat(64), truncated: false });
  return attestShoppingArtifact("page_evidence", { ...extractShoppingPageEvidence({ page_text: text, page_kind: kind, url, captured_at }), source_receipt: receipt });
}

function identity() {
  return attestShoppingArtifact("identity", { evaluated_at: NOW, target_product_id: "camera-x", resolutions: [{ candidate_id: "offer-a", classification: "exact_match", safe_to_compare_offers: true, confidence: 1, canonical: { condition: "new" } }] });
}

const listingText = "Brand: Acme\nModel: Camera X\nCurrent Price: $100.00\nShipping: $5.00\nSold by: Camera Store\nIn stock\nCondition: new";
const checkout = (promotionLine, extra = "") => `Checkout\nOffer ID: offer-a\nProduct Key: camera-x\nSeller: Camera Store\nItem Price: $100.00\nShipping: $5.00\nPromotion Inventory: complete\n${promotionLine}\n${extra}`;
const applied = "Promotion: id=save10; type=coupon; code=SAVE10; application=applied; amount=$10.00; affects advertised price=yes; eligibility=complete; obligations=none; stacking=verified";

function input(checkoutText = checkout(applied, "Discount: -$10.00"), overrides = {}) {
  return { evaluated_at: NOW, offer_id: "offer-a", identity: identity(), listing_evidence: page("listing", "retailer_listing", listingText), checkout_evidence: page("checkout", "checkout", checkoutText), ...overrides };
}

test("signed exact-cart applied coupon produces a process-attested promotion artifact", () => {
  const result = assessShoppingPromotionFromEvidence(input());
  assert.equal(result.action, "eligible");
  assert.equal(result.immediate_checkout_discount_usd, 10);
  assert.equal(result.checkout_landed_total_usd, 95);
  assert.deepEqual(result.included_promotion_ids, ["save10"]);
  assert.match(result.artifact_attestation, /^v1\.promotion\./);
  assert.ok(validateShoppingPromotionArtifact({ artifact: result, offer_id: "offer-a", product_id: "camera-x", base_price_usd: 100, shipping_usd: 5, evaluated_at: Date.parse(NOW) }));
});

test("available and consequential promotions cannot become immediate discounts", () => {
  const available = applied.replace("application=applied", "application=available");
  let result = assessShoppingPromotionFromEvidence(input(checkout(available)));
  assert.equal(result.action, "research_more");
  assert.equal(result.immediate_checkout_discount_usd, 0);

  const member = "Promotion: id=member; type=membership price; application=applied; amount=$20.00; eligibility=complete; obligations=none; stacking=verified";
  result = assessShoppingPromotionFromEvidence(input(checkout(member)));
  assert.equal(result.action, "research_more");
  assert.ok(result.research.some((item) => item.includes("obligations_incomplete")));
  assert.equal(result.immediate_checkout_discount_usd, 0);
});

test("incomplete inventory, forged pages, stale evidence, and wrong scope fail closed", () => {
  assert.throws(() => assessShoppingPromotionFromEvidence(input(checkout(applied).replace("Promotion Inventory: complete\n", ""))), { code: "shopping_promotion_page_evidence_scope" });
  const forged = input();
  forged.checkout_evidence.facts.promotions[0].amount_applied_usd = 99;
  assert.throws(() => assessShoppingPromotionFromEvidence(forged), { code: "shopping_promotion_page_evidence_invalid" });
  const stale = input(checkout(applied), { listing_evidence: page("listing-stale", "retailer_listing", listingText, "2026-08-22T19:00:00.000Z"), checkout_evidence: page("checkout-stale", "checkout", checkout(applied), "2026-08-22T19:00:00.000Z") });
  assert.throws(() => assessShoppingPromotionFromEvidence(stale), { code: "shopping_promotion_page_evidence_stale" });
  assert.throws(() => assessShoppingPromotionFromEvidence(input(checkout(applied).replace("Offer ID: offer-a", "Offer ID: other"))), { code: "shopping_promotion_page_evidence_scope" });
});

test("checkout discount and extracted promotion inventory must reconcile exactly", () => {
  assert.throws(() => assessShoppingPromotionFromEvidence(input(checkout(applied, "Discount: -$9.00"))), { code: "shopping_promotion_page_evidence_conflict" });
  const duplicate = `${applied}\n${applied}`;
  assert.throws(() => assessShoppingPromotionFromEvidence(input(checkout(duplicate))), { code: "shopping_promotion_page_evidence_conflict" });
});

test("editing an issued promotion artifact invalidates it", () => {
  const result = assessShoppingPromotionFromEvidence(input());
  result.immediate_checkout_discount_usd = 99;
  assert.equal(validateShoppingPromotionArtifact({ artifact: result, offer_id: "offer-a", product_id: "camera-x", evaluated_at: Date.parse(NOW) }), null);
});
