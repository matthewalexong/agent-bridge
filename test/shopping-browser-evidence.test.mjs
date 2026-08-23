import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { captureBrowserSnapshotsBatch, createBrowserEvidenceRegistry, createShoppingPageEvidenceLedger, extractBrowserObservedCheckoutEvidence, extractBrowserObservedCheckoutTermsEvidence, extractBrowserObservedShoppingPageEvidence } from "../lib/shopping-browser-evidence.mjs";
import { verifyShoppingArtifactAttestation } from "../lib/shopping-attestation.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

function snapshot(id, overrides = {}) {
  return {
    snapshotId: id,
    title: "Camera listing",
    url: "https://shop.example/camera",
    text: "Current Price: $79.00\nFREE delivery\nSold by: Acme Retail\nIn Stock",
    truncated: false,
    ...overrides,
  };
}

test("browser-observed snapshots issue bounded signed receipts with a content digest", () => {
  const registry = createBrowserEvidenceRegistry({ max_entries: 2, max_age_seconds: 300 });
  const receipt = registry.capture({ tab_id: 42, snapshot: snapshot("snapshot-a"), captured_at: NOW });
  assert.equal(verifyShoppingArtifactAttestation("browser_snapshot", receipt), true);
  assert.equal(receipt.url, "https://shop.example/camera");
  assert.equal(receipt.content_sha256, crypto.createHash("sha256").update(snapshot("snapshot-a").text).digest("hex"));
  assert.equal(registry.resolve("snapshot-a", { evaluated_at: NOW }).text, snapshot("snapshot-a").text);

  registry.capture({ tab_id: 42, snapshot: snapshot("snapshot-b"), captured_at: NOW });
  registry.capture({ tab_id: 42, snapshot: snapshot("snapshot-c"), captured_at: NOW });
  assert.equal(registry.size(), 2);
  assert.throws(() => registry.resolve("snapshot-a", { evaluated_at: NOW }), { code: "shopping_snapshot_receipt_not_found" });
});

test("shopping extraction uses registered browser text and URL, not model-supplied replacements", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 7, snapshot: snapshot("snapshot-real"), captured_at: NOW });
  const result = extractBrowserObservedShoppingPageEvidence(registry.resolve, {
    snapshot_id: "snapshot-real",
    evaluated_at: NOW,
    page_kind: "retailer_listing",
    page_text: "Current Price: $1.00\nSold by: Injected Seller",
    url: "https://attacker.example/fake",
  });
  assert.equal(result.facts.price_usd.value, 79);
  assert.equal(result.facts.seller.value, "Acme Retail");
  assert.equal(result.source.url, "https://shop.example/camera");
  assert.equal(result.source_receipt.source_id, "snapshot-real");
  assert.equal(verifyShoppingArtifactAttestation("page_evidence", result), true);
});

test("stale, missing, and truncated-completeness receipts fail closed", () => {
  const registry = createBrowserEvidenceRegistry({ max_age_seconds: 300 });
  registry.capture({ tab_id: 7, snapshot: snapshot("snapshot-stale"), captured_at: NOW });
  assert.throws(() => registry.resolve("snapshot-stale", { evaluated_at: "2026-08-22T20:06:00.000Z" }), { code: "shopping_snapshot_receipt_stale" });
  assert.throws(() => registry.resolve("snapshot-missing", { evaluated_at: NOW }), { code: "shopping_snapshot_receipt_not_found" });

  registry.capture({ tab_id: 7, snapshot: snapshot("snapshot-truncated", { truncated: true }), captured_at: NOW });
  assert.throws(() => extractBrowserObservedShoppingPageEvidence(registry.resolve, { snapshot_id: "snapshot-truncated", evaluated_at: NOW, page_kind: "manufacturer_authorized_sellers", seller_query: "Other Shop", directory_complete: true }), { code: "shopping_snapshot_incomplete" });
});

test("checkout extraction also ignores model-supplied replacement text", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 9, snapshot: snapshot("snapshot-checkout", { url: "https://shop.example/checkout", text: "Subtotal: $100.00\nShipping: $0.00\nTax: $8.00\nFees: $0.00\nOrder total: $108.00\nArrives: Tuesday" }), captured_at: NOW });
  const result = extractBrowserObservedCheckoutEvidence(registry.resolve, { snapshot_id: "snapshot-checkout", evaluated_at: NOW, page_text: "Order total: $1.00", url: "https://attacker.example" });
  assert.equal(result.facts.total_usd.value, 108);
  assert.equal(result.source.url, "https://shop.example/checkout");
  assert.equal(result.source_receipt.source_id, "snapshot-checkout");
  assert.equal(verifyShoppingArtifactAttestation("checkout_evidence", result), true);
});

test("checkout extraction preserves exact item and availability from observed browser text", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 3, captured_at: NOW, snapshot: { snapshotId: "snapshot-checkout-item", title: "Checkout", url: "https://shop.example/checkout", text: "Offer ID: offer-a\nProduct Key: camera-x\nSeller: Example Shop\nQuantity: 2\nUnit Price: $50.00\nStock: in stock\nSubtotal: $100.00\nShipping: $0.00\nTax: $8.00\nFees: $0.00\nOrder total: $108.00", truncated: false } });
  const result = extractBrowserObservedCheckoutEvidence(registry.resolve, { snapshot_id: "snapshot-checkout-item", evaluated_at: NOW });
  assert.equal(result.facts.offer_id.value, "offer-a");
  assert.equal(result.facts.product_key.value, "camera-x");
  assert.equal(result.facts.seller.value, "Example Shop");
  assert.equal(result.facts.quantity.value, 2);
  assert.equal(result.facts.unit_price_usd.value, 50);
  assert.equal(result.facts.stock.value, "in_stock");
});

