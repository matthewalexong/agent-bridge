import test from "node:test";
import assert from "node:assert/strict";
import { extractShoppingPageEvidence } from "../lib/shopping-page-evidence.mjs";

test("retailer evidence preserves seller, fulfiller, checkout facts, and provenance", () => {
  const result = extractShoppingPageEvidence({
    url: "https://market.example/product/123",
    page_text: [
      "List Price: $99.00",
      "Current Price: $79.00",
      "FREE delivery Tuesday",
      "Sold by: Third Party Camera Shop",
      "Fulfilled by: Market Example",
      "In Stock",
      "30-day returns",
      "Manufacturer warranty does not apply",
      "Condition: New",
      "UPC: 012345678905",
    ].join("\n"),
  });
  assert.equal(result.source.hostname, "market.example");
  assert.equal(result.facts.price_usd.value, 79);
  assert.equal(result.facts.shipping_usd.value, 0);
  assert.equal(result.facts.seller.value, "Third Party Camera Shop");
  assert.equal(result.facts.fulfiller.value, "Market Example");
  assert.equal(result.facts.stock.value, "in_stock");
  assert.equal(result.facts.return_days.value, 30);
  assert.equal(result.facts.manufacturer_warranty.value, false);
  assert.equal(result.facts.condition.value, "new");
  assert.equal(result.facts.identifiers.upc.value, "012345678905");
  assert.match(result.facts.seller.evidence[0].excerpt, /Third Party Camera Shop/);
});

test("manufacturer directory requires an exact normalized seller line", () => {
  const page = "Acme Camera\nBest Buy\nTrusted Photo";
  const exact = extractShoppingPageEvidence({ page_kind: "manufacturer_authorized_sellers", page_text: page, seller_query: "Best Buy", directory_complete: true });
  assert.equal(exact.facts.authorization.value, "explicit_match");
  const partial = extractShoppingPageEvidence({ page_kind: "manufacturer_authorized_sellers", page_text: page, seller_query: "Best", directory_complete: true });
  assert.equal(partial.facts.authorization.value, "no_match");
});

test("absence is unknown unless the caller proves the directory is complete", () => {
  const incomplete = extractShoppingPageEvidence({ page_kind: "manufacturer_authorized_sellers", page_text: "Acme Camera", seller_query: "Other Shop" });
  assert.equal(incomplete.facts.authorization.status, "unknown");
  const complete = extractShoppingPageEvidence({ page_kind: "manufacturer_authorized_sellers", page_text: "Acme Camera", seller_query: "Other Shop", directory_complete: true });
  assert.equal(complete.facts.authorization.value, "no_match");
  assert.equal(complete.facts.authorization.status, "derived");
});

test("review risk language is returned as mentions, never a risk verdict", () => {
  const result = extractShoppingPageEvidence({
    page_kind: "reviews",
    page_text: "Reviewer one: packaging mismatch and not authentic.\nReviewer two: the seal was broken on arrival.",
  });
  assert.deepEqual(result.review_signals.map((signal) => signal.code), ["authenticity_complaint", "packaging_mismatch", "seal_issue"]);
  assert.equal("risk_level" in result, false);
});

test("missing retailer facts remain unknown with actionable warnings", () => {
  const result = extractShoppingPageEvidence({ page_kind: "retailer_listing", page_text: "A product description with no commerce facts." });
  assert.equal(result.facts.price_usd.status, "unknown");
  assert.equal(result.facts.shipping_usd.status, "unknown");
  assert.deepEqual(result.warnings, ["price_not_found", "seller_not_found", "shipping_unresolved"]);
});

test("real accessible product text supports standalone price without inventing delivery or stock", () => {
  const result = extractShoppingPageEvidence({
    url: "https://www.bestbuy.com/product/example",
    page_text: [
      "Logitech - MX Master 3S",
      "Model: 910-007500SKU: 6633199",
      "Sold by",
      "Best Buy",
      "60th Anniversary Deal",
      "$79.99",
      "$79.99",
      "Save $20",
      "Comp. Value: $99.99",
      "Add to cart",
    ].join("\n"),
  });
  assert.equal(result.facts.price_usd.value, 79.99);
  assert.equal(result.facts.seller.value, "Best Buy");
  assert.equal(result.facts.identifiers.model.value, "910-007500");
  assert.equal(result.facts.identifiers.sku.value, "6633199");
  assert.equal(result.facts.shipping_usd.status, "unknown");
  assert.equal(result.facts.stock.status, "unknown");
  assert.ok(result.warnings.includes("shipping_unresolved"));
});

