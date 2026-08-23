import { attestShoppingArtifact } from "./shopping-attestation.mjs";
import { validateCheckoutTermsAcknowledgement } from "./shopping-terms-acknowledgement.mjs";

const clean = (value) => String(value ?? "").trim();
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const unique = (items) => [...new Set(items)];

function verified(fact) {
  return fact?.evidence_status === "verified" && clean(fact?.source_id);
}

export function assessCheckoutConsent(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Checkout consent timestamp is invalid"), { code: "shopping_checkout_consent_invalid" });
  const policy = { max_evidence_age_seconds: input.policy?.max_evidence_age_seconds ?? 120, max_acknowledgement_age_seconds: input.policy?.max_acknowledgement_age_seconds ?? 300 };
  const purchase = input.purchase || {};
  const research = [];
  const clarifications = [];
  const blockers = [];
  const removals = [];
  const warnings = [];
  blockers.push(...(input.checkout_pattern_blockers || []));
  warnings.push(...(input.checkout_pattern_warnings || []));

  const capturedAt = Date.parse(input.captured_at || "");
  if (!Number.isFinite(capturedAt)) research.push("checkout_consent_capture_time_unresolved");
  else if (capturedAt > evaluatedAt + 5_000) blockers.push("checkout_consent_capture_time_invalid");
  else if (evaluatedAt - capturedAt > policy.max_evidence_age_seconds * 1_000) research.push("checkout_consent_evidence_stale");

  if (!clean(input.offer_id)) blockers.push("offer_scope_missing");
  if (!clean(purchase.terms_version) || !clean(purchase.disclosed_at)) research.push("terms_version_or_disclosure_time_unresolved");
  if (purchase.terms_inventory_complete !== true || purchase.evidence_status !== "verified" || !clean(purchase.source_id)) research.push("purchase_terms_inventory_unverified");
  if (!verified(purchase.initial_charge) || !finite(purchase.initial_charge?.amount_usd)) research.push("initial_charge_unverified");
  if (input.add_on_inventory_complete !== true) research.push("add_on_inventory_unverified");
  if (input.term_change_inventory_complete !== true) research.push("term_change_inventory_unverified");
  if (input.urgency_inventory_complete !== true) research.push("urgency_inventory_unverified");

  const recurringType = ["subscription", "trial_to_paid", "membership"].includes(purchase.type);
  if (recurringType) {
    const recurring = purchase.recurring;
    if (!verified(recurring) || !finite(recurring?.amount_usd) || !clean(recurring?.cadence) || typeof recurring?.auto_renews !== "boolean" || !clean(recurring?.first_charge_at)) research.push("recurring_terms_unverified");
    if (recurring?.intro_cycles != null && (!Number.isInteger(recurring.intro_cycles) || recurring.intro_cycles < 0 || !finite(recurring.price_after_intro_usd))) research.push("post_intro_price_unverified");
    if (!purchase.cancellation || purchase.cancellation.terms_complete !== true || !verified(purchase.cancellation) || ["unknown", "not_available"].includes(purchase.cancellation.method)) research.push("cancellation_terms_unverified");
    if (purchase.cancellation?.method === "not_available") blockers.push("cancellation_unavailable");
    if (["phone", "mail", "in_person"].includes(purchase.cancellation?.method)) warnings.push("cancellation_method_has_material_friction");
  }
  if (purchase.type === "trial_to_paid") {
    if (!verified(purchase.trial) || !clean(purchase.trial?.ends_at) || purchase.trial?.converts_automatically !== true) research.push("trial_conversion_terms_unverified");
  }
  if (["installment", "preorder_deposit"].includes(purchase.type) && (!purchase.commitment || purchase.commitment.terms_complete !== true || !verified(purchase.commitment))) research.push("commitment_terms_unverified");

  const acknowledgementIsCurrent = validateCheckoutTermsAcknowledgement(input.acknowledgement_receipt, input, evaluatedAt, policy.max_acknowledgement_age_seconds);
  if (recurringType && !acknowledgementIsCurrent) clarifications.push("fresh_user_acknowledgement_required");

  for (const addOn of input.add_ons || []) {
    if (!addOn.selected) continue;
    if (!verified(addOn) || !finite(addOn.amount_usd)) research.push(`add_on:${addOn.id}:terms_unverified`);
    if (addOn.recurring && (!finite(addOn.recurring.amount_usd) || !clean(addOn.recurring.cadence) || !verified(addOn.recurring))) research.push(`add_on:${addOn.id}:recurring_terms_unverified`);
    const currentAcceptance = acknowledgementIsCurrent;
    if (addOn.optional !== false && !currentAcceptance) removals.push(addOn.id);
    if (addOn.preselected === true) warnings.push(`add_on:${addOn.id}:preselected`);
    if (addOn.optional === false && !currentAcceptance) clarifications.push(`add_on:${addOn.id}:required_bundle_acknowledgement_required`);
  }

  for (const change of input.term_changes || []) {
    if (change.changed !== true) continue;
    if (change.user_notified !== true) blockers.push(`term_change:${change.field}:undisclosed`);
    else if (!acknowledgementIsCurrent) clarifications.push(`term_change:${change.field}:fresh_acknowledgement_required`);
  }

  for (const claim of input.urgency_claims || []) {
    if (claim.resets_observed === true || claim.evidence_status === "conflict") warnings.push(`urgency:${claim.id}:likely_manipulative`);
    else if (claim.evidence_status !== "verified" || !clean(claim.source_id)) warnings.push(`urgency:${claim.id}:unverified_disregard`);
  }

  const normalized = { blockers: unique(blockers), research: unique(research), clarifications: unique(clarifications), removals: unique(removals), warnings: unique(warnings) };
  const status = normalized.blockers.length ? "blocked" : normalized.removals.length ? "remove_unrequested_items" : normalized.research.length ? "needs_research" : normalized.clarifications.length ? "clarify_consent" : "ready_for_confirmation";
  return attestShoppingArtifact("checkout_consent", {
    product_id: input.product_id || null,
    offer_id: input.offer_id || null,
    checkout_pattern_attestation: input.checkout_pattern_attestation || null,
    evaluated_at: new Date(evaluatedAt).toISOString(),
    status,
    consent_cleared_for_confirmation: status === "ready_for_confirmation",
    acknowledgement_receipt_verified: acknowledgementIsCurrent,
    ...normalized,
    urgency_may_override_gates: false,
    confirmation_required: true,
    purchase_allowed: false,
    next_action: status === "blocked" ? "stop_checkout" : status === "remove_unrequested_items" ? "remove_unrequested_items_and_reassess" : status === "needs_research" ? "verify_checkout_terms" : status === "clarify_consent" ? "present_terms_and_request_fresh_user_acknowledgement" : "compose_final_checkout_summary_and_request_new_confirmation",
  });
}
