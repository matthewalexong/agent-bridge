import crypto from "node:crypto";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { issueShoppingRequestReceipt } from "./shopping-request-intent.mjs";

const clean = (value) => String(value ?? "").normalize("NFKC").trim();
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const verified = (value) => value?.evidence_status === "verified" && clean(value?.source_id);
const recurringType = (type) => ["subscription", "trial_to_paid", "membership"].includes(type);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function time(value, code) {
  const result = typeof value === "number" ? value : Date.parse(value || "");
  if (!Number.isFinite(result)) throw coded("Checkout terms acknowledgement time is invalid", code);
  return result;
}

function clone(value) {
  return value == null ? null : structuredClone(value);
}

export function checkoutTermsAcceptanceScope(input) {
  const selectedAddOns = (input.add_ons || []).filter((item) => item?.selected === true)
    .map(clone).sort((left, right) => clean(left.id).localeCompare(clean(right.id)));
  const changedTerms = (input.term_changes || []).filter((item) => item?.changed === true)
    .map(clone).sort((left, right) => clean(left.field).localeCompare(clean(right.field)));
  const scope = {
    product_id: clean(input.product_id),
    offer_id: clean(input.offer_id),
    purchase: clone(input.purchase || {}),
    selected_add_ons: selectedAddOns,
    changed_terms: changedTerms,
    checkout_pattern_attestation: input.checkout_pattern_attestation || null,
    observed_checkout_warnings: [...new Set(input.checkout_pattern_warnings || [])].sort(),
  };
  return { scope, scope_sha256: digest(scope) };
}

export function checkoutTermsAcknowledgementRequired(input) {
  return recurringType(input.purchase?.type)
    || (input.add_ons || []).some((item) => item?.selected === true)
    || (input.term_changes || []).some((item) => item?.changed === true);
}

function validateDisclosure(input, evaluatedAt, maxAgeSeconds) {
  const purchase = input.purchase || {};
  if ((input.checkout_pattern_blockers || []).length) throw coded("Observed undisclosed checkout changes must be resolved before acknowledgement", "shopping_terms_pattern_blocked");
  if (input.add_on_inventory_complete !== true || input.term_change_inventory_complete !== true || input.urgency_inventory_complete !== true) {
    throw coded("Complete add-on, changed-term, and urgency inventories are required before acknowledgement", "shopping_terms_disclosure_incomplete");
  }
  if (!clean(input.product_id) || !clean(input.offer_id) || !clean(purchase.type) || !clean(purchase.terms_version)
    || purchase.terms_inventory_complete !== true || !verified(purchase)
    || !verified(purchase.initial_charge) || !finite(purchase.initial_charge?.amount_usd)) {
    throw coded("Complete verified purchase terms are required before acknowledgement", "shopping_terms_disclosure_incomplete");
  }
  const disclosedAt = time(purchase.disclosed_at, "shopping_terms_disclosure_incomplete");
  if (disclosedAt > evaluatedAt + 5_000 || evaluatedAt - disclosedAt > maxAgeSeconds * 1_000) {
    throw coded("Purchase terms disclosure is stale or future-dated", "shopping_terms_disclosure_stale");
  }
  if (recurringType(purchase.type)) {
    const recurring = purchase.recurring;
    const cancellation = purchase.cancellation;
    if (!verified(recurring) || !finite(recurring?.amount_usd) || !clean(recurring?.cadence)
      || typeof recurring?.auto_renews !== "boolean" || !clean(recurring?.first_charge_at)
      || !verified(cancellation) || cancellation?.terms_complete !== true
      || ["unknown", "not_available", ""].includes(clean(cancellation?.method))) {
      throw coded("Complete recurring and cancellation terms are required before acknowledgement", "shopping_terms_disclosure_incomplete");
    }
    if (recurring.intro_cycles != null && (!Number.isInteger(recurring.intro_cycles) || recurring.intro_cycles < 0 || !finite(recurring.price_after_intro_usd))) {
      throw coded("Post-intro recurring price is incomplete", "shopping_terms_disclosure_incomplete");
    }
  }
  if (purchase.type === "trial_to_paid" && (!verified(purchase.trial) || !clean(purchase.trial?.ends_at) || purchase.trial?.converts_automatically !== true)) {
    throw coded("Trial conversion terms are incomplete", "shopping_terms_disclosure_incomplete");
  }
  if (["installment", "preorder_deposit"].includes(purchase.type) && (!verified(purchase.commitment) || purchase.commitment?.terms_complete !== true)) {
    throw coded("Commitment terms are incomplete", "shopping_terms_disclosure_incomplete");
  }
  for (const addOn of (input.add_ons || []).filter((item) => item?.selected === true)) {
    if (!clean(addOn.id) || !verified(addOn) || !finite(addOn.amount_usd)
      || (addOn.recurring && (!verified(addOn.recurring) || !finite(addOn.recurring.amount_usd) || !clean(addOn.recurring.cadence)))) {
      throw coded("Selected add-on terms are incomplete", "shopping_terms_disclosure_incomplete");
    }
  }
  if ((input.term_changes || []).some((item) => item?.changed === true && item?.user_notified !== true)) {
    throw coded("Changed terms must be disclosed before acknowledgement", "shopping_terms_change_undisclosed");
  }
}