test("checkout and policy text preserve merchant, processor, and return recipient roles", () => {
  const result = extractShoppingPageEvidence({
    page_kind: "checkout",
    url: "https://market.example/checkout",
    page_text: [
      "Sold by: Camera Shop",
      "Fulfilled by: Market Hub",
      "Merchant of record: Camera Shop LLC",
      "Payments processed by: Market Payments",
      "Returns must be sent to: Camera Shop Returns, Reno NV",
    ].join("\n"),
  });
  assert.equal(result.facts.seller.value, "Camera Shop");
  assert.equal(result.facts.fulfiller.value, "Market Hub");
  assert.equal(result.facts.merchant_of_record.value, "Camera Shop LLC");
  assert.equal(result.facts.payment_processor.value, "Market Payments");
  assert.equal(result.facts.return_recipient.value, "Camera Shop Returns, Reno NV");
});

test("checkout evidence extracts a typed fulfillment component ledger", () => {
  const result = extractShoppingPageEvidence({
    page_kind: "checkout",
    page_text: "Checkout\nOffer ID: offer-a\nProduct Key: camera-x\nCurrency: USD\nItem Price: $100.00\nShipping: $10.00\nTax: $8.00\nImport Duty Treatment: not applicable\nBrokerage Treatment: included\nCarrier Surcharge: $2.00\nCurrency Conversion Treatment: not applicable\nOrder Total: $120.00\nShips From Country: US\nDestination Country: US\nDestination Eligible: yes\nIncoterm: domestic\nDelivery Earliest: 2026-08-25T00:00:00.000Z\nDelivery Latest: 2026-08-27T00:00:00.000Z\nTracking Available: yes",
  });
  assert.equal(result.facts.fulfillment.offer_id.value, "offer-a");
  assert.equal(result.facts.fulfillment.item_price_usd.value, 100);
  assert.equal(result.facts.fulfillment.tax_usd.value, 8);
  assert.equal(result.facts.fulfillment.import_duty_treatment.value, "not_applicable");
  assert.equal(result.facts.fulfillment.brokerage_treatment.value, "included");
  assert.equal(result.facts.fulfillment.carrier_surcharge_usd.value, 2);
  assert.equal(result.facts.fulfillment.destination_eligible.value, true);
  assert.equal(result.facts.fulfillment.delivery_latest_at.value, "2026-08-27T00:00:00.000Z");
  assert.equal(result.facts.fulfillment.tracking_available.value, true);
});

test("checkout evidence extracts a bounded explicit promotion inventory", () => {
  const result = extractShoppingPageEvidence({
    page_kind: "checkout",
    page_text: "Checkout\nPromotion Inventory: complete\nPromotion: id=save10; type=coupon; code=SAVE10; application=applied; amount=$10.00; affects advertised price=yes; eligibility=complete; obligations=none; stacking=verified\nDiscount: -$10.00",
  });
  assert.equal(result.facts.document_markers.promotion_inventory.value, true);
  assert.equal(result.facts.promotions.length, 1);
  assert.equal(result.facts.promotions[0].id, "save10");
  assert.equal(result.facts.promotions[0].type, "coupon");
  assert.equal(result.facts.promotions[0].application_status, "applied");
  assert.equal(result.facts.promotions[0].amount_applied_usd, 10);
  assert.equal(result.facts.promotions[0].eligibility_complete, true);
  assert.equal(result.facts.promotions[0].obligations_complete, true);
  assert.equal(result.facts.promotions[0].stacking_verified, true);
  assert.equal(result.facts.fulfillment.discount_usd.value, 10);
});

test("non-new listing facts are extracted as explicit claims rather than condition clearance", () => {
  const result = extractShoppingPageEvidence({
    page_kind: "retailer_listing",
    page_text: "Condition: Renewed\nCondition grade: Excellent\nRefurbished by: Acme Renew Program\nBattery health: 91%\nBattery cycle count: 47\nPrice: $399\nShipping: $0\nSold by: Acme Outlet",
  });
  assert.equal(result.facts.condition.value, "renewed");
  assert.equal(result.facts.condition_grade.value, "Excellent");
  assert.equal(result.facts.refurbisher.value, "Acme Renew Program");
  assert.equal(result.facts.battery_health_percent.value, 91);
  assert.equal(result.facts.battery_cycle_count.value, 47);
  assert.equal(result.facts.condition_grade.status, "explicit");
  assert.equal("condition_cleared_for_offer_comparison" in result, false);
});
