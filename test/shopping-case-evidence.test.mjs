import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedShoppingPageEvidence } from "../lib/shopping-browser-evidence.mjs";
import { createShoppingCaseEvidence, validateShoppingCaseEvidence } from "../lib/shopping-case-evidence.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const RECEIPT = [
  "Order Receipt: complete", "Order Number: ORDER-9", "Product Key: camera-x", "Purchased At: 2026-08-01T12:00:00.000Z", "Delivered At: 2026-08-05T12:00:00.000Z",
  "Currency: USD", "Item Price: $100.00", "Order Shipping: $10.00", "Order Total: $110.00", "Seller: Example Store", "Merchant of record: Example Store",
].join("\n");

function page(text = RECEIPT, truncated = false, page_kind = "order_receipt") {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 9, captured_at: NOW, snapshot: { snapshotId: `case-${page_kind}`, title: "Purchase", url: `https://shop.example/${page_kind}`, text, truncated } });
  return extractBrowserObservedShoppingPageEvidence(registry.resolve, { snapshot_id: `case-${page_kind}`, page_kind, evaluated_at: NOW });
}

test("exact order facts become signed case evidence only through a browser receipt", () => {
  const result = createShoppingCaseEvidence({ page_evidence: page(), evaluated_at: NOW });
  assert.equal(validateShoppingCaseEvidence(result), true);
  assert.equal(result.type, "order_receipt");
  assert.deepEqual(result.facts.order, { order_number: "ORDER-9", product_id: "camera-x", purchased_at: "2026-08-01T12:00:00.000Z", delivered_at: "2026-08-05T12:00:00.000Z", currency: "USD", item_price_usd: 100, shipping_usd: 10, total_usd: 110 });
  assert.equal(result.facts.seller, "Example Store");
});

test("missing fields, wrong page kinds, truncation, staleness, and tampering fail closed", () => {
  assert.throws(() => createShoppingCaseEvidence({ page_evidence: page(RECEIPT.replace("Order Total: $110.00", "")), evaluated_at: NOW }), { code: "shopping_case_order_receipt_incomplete" });
  assert.throws(() => createShoppingCaseEvidence({ page_evidence: page(RECEIPT, true), evaluated_at: NOW }), { code: "shopping_case_page_evidence_invalid" });
  assert.throws(() => createShoppingCaseEvidence({ page_evidence: page("Current Price: $10", false, "retailer_listing"), evaluated_at: NOW }), { code: "shopping_case_page_evidence_invalid" });
  assert.throws(() => createShoppingCaseEvidence({ page_evidence: page(), evaluated_at: "2026-08-22T20:06:00.000Z" }), { code: "shopping_case_page_evidence_invalid" });
  const artifact = createShoppingCaseEvidence({ page_evidence: page(), evaluated_at: NOW });
  artifact.facts.order.total_usd = 1;
  assert.equal(validateShoppingCaseEvidence(artifact), false);
});

test("signed exact return and manufacturer warranty pages map to bounded policy evidence types", () => {
  const returns = createShoppingCaseEvidence({ page_evidence: page("Return Policy\n30-day returns", false, "return_policy"), evaluated_at: NOW });
  const warranty = createShoppingCaseEvidence({ page_evidence: page("Limited Warranty\nWarranty duration: 1 year", false, "manufacturer_warranty"), evaluated_at: NOW });
  assert.equal(returns.type, "merchant_policy");
  assert.equal(warranty.type, "manufacturer_policy");
});