function acknowledgements(input) {
  const purchase = input.purchase || {};
  const items = [];
  if (recurringType(purchase.type)) {
    items.push("purchase_type", "recurring_charge", "cancellation_terms");
    if (purchase.type === "trial_to_paid") items.push("trial_conversion");
    if ((purchase.recurring?.minimum_cycles ?? 0) > 0) items.push("minimum_commitment");
    if (["phone", "mail", "in_person"].includes(purchase.cancellation?.method)) items.push("cancellation_friction");
  }
  for (const addOn of (input.add_ons || []).filter((item) => item?.selected === true)) items.push(`add_on:${addOn.id}`);
  for (const change of (input.term_changes || []).filter((item) => item?.changed === true)) items.push(`term_change:${change.field}`);
  return [...new Set(items)];
}

export function validateCheckoutTermsAcknowledgement(receipt, input, evaluated_at, max_age_seconds = 300) {
  try {
    if (!verifyShoppingArtifactAttestation("checkout_terms_acknowledgement", receipt)) return false;
    const { scope_sha256 } = checkoutTermsAcceptanceScope(input);
    if (receipt.scope_sha256 !== scope_sha256
      || clean(receipt.product_id).toLowerCase() !== clean(input.product_id).toLowerCase()
      || clean(receipt.offer_id).toLowerCase() !== clean(input.offer_id).toLowerCase()
      || clean(receipt.terms_version) !== clean(input.purchase?.terms_version)) return false;
    const evaluatedAt = time(evaluated_at, "shopping_terms_acknowledgement_invalid");
    const acceptedAt = time(receipt.accepted_at, "shopping_terms_acknowledgement_invalid");
    const disclosedAt = time(input.purchase?.disclosed_at, "shopping_terms_acknowledgement_invalid");
    return acceptedAt >= disclosedAt && acceptedAt <= evaluatedAt + 5_000 && evaluatedAt - acceptedAt <= max_age_seconds * 1_000;
  } catch {
    return false;
  }
}