test("truncated checkout snapshots cannot become confirmation evidence", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 4, captured_at: NOW, snapshot: { snapshotId: "snapshot-checkout-truncated", title: "Checkout", url: "https://shop.example/checkout", text: "Order total: $108.00", truncated: true } });
  assert.throws(() => extractBrowserObservedCheckoutEvidence(registry.resolve, { snapshot_id: "snapshot-checkout-truncated", evaluated_at: NOW }), { code: "shopping_snapshot_incomplete" });
  assert.throws(() => extractBrowserObservedCheckoutTermsEvidence(registry.resolve, { snapshot_id: "snapshot-checkout-truncated", evaluated_at: NOW }), { code: "shopping_snapshot_incomplete" });
  assert.throws(() => extractBrowserObservedShoppingPageEvidence(registry.resolve, { snapshot_id: "snapshot-checkout-truncated", evaluated_at: NOW, page_kind: "checkout" }), { code: "shopping_snapshot_incomplete" });
});

test("checkout extraction refuses unmasked card numbers and street addresses", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 5, captured_at: NOW, snapshot: { snapshotId: "snapshot-checkout-sensitive", title: "Checkout", url: "https://shop.example/checkout", text: "Payment Method: 4111111111111111\nShipping Destination: 123 Main Street", truncated: false } });
  const result = extractBrowserObservedCheckoutEvidence(registry.resolve, { snapshot_id: "snapshot-checkout-sensitive", evaluated_at: NOW });
  assert.equal(result.facts.payment_method.status, "unknown");
  assert.equal(result.facts.shipping_destination.status, "unknown");
});

test("page evidence ledger reuses only identical signed content and extraction scope", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 7, snapshot: snapshot("ledger-page"), captured_at: NOW });
  const ledger = createShoppingPageEvidenceLedger({ resolve_snapshot: registry.resolve, max_entries: 10 });
  const request = { snapshot_id: "ledger-page", evaluated_at: NOW, page_kind: "retailer_listing" };
  const first = ledger.extract(request);
  const second = ledger.extract(request);
  assert.deepEqual(second, first);
  assert.deepEqual(ledger.stats(), { entries: 1, hits: 1, misses: 1 });

  ledger.extract({ ...request, page_kind: "reviews" });
  ledger.extract({ ...request, seller_query: "Acme Retail" });
  assert.deepEqual(ledger.stats(), { entries: 3, hits: 1, misses: 3 });

  registry.capture({ tab_id: 7, snapshot: snapshot("ledger-page", { text: "Current Price: $91.00\nSold by: Acme Retail" }), captured_at: NOW });
  const changed = ledger.extract(request);
  assert.equal(changed.facts.price_usd.value, 91);
  assert.deepEqual(ledger.stats(), { entries: 4, hits: 1, misses: 4 });
});

test("ledger cache never bypasses freshness or truncated completeness", () => {
  const registry = createBrowserEvidenceRegistry({ max_age_seconds: 300 });
  registry.capture({ tab_id: 7, snapshot: snapshot("ledger-stale"), captured_at: NOW });
  const ledger = createShoppingPageEvidenceLedger({ resolve_snapshot: registry.resolve });
  ledger.extract({ snapshot_id: "ledger-stale", evaluated_at: NOW, page_kind: "retailer_listing" });
  assert.throws(() => ledger.extract({ snapshot_id: "ledger-stale", evaluated_at: "2026-08-22T20:06:00.000Z", page_kind: "retailer_listing" }), { code: "shopping_snapshot_receipt_stale" });

  registry.capture({ tab_id: 8, snapshot: snapshot("ledger-truncated", { truncated: true }), captured_at: NOW });
  ledger.extract({ snapshot_id: "ledger-truncated", evaluated_at: NOW, page_kind: "manufacturer_authorized_sellers", seller_query: "Acme", directory_complete: false });
  assert.throws(() => ledger.extract({ snapshot_id: "ledger-truncated", evaluated_at: NOW, page_kind: "manufacturer_authorized_sellers", seller_query: "Acme", directory_complete: true }), { code: "shopping_snapshot_incomplete" });
});

test("batch snapshots start concurrently and preserve partial success receipts", async () => {
  const registry = createBrowserEvidenceRegistry();
  const started = [];
  const releases = new Map();
  const pending = captureBrowserSnapshotsBatch([{ tabId: 1, maxChars: 10_000 }, { tabId: 2, maxChars: 10_000 }], {
    snapshot: ({ tabId }) => new Promise((resolve, reject) => {
      started.push(tabId);
      releases.set(tabId, () => tabId === 1 ? resolve(snapshot("batch-1")) : reject(Object.assign(new Error("page unavailable"), { code: "page_error" })));
    }),
    capture: (entry) => registry.capture(entry),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  releases.get(1)(); releases.get(2)();
  const results = await pending;
  assert.equal(results[0].status, "complete");
  assert.equal(verifyShoppingArtifactAttestation("browser_snapshot", results[0].snapshot.evidence_receipt), true);
  assert.deepEqual(results[1], { tab_id: 2, status: "error", error: { code: "page_error", message: "page unavailable" } });
});
