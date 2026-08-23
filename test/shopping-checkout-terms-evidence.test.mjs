import assert from "node:assert/strict";
import test from "node:test";
import { verifyShoppingArtifactAttestation } from "../lib/shopping-attestation.mjs";
import { createBrowserEvidenceRegistry, extractBrowserObservedCheckoutTermsEvidence } from "../lib/shopping-browser-evidence.mjs";
import { assessCheckoutConsentFromEvidence } from "../lib/shopping-checkout-consent-evidence.mjs";
import { createShoppingCheckoutPatternRegistry } from "../lib/shopping-checkout-patterns.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const COMPLETE = [
  "Offer ID: offer-a",
  "Product Key: camera-x",
  "Purchase Type: subscription",
  "Terms Version: terms-1",
  "Terms Inventory: complete",
  "Initial Charge: $0.00",
  "Recurring Charge: $20.00",
  "Recurring Cadence: monthly",
  "First Recurring Charge: 2026-09-22T20:00:00.000Z",
  "Auto Renews: yes",
  "Minimum Cycles: 0",
  "Cancellation Method: online",
  "Cancellation Terms: complete",
  "Cancellation Deadline: Before the next renewal",
  "Cancellation Fee: $0.00",
  "Add-on Inventory: complete",
  "Add-on: id=warranty; kind=warranty; selected=yes; optional=yes; preselected=yes; amount=$10.00",
  "Term Change Inventory: complete",
  "Term Change: field=recurring_amount; disclosed=yes",
  "Urgency Inventory: complete",
].join("\n");

function artifact(text = COMPLETE) {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 7, captured_at: NOW, snapshot: { snapshotId: "checkout-terms", title: "Checkout", url: "https://shop.example/checkout", text, truncated: false } });
  return extractBrowserObservedCheckoutTermsEvidence(registry.resolve, { snapshot_id: "checkout-terms", evaluated_at: NOW });
}

function assess(terms_evidence, evaluated_at = NOW) {
  const pattern_evidence = createShoppingCheckoutPatternRegistry().observe({ terms_evidence, evaluated_at });
  return assessCheckoutConsentFromEvidence({ terms_evidence, pattern_evidence, evaluated_at });
}

test("checkout terms are reconstructed only from the signed observed snapshot", () => {
  const result = artifact();
  assert.equal(verifyShoppingArtifactAttestation("checkout_terms_evidence", result), true);
  assert.equal(result.product_id, "camera-x");
  assert.equal(result.offer_id, "offer-a");
  assert.equal(result.purchase.type, "subscription");
  assert.equal(result.purchase.recurring.amount_usd, 20);
  assert.equal(result.purchase.recurring.cadence, "monthly");
  assert.equal(result.purchase.cancellation.method, "online");
  assert.equal(result.add_ons[0].id, "warranty");
  assert.equal(result.add_ons[0].amount_usd, 10);
  assert.deepEqual(result.term_changes, [{ field: "recurring_amount", changed: true, user_notified: true }]);
});

test("selected add-ons and recurring terms require acknowledgement while missing inventories remain research", () => {
  let result = assess(artifact());
  assert.equal(result.status, "remove_unrequested_items");
  assert.ok(result.removals.includes("warranty"));
  assert.ok(result.clarifications.includes("fresh_user_acknowledgement_required"));

  const incompleteText = COMPLETE.replace("Add-on Inventory: complete\n", "").replace("Term Change Inventory: complete\n", "");
  result = assess(artifact(incompleteText));
  assert.equal(result.status, "remove_unrequested_items");
  assert.ok(result.research.includes("add_on_inventory_unverified"));
  assert.ok(result.research.includes("term_change_inventory_unverified"));
});

test("tampered, stale, and model-substituted terms evidence fails closed", () => {
  const tampered = artifact();
  tampered.purchase.recurring.amount_usd = 1;
  assert.throws(() => assess(tampered), { code: "shopping_checkout_pattern_terms_invalid" });
  assert.throws(() => assess(artifact(), "2026-08-22T20:03:00.000Z"), { code: "shopping_checkout_pattern_terms_invalid" });

  const observed = artifact(COMPLETE);
  assert.equal(observed.purchase.recurring.amount_usd, 20);
  assert.equal("page_text" in observed, false);
});

test("complete markers cannot hide malformed add-on, changed-term, or urgency rows", () => {
  const malformed = artifact(COMPLETE
    .replace("amount=$10.00", "amount=not-a-price")
    .replace("field=recurring_amount; disclosed=yes", "field=recurring_amount; disclosed=maybe")
    .concat("\nUrgency Claim: id=timer; type=countdown; remaining_seconds=soon"));
  assert.equal(malformed.add_on_inventory_complete, false);
  assert.equal(malformed.term_change_inventory_complete, false);
  assert.equal(malformed.urgency_inventory_complete, false);
  const result = assess(malformed);
  assert.ok(result.research.includes("add_on_inventory_unverified"));
  assert.ok(result.research.includes("term_change_inventory_unverified"));
  assert.ok(result.research.includes("urgency_inventory_unverified"));
});