export function createShoppingTermsAcknowledgementRegistry({ resolve_panel_request, max_entries = 100 } = {}) {
  const entries = new Map();

  function issue({ input, evaluated_at = Date.now(), expires_in_seconds = 300 }) {
    const evaluatedAt = time(evaluated_at, "shopping_terms_time_invalid");
    if (!Number.isInteger(expires_in_seconds) || expires_in_seconds < 30 || expires_in_seconds > 900) throw coded("Terms challenge expiry must be 30-900 seconds", "shopping_terms_expiry_invalid");
    if (!checkoutTermsAcknowledgementRequired(input)) throw coded("These checkout terms do not require a separate acknowledgement", "shopping_terms_acknowledgement_not_required");
    validateDisclosure(input, evaluatedAt, expires_in_seconds);
    const { scope, scope_sha256 } = checkoutTermsAcceptanceScope(input);
    const code = crypto.randomBytes(6).toString("hex").toUpperCase();
    const challenge = attestShoppingArtifact("checkout_terms_challenge", {
      challenge_id: `checkout_terms_${crypto.randomBytes(16).toString("hex")}`,
      product_id: scope.product_id,
      offer_id: scope.offer_id,
      terms_version: scope.purchase.terms_version,
      issued_at: new Date(evaluatedAt).toISOString(),
      expires_at: new Date(evaluatedAt + expires_in_seconds * 1_000).toISOString(),
      scope_sha256,
      terms_summary: scope,
      required_acknowledgements: acknowledgements(input),
      required_response: `ACCEPT TERMS ${code}`,
      purchase_allowed: false,
      external_submission_allowed: false,
    });
    entries.set(challenge.challenge_id, { challenge, status: "issued" });
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return structuredClone(challenge);
  }

  async function accept({ challenge, request_id, evaluated_at = Date.now() }) {
    const evaluatedAt = time(evaluated_at, "shopping_terms_time_invalid");
    if (!verifyShoppingArtifactAttestation("checkout_terms_challenge", challenge)) throw coded("Checkout terms challenge is forged or altered", "shopping_terms_challenge_invalid");
    const entry = entries.get(challenge.challenge_id);
    if (!entry || entry.challenge.artifact_attestation !== challenge.artifact_attestation) throw coded("Checkout terms challenge is not active in this process", "shopping_terms_challenge_not_found");
    if (entry.status !== "issued") throw coded("Checkout terms challenge was already consumed", "shopping_terms_replayed");
    const issuedAt = time(challenge.issued_at, "shopping_terms_challenge_invalid");
    const expiresAt = time(challenge.expires_at, "shopping_terms_challenge_invalid");
    if (evaluatedAt < issuedAt || evaluatedAt > expiresAt) throw coded("Checkout terms challenge expired", "shopping_terms_expired");
    if (typeof resolve_panel_request !== "function") throw coded("Panel terms acknowledgement resolution is unavailable", "shopping_terms_unavailable");
    entry.status = "resolving";
    try {
      const request = await resolve_panel_request(request_id);
      const message = issueShoppingRequestReceipt(request);
      const capturedAt = time(message.captured_at, "shopping_terms_message_invalid");
      if (capturedAt < issuedAt || capturedAt > expiresAt || capturedAt > evaluatedAt + 5_000) throw coded("Terms acknowledgement message is not new and within the challenge window", "shopping_terms_message_stale");
      if (clean(message.text).toUpperCase() !== challenge.required_response) throw coded("Terms acknowledgement must exactly match the one-time response", "shopping_terms_response_mismatch");
      const receipt = attestShoppingArtifact("checkout_terms_acknowledgement", {
        acknowledgement_id: `checkout_terms_ack_${digest(`${challenge.challenge_id}:${message.artifact_id}`).slice(0, 32)}`,
        challenge_id: challenge.challenge_id,
        product_id: challenge.product_id,
        offer_id: challenge.offer_id,
        terms_version: challenge.terms_version,
        scope_sha256: challenge.scope_sha256,
        accepted_acknowledgements: challenge.required_acknowledgements,
        user_message_receipt_id: message.artifact_id,
        user_message_sha256: message.message_sha256,
        accepted_at: message.captured_at,
        recorded_at: new Date(evaluatedAt).toISOString(),
        purchase_allowed: false,
        external_submission_allowed: false,
      });
      entry.status = "consumed";
      return structuredClone(receipt);
    } catch (error) {
      entry.status = "issued";
      throw error;
    }
  }

  return { issue, accept, size: () => entries.size };
}
