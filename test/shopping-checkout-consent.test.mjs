import test from "node:test";
import assert from "node:assert/strict";
import { assessCheckoutConsent } from "../lib/shopping-checkout-consent.mjs";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { checkoutTermsAcceptanceScope } from "../lib/shopping-terms-acknowledgement.mjs";

const NOW = "2026-08-22T20:00:30.000Z";
const evidence = { evidence_status: "verified", source_id: "checkout-snapshot" };
const oneTime = {
  product_id: "product-a", offer_id: "offer-a", evaluated_at: NOW, captured_at: "2026-08-22T20:00:00.000Z", add_on_inventory_complete: true, term_change_inventory_complete: true, urgency_inventory_complete: true,
  purchase: { type: "one_time", terms_version: "terms-1", disclosed_at: "2026-08-22T20:00:00.000Z", terms_inventory_complete: true, ...evidence, initial_charge: { amount_usd: 100, ...evidence } },
};

function subscription() {
  const input = {
    ...structuredClone(oneTime),
    purchase: {
      ...structuredClone(oneTime.purchase), type: "subscription",
      recurring: { amount_usd: 20, cadence: "monthly", first_charge_at: "2026-09-22T20:00:00.000Z", auto_renews: true, minimum_cycles: 0, ...evidence },
      cancellation: { method: "online", terms_complete: true, deadline: "Cancel before the next billing date", fee_usd: 0, ...evidence },
    },
  };
  return withAcknowledgement(input);
}

function withAcknowledgement(input, acceptedAt = "2026-08-22T20:00:20.000Z") {
  const { scope_sha256 } = checkoutTermsAcceptanceScope(input);
  input.acknowledgement_receipt = attestShoppingArtifact("checkout_terms_acknowledgement", {
    acknowledgement_id: "ack-test", challenge_id: "challenge-test", product_id: input.product_id, offer_id: input.offer_id,
    terms_version: input.purchase.terms_version, scope_sha256, accepted_at: acceptedAt,
    purchase_allowed: false, external_submission_allowed: false,
  });
  return input;
}

test("a disclosed one-time purchase is consent-ready but never purchase-authorized", () => {
  const result = assessCheckoutConsent(oneTime);
  assert.equal(result.status, "ready_for_confirmation");
  assert.equal(result.consent_cleared_for_confirmation, true);
  assert.equal(result.confirmation_required, true);
  assert.equal(result.purchase_allowed, false);
});

test("subscription requires fresh user-message acknowledgement after disclosure", () => {
  const input = subscription();
  delete input.acknowledgement_receipt;
  let result = assessCheckoutConsent(input);
  assert.equal(result.status, "clarify_consent");
  assert.ok(result.clarifications.includes("fresh_user_acknowledgement_required"));

  input.acknowledgement = { purchase_type: "subscription", terms_version: "terms-1", source: "current_user_message", acknowledged_at: "2026-08-22T20:00:20.000Z", recurring_charge_ack: true, cancellation_terms_ack: true };
  result = assessCheckoutConsent(input);
  assert.equal(result.status, "clarify_consent");
  assert.equal(result.consent_cleared_for_confirmation, false);
});

test("fully disclosed and freshly acknowledged subscription can reach final confirmation", () => {
  const result = assessCheckoutConsent(subscription());
  assert.equal(result.status, "ready_for_confirmation");
  assert.deepEqual(result.research, []);
  assert.deepEqual(result.clarifications, []);
});

test("trial conversion and post-intro price cannot remain hidden", () => {
  const input = subscription();
  input.purchase.type = "trial_to_paid";
  input.purchase.recurring.intro_cycles = 1;
  const result = assessCheckoutConsent(input);
  assert.equal(result.status, "needs_research");
  assert.ok(result.research.includes("post_intro_price_unverified"));
  assert.ok(result.research.includes("trial_conversion_terms_unverified"));
});

test("prechecked add-on is removed unless freshly accepted in a user message", () => {
  const input = structuredClone(oneTime);
  input.add_ons = [{ id: "warranty", kind: "warranty", selected: true, optional: true, preselected: true, amount_usd: 20, user_intent: "none", intent_source: "ui_default", ...evidence }];
  const result = assessCheckoutConsent(input);
  assert.equal(result.status, "remove_unrequested_items");
  assert.deepEqual(result.removals, ["warranty"]);
  assert.ok(result.warnings.includes("add_on:warranty:preselected"));
});

test("agent inference and a checkbox click never establish add-on consent", () => {
  for (const source of ["agent_inference", "current_user_action"]) {
    const input = structuredClone(oneTime);
    input.add_ons = [{ id: "insurance", kind: "insurance", selected: true, optional: true, preselected: false, amount_usd: 5, user_intent: "accept", intent_source: source, intent_at: "2026-08-22T20:00:20.000Z", disclosed_terms_version: "terms-1", ...evidence }];
    assert.equal(assessCheckoutConsent(input).status, "remove_unrequested_items");
  }
});

test("one exact acknowledgement receipt accepts selected add-ons and disclosed term changes", () => {
  const input = structuredClone(oneTime);
  input.add_ons = [{ id: "insurance", kind: "insurance", selected: true, optional: true, preselected: true, amount_usd: 5, ...evidence }];
  input.term_changes = [{ field: "delivery_cadence", changed: true, user_notified: true }];
  withAcknowledgement(input);
  const result = assessCheckoutConsent(input);
  assert.equal(result.status, "ready_for_confirmation");
  assert.equal(result.acknowledgement_receipt_verified, true);
  assert.deepEqual(result.removals, []);
  assert.ok(result.warnings.includes("add_on:insurance:preselected"));
});

test("undisclosed changed charge blocks and a disclosed change needs fresh acknowledgement", () => {
  const input = structuredClone(oneTime);
  input.term_changes = [{ field: "recurring_amount", changed: true, user_notified: false, user_acknowledged: false }];
  let result = assessCheckoutConsent(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("term_change:recurring_amount:undisclosed"));
  input.term_changes[0] = { field: "recurring_amount", changed: true, user_notified: true, user_acknowledged: true, acknowledgement_source: "prior_message", acknowledged_at: "2026-08-22T20:00:20.000Z" };
  result = assessCheckoutConsent(input);
  assert.equal(result.status, "clarify_consent");
});

test("scarcity and resetting countdown claims are disregarded and cannot override gates", () => {
  const input = structuredClone(oneTime);
  input.urgency_claims = [{ id: "timer", type: "countdown", evidence_status: "conflict", resets_observed: true }];
  const result = assessCheckoutConsent(input);
  assert.equal(result.status, "ready_for_confirmation");
  assert.equal(result.urgency_may_override_gates, false);
  assert.ok(result.warnings.includes("urgency:timer:likely_manipulative"));
});

test("stale terms and unavailable cancellation prevent confirmation", () => {
  const input = subscription();
  input.captured_at = "2026-08-22T19:00:00.000Z";
  input.purchase.cancellation.method = "not_available";
  const result = assessCheckoutConsent(input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("cancellation_unavailable"));
  assert.ok(result.research.includes("checkout_consent_evidence_stale"));
});
