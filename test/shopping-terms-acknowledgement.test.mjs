import assert from "node:assert/strict";
import test from "node:test";
import { verifyShoppingArtifactAttestation } from "../lib/shopping-attestation.mjs";
import { createShoppingTermsAcknowledgementRegistry, validateCheckoutTermsAcknowledgement } from "../lib/shopping-terms-acknowledgement.mjs";

const NOW = "2026-08-22T20:00:30.000Z";
const evidence = { evidence_status: "verified", source_id: "checkout-snapshot" };

function input() {
  return {
    product_id: "camera-x", offer_id: "offer-a", add_on_inventory_complete: true, term_change_inventory_complete: true, urgency_inventory_complete: true,
    checkout_pattern_attestation: `v1.checkout_pattern_evidence.${"1".repeat(64)}`,
    checkout_pattern_warnings: ["selected_add_on_reappeared:warranty:fresh_acceptance_required"],
    purchase: {
      type: "subscription", terms_version: "terms-1", disclosed_at: "2026-08-22T20:00:00.000Z", terms_inventory_complete: true, ...evidence,
      initial_charge: { amount_usd: 0, ...evidence },
      recurring: { amount_usd: 20, cadence: "monthly", first_charge_at: "2026-09-22T20:00:00.000Z", auto_renews: true, minimum_cycles: 0, ...evidence },
      cancellation: { method: "online", terms_complete: true, deadline: "Before renewal", fee_usd: 0, ...evidence },
    },
    add_ons: [{ id: "warranty", kind: "warranty", selected: true, optional: true, preselected: false, amount_usd: 10, ...evidence }],
    term_changes: [{ field: "recurring_amount", changed: true, user_notified: true }],
  };
}

test("one new exact terms response produces a scope-bound single-use acknowledgement", async () => {
  let challenge;
  const registry = createShoppingTermsAcknowledgementRegistry({
    resolve_panel_request: async (requestId) => ({ request_id: requestId, request_revision: 1, text: challenge.required_response, captured_at: "2026-08-22T20:00:40.000Z" }),
  });
  const terms = input();
  challenge = registry.issue({ input: terms, evaluated_at: NOW });
  assert.equal(verifyShoppingArtifactAttestation("checkout_terms_challenge", challenge), true);
  assert.match(challenge.required_response, /^ACCEPT TERMS [A-F0-9]{12}$/);
  assert.deepEqual(challenge.required_acknowledgements, ["purchase_type", "recurring_charge", "cancellation_terms", "add_on:warranty", "term_change:recurring_amount"]);
  assert.deepEqual(challenge.terms_summary.observed_checkout_warnings, ["selected_add_on_reappeared:warranty:fresh_acceptance_required"]);

  const receipt = await registry.accept({ challenge, request_id: "terms-message-1", evaluated_at: "2026-08-22T20:00:45.000Z" });
  assert.equal(verifyShoppingArtifactAttestation("checkout_terms_acknowledgement", receipt), true);
  assert.equal(validateCheckoutTermsAcknowledgement(receipt, terms, "2026-08-22T20:00:45.000Z"), true);
  assert.equal(receipt.purchase_allowed, false);
  assert.equal(receipt.external_submission_allowed, false);
  await assert.rejects(() => registry.accept({ challenge, request_id: "terms-message-2", evaluated_at: "2026-08-22T20:00:46.000Z" }), { code: "shopping_terms_replayed" });
});

test("any recurring amount, add-on, change, version, subject, or age change invalidates acknowledgement", async () => {
  let challenge;
  const registry = createShoppingTermsAcknowledgementRegistry({
    resolve_panel_request: async (requestId) => ({ request_id: requestId, request_revision: 1, text: challenge.required_response, captured_at: "2026-08-22T20:00:40.000Z" }),
  });
  const terms = input();
  challenge = registry.issue({ input: terms, evaluated_at: NOW });
  const receipt = await registry.accept({ challenge, request_id: "terms-message", evaluated_at: "2026-08-22T20:00:45.000Z" });
  const mutations = [
    (value) => { value.purchase.recurring.amount_usd = 21; },
    (value) => { value.purchase.terms_version = "terms-2"; },
    (value) => { value.add_ons[0].amount_usd = 11; },
    (value) => { value.add_ons[0].selected = false; },
    (value) => { value.term_changes[0].field = "renewal_date"; },
    (value) => { value.checkout_pattern_attestation = `v1.checkout_pattern_evidence.${"2".repeat(64)}`; },
    (value) => { value.offer_id = "offer-b"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(terms);
    mutate(changed);
    assert.equal(validateCheckoutTermsAcknowledgement(receipt, changed, "2026-08-22T20:00:45.000Z"), false);
  }
  assert.equal(validateCheckoutTermsAcknowledgement(receipt, terms, "2026-08-22T20:10:00.000Z", 300), false);
});

test("wrong, prior, expired, altered, restarted-process, and undisclosed challenges fail closed", async () => {
  let response = "wrong";
  let capturedAt = "2026-08-22T20:00:40.000Z";
  const registry = createShoppingTermsAcknowledgementRegistry({
    resolve_panel_request: async (requestId) => ({ request_id: requestId, request_revision: 1, text: response, captured_at: capturedAt }),
  });
  const challenge = registry.issue({ input: input(), evaluated_at: NOW, expires_in_seconds: 60 });
  await assert.rejects(() => registry.accept({ challenge, request_id: "wrong", evaluated_at: "2026-08-22T20:00:45.000Z" }), { code: "shopping_terms_response_mismatch" });
  response = challenge.required_response;
  capturedAt = "2026-08-22T19:59:59.000Z";
  await assert.rejects(() => registry.accept({ challenge, request_id: "prior", evaluated_at: "2026-08-22T20:00:45.000Z" }), { code: "shopping_terms_message_stale" });
  capturedAt = "2026-08-22T20:00:40.000Z";
  await assert.rejects(() => registry.accept({ challenge, request_id: "expired", evaluated_at: "2026-08-22T20:02:00.000Z" }), { code: "shopping_terms_expired" });
  const altered = structuredClone(challenge);
  altered.scope_sha256 = "0".repeat(64);
  await assert.rejects(() => registry.accept({ challenge: altered, request_id: "altered", evaluated_at: "2026-08-22T20:00:45.000Z" }), { code: "shopping_terms_challenge_invalid" });
  const restarted = createShoppingTermsAcknowledgementRegistry({ resolve_panel_request: async () => ({}) });
  await assert.rejects(() => restarted.accept({ challenge, request_id: "restart", evaluated_at: "2026-08-22T20:00:45.000Z" }), { code: "shopping_terms_challenge_not_found" });

  const undisclosed = input();
  undisclosed.term_changes[0].user_notified = false;
  assert.throws(() => registry.issue({ input: undisclosed, evaluated_at: NOW }), { code: "shopping_terms_change_undisclosed" });
});
