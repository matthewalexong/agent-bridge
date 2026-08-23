import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedCheckoutTermsEvidence } from "../lib/shopping-browser-evidence.mjs";
import { assessCheckoutConsentFromEvidence, checkoutConsentInputFromSignedEvidence } from "../lib/shopping-checkout-consent-evidence.mjs";
import { createShoppingCheckoutPatternRegistry, validateCheckoutPatternEvidence } from "../lib/shopping-checkout-patterns.mjs";

const times = ["2026-08-22T20:00:00.000Z", "2026-08-22T20:00:30.000Z", "2026-08-22T20:01:00.000Z", "2026-08-22T20:01:30.000Z"];

function page({ recurring = 20, addOn = true, countdown = 300, scarcity = 2, restock = false, change = null } = {}) {
  return [
    "Offer ID: offer-a", "Product Key: camera-x", "Purchase Type: subscription", "Terms Version: terms-1", "Terms Inventory: complete", "Initial Charge: $0.00",
    `Recurring Charge: $${recurring}.00`, "Recurring Cadence: monthly", "First Recurring Charge: 2026-09-22T20:00:00.000Z", "Auto Renews: yes", "Minimum Cycles: 0",
    "Cancellation Method: online", "Cancellation Terms: complete", "Cancellation Deadline: Before renewal", "Cancellation Fee: $0.00",
    "Add-on Inventory: complete", `Add-on: id=warranty; kind=warranty; selected=${addOn ? "yes" : "no"}; optional=yes; preselected=no; amount=$10.00`,
    "Term Change Inventory: complete", ...(change ? [`Term Change: field=${change}; disclosed=yes`] : []),
    "Urgency Inventory: complete", `Urgency Claim: id=deal-clock; type=countdown; remaining_seconds=${countdown}`, `Urgency Claim: id=stock-left; type=scarcity; count=${scarcity}; restock_observed=${restock ? "yes" : "no"}`,
  ].join("\n");
}

function artifact(index, text = page(), url = "https://shop.example/checkout") {
  const registry = createBrowserEvidenceRegistry();
  const snapshotId = `checkout-pattern-${index}`;
  registry.capture({ tab_id: 8, captured_at: times[index], snapshot: { snapshotId, title: "Checkout", url, text, truncated: false } });
  return extractBrowserObservedCheckoutTermsEvidence(registry.resolve, { snapshot_id: snapshotId, evaluated_at: times[index] });
}

test("signed history detects and retains countdown, scarcity, and add-on reappearance observations", () => {
  const patterns = createShoppingCheckoutPatternRegistry();
  patterns.observe({ terms_evidence: artifact(0), evaluated_at: times[0] });
  const second = patterns.observe({ terms_evidence: artifact(1, page({ addOn: false, countdown: 295, scarcity: 4 })), evaluated_at: times[1] });
  assert.ok(second.flags.includes("urgency_reset:deal-clock"));
  assert.ok(second.flags.includes("scarcity_count_increased:stock-left"));
  assert.ok(second.warnings.every((item) => !/fraud(?!_finding)/i.test(item)));

  const thirdTerms = artifact(2, page({ addOn: true, countdown: 240, scarcity: 4 }));
  const third = patterns.observe({ terms_evidence: thirdTerms, evaluated_at: times[2] });
  assert.ok(third.flags.includes("selected_add_on_reappeared:warranty"));
  assert.ok(third.flags.includes("urgency_reset:deal-clock"));
  assert.equal(third.urgency_may_override_gates, false);
  assert.equal(third.purchase_allowed, false);
  assert.equal(validateCheckoutPatternEvidence(third, thirdTerms, times[2]), true);
});

test("undisclosed economic changes block while an exact signed disclosure requires fresh acceptance", () => {
  const patterns = createShoppingCheckoutPatternRegistry();
  patterns.observe({ terms_evidence: artifact(0), evaluated_at: times[0] });
  const changedTerms = artifact(1, page({ recurring: 25, countdown: 270 }));
  const undisclosed = patterns.observe({ terms_evidence: changedTerms, evaluated_at: times[1] });
  assert.ok(undisclosed.blockers.includes("checkout_term_change_undisclosed:recurring_amount"));
  const blockedConsent = assessCheckoutConsentFromEvidence({ terms_evidence: changedTerms, pattern_evidence: undisclosed, evaluated_at: times[1] });
  assert.equal(blockedConsent.status, "blocked");
  assert.equal(blockedConsent.checkout_pattern_attestation, undisclosed.artifact_attestation);
  assert.ok(blockedConsent.blockers.includes("checkout_term_change_undisclosed:recurring_amount"));

  const disclosedPatterns = createShoppingCheckoutPatternRegistry();
  disclosedPatterns.observe({ terms_evidence: artifact(0), evaluated_at: times[0] });
  const disclosedTerms = artifact(1, page({ recurring: 25, countdown: 270, change: "recurring_amount" }));
  const disclosed = disclosedPatterns.observe({ terms_evidence: disclosedTerms, evaluated_at: times[1] });
  assert.ok(disclosed.flags.includes("checkout_term_changed:recurring_amount"));
  assert.equal(disclosed.blockers.includes("checkout_term_change_undisclosed:recurring_amount"), false);
  const consentInput = checkoutConsentInputFromSignedEvidence({ terms_evidence: disclosedTerms, pattern_evidence: disclosed, evaluated_at: times[1] });
  assert.equal(consentInput.checkout_pattern_attestation, disclosed.artifact_attestation);
});

test("observations are exact-snapshot bound, idempotent, ordered, and scope isolated", () => {
  const patterns = createShoppingCheckoutPatternRegistry();
  const firstTerms = artifact(0);
  const first = patterns.observe({ terms_evidence: firstTerms, evaluated_at: times[0] });
  assert.deepEqual(patterns.observe({ terms_evidence: firstTerms, evaluated_at: times[0] }), first);

  const sameContentNewSnapshot = artifact(1);
  const second = patterns.observe({ terms_evidence: sameContentNewSnapshot, evaluated_at: times[1] });
  assert.equal(second.observation_count, 2);
  assert.equal(second.latest_terms_attestation, sameContentNewSnapshot.artifact_attestation);
  const olderDifferentSnapshot = artifact(0, page({ countdown: 299 }));
  assert.throws(() => patterns.observe({ terms_evidence: olderDifferentSnapshot, evaluated_at: times[1] }), { code: "shopping_checkout_pattern_out_of_order" });

  const otherScope = artifact(2, page(), "https://other.example/checkout");
  assert.equal(patterns.observe({ terms_evidence: otherScope, evaluated_at: times[2] }).observation_count, 1);
  const tampered = structuredClone(second); tampered.observation_count = 999;
  assert.equal(validateCheckoutPatternEvidence(tampered, sameContentNewSnapshot, times[1]), false);
  assert.equal(validateCheckoutPatternEvidence(second, firstTerms, times[1]), false);
});
