import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedShoppingPageEvidence } from "../lib/shopping-browser-evidence.mjs";
import { createShoppingCaseEventEvidence, validateShoppingCaseEventEvidence } from "../lib/shopping-case-event-evidence.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
function text(type = "merchant_contacted") {
  return ["Event Evidence: complete", `Case Event: ${type}`, "Event At: 2026-08-22T19:00:00.000Z", "Order Number: ORDER-1", "Product Key: camera-x", "Event Reference: ref-1", "Event Counterparty: Example Store"].join("\n");
}

function page(page_kind, body = text(), truncated = false) {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 11, captured_at: NOW, snapshot: { snapshotId: `event-${page_kind}`, title: "Status", url: `https://shop.example/${page_kind}`, text: body, truncated } });
  return extractBrowserObservedShoppingPageEvidence(registry.resolve, { snapshot_id: `event-${page_kind}`, page_kind, evaluated_at: NOW });
}

test("signed merchant correspondence produces exact-order event evidence", () => {
  const result = createShoppingCaseEventEvidence({ page_evidence: page("merchant_correspondence"), evaluated_at: NOW });
  assert.equal(validateShoppingCaseEventEvidence(result), true);
  assert.equal(result.type, "merchant_contacted");
  assert.equal(result.order_number, "ORDER-1");
  assert.equal(result.product_id, "camera-x");
  assert.equal(result.reference, "ref-1");
});

test("page-kind permissions prevent event relabeling", () => {
  assert.throws(() => createShoppingCaseEventEvidence({ page_evidence: page("carrier_tracking", text("merchant_contacted")), evaluated_at: NOW }), { code: "shopping_case_event_page_evidence_invalid" });
  const delivered = createShoppingCaseEventEvidence({ page_evidence: page("carrier_tracking", text("delivered")), evaluated_at: NOW });
  assert.equal(delivered.type, "delivered");
  const refund = createShoppingCaseEventEvidence({ page_evidence: page("return_status", text("refund_received")), evaluated_at: NOW });
  assert.equal(refund.type, "refund_received");
  const claim = createShoppingCaseEventEvidence({ page_evidence: page("warranty_status", text("claim_resolved")), evaluated_at: NOW });
  assert.equal(claim.type, "claim_resolved");
});

test("truncated, incomplete, stale, future, and tampered events fail closed", () => {
  assert.throws(() => createShoppingCaseEventEvidence({ page_evidence: page("merchant_correspondence", text(), true), evaluated_at: NOW }), { code: "shopping_case_event_page_evidence_invalid" });
  assert.throws(() => createShoppingCaseEventEvidence({ page_evidence: page("merchant_correspondence", text().replace("Order Number: ORDER-1", "")), evaluated_at: NOW }), { code: "shopping_case_event_page_evidence_invalid" });
  assert.throws(() => createShoppingCaseEventEvidence({ page_evidence: page("merchant_correspondence"), evaluated_at: "2026-08-22T20:06:00.000Z" }), { code: "shopping_case_event_page_evidence_invalid" });
  assert.throws(() => createShoppingCaseEventEvidence({ page_evidence: page("merchant_correspondence", text().replace("2026-08-22T19:00:00.000Z", "2026-08-22T21:00:00.000Z")), evaluated_at: NOW }), { code: "shopping_case_event_page_evidence_invalid" });
  const result = createShoppingCaseEventEvidence({ page_evidence: page("merchant_correspondence"), evaluated_at: NOW });
  result.order_number = "OTHER";
  assert.equal(validateShoppingCaseEventEvidence(result), false);
});
