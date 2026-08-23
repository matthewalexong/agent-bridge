import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { assessShoppingFulfillment } from "./shopping-fulfillment.mjs";

const CHARGES = ["shipping", "tax", "import_duty", "brokerage", "carrier_surcharge", "currency_conversion"];
const normalized = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function evaluatedMillis(value) {
  const result = typeof value === "number" ? value : value == null ? Date.now() : Date.parse(value);
  if (!Number.isFinite(result)) throw coded("Fulfillment evaluation time is invalid", "shopping_fulfillment_evidence_invalid");
  return result;
}

function validatePageEvidence(artifact, { evaluated_at, max_age_seconds, kinds, marker = null, required = true } = {}) {
  if (artifact == null && !required) return null;
  if (!verifyShoppingArtifactAttestation("page_evidence", artifact)
    || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)) {
    throw coded("Fulfillment facts require untampered shopping_page_evidence", "shopping_fulfillment_page_evidence_invalid");
  }
  if (!kinds.includes(artifact?.source?.page_kind)) {
    throw coded(`Unexpected fulfillment page kind: ${artifact?.source?.page_kind || "missing"}`, "shopping_fulfillment_page_evidence_scope");
  }
  const captured = Date.parse(artifact.source?.captured_at || "");
  const receiptCaptured = Date.parse(artifact.source_receipt?.captured_at || "");
  const evaluated = evaluatedMillis(evaluated_at);
  if (!Number.isFinite(captured) || captured !== receiptCaptured
    || artifact.source?.url !== artifact.source_receipt?.url
    || artifact.source_receipt?.source_id !== artifact.source_receipt?.snapshot_id
    || artifact.source_receipt?.truncated === true
    || captured > evaluated + 5_000 || evaluated - captured > max_age_seconds * 1_000) {
    throw coded("Fulfillment page evidence is stale, truncated, or has inconsistent provenance", "shopping_fulfillment_page_evidence_stale");
  }
  if (marker && artifact.facts?.document_markers?.[marker]?.value !== true) {
    throw coded(`Fulfillment evidence lacks an explicit ${marker} marker`, "shopping_fulfillment_page_evidence_scope");
  }
  return artifact;
}

function explicit(artifact, path) {
  let value = artifact?.facts;
  for (const key of path.split(".")) value = value?.[key];
  return value?.status === "explicit" ? value.value : null;
}

function resolveIdentity(identity, offerId, evaluatedAt, maxAgeSeconds) {
  if (!verifyShoppingArtifactAttestation("identity", identity)) {
    throw coded("Fulfillment assessment requires an untampered identity artifact", "shopping_fulfillment_identity_invalid");
  }
  const artifactAt = Date.parse(identity.evaluated_at || "");
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > maxAgeSeconds * 1_000) {
    throw coded("Fulfillment identity evidence is stale", "shopping_fulfillment_identity_stale");
  }
  const resolution = identity.resolutions?.find((item) => normalized(item?.candidate_id) === normalized(offerId));
  if (!resolution) throw coded("Identity artifact does not cover the fulfillment offer", "shopping_fulfillment_identity_scope");
  return resolution;
}

function exactMoney(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

function verifiedMoney(value) {
  const amount = exactMoney(value);
  return amount == null ? { evidence_status: "unknown" } : { amount_usd: amount, evidence_status: "verified" };
}

function chargeFromEvidence(kind, checkout, listing) {
  if (kind === "shipping") {
    const checkoutValue = exactMoney(explicit(checkout, "shipping_usd"));
    const listingValue = exactMoney(explicit(listing, "shipping_usd"));
    if (checkoutValue != null && listingValue != null && checkoutValue !== listingValue) {
      throw coded("Listing and checkout shipping amounts conflict", "shopping_fulfillment_page_evidence_conflict");
    }
    const amount = checkoutValue ?? listingValue;
    return amount == null ? { kind, treatment: "unknown", evidence_status: "unknown" }
      : { kind, treatment: "amount", amount_usd: amount, evidence_status: "verified" };
  }
  const field = `fulfillment.${kind}_usd`;
  const amount = exactMoney(explicit(checkout, field));
  const treatment = explicit(checkout, `fulfillment.${kind}_treatment`);
  if (amount != null && treatment && treatment !== "amount") {
    throw coded(`Checkout ${kind} amount conflicts with its treatment`, "shopping_fulfillment_page_evidence_conflict");
  }
  if (amount != null) return { kind, treatment: "amount", amount_usd: amount, evidence_status: "verified" };
  if (["included", "not_applicable"].includes(treatment)) return { kind, treatment, evidence_status: "verified" };
  return { kind, treatment: "unknown", evidence_status: "unknown" };
}

function reconcileScope(candidate, listing, checkout, productId, destinationCountry) {
  const offerId = explicit(checkout, "fulfillment.offer_id");
  const checkoutProduct = explicit(checkout, "fulfillment.product_id");
  const checkoutDestination = explicit(checkout, "fulfillment.destination_country");
  if (offerId && normalized(offerId) !== normalized(candidate.id)) throw coded("Checkout evidence covers another offer", "shopping_fulfillment_page_evidence_scope");
  if (checkoutProduct && normalized(checkoutProduct) !== normalized(productId)) throw coded("Checkout evidence covers another product", "shopping_fulfillment_page_evidence_scope");
  if (checkoutDestination && normalized(checkoutDestination) !== normalized(destinationCountry)) throw coded("Checkout evidence covers another destination", "shopping_fulfillment_page_evidence_scope");
  const listingSeller = explicit(listing, "seller");
  const checkoutSeller = explicit(checkout, "seller");
  if (listingSeller && checkoutSeller && normalized(listingSeller) !== normalized(checkoutSeller)) {
    throw coded("Listing and checkout identify different sellers", "shopping_fulfillment_page_evidence_conflict");
  }
}

function sourceReceipt(artifact) {
  if (!artifact) return null;
  return {
    artifact_attestation: artifact.artifact_attestation,
    source_id: artifact.source_receipt?.source_id || null,
    url: artifact.source?.url || null,
    captured_at: artifact.source?.captured_at || null,
    content_sha256: artifact.source_receipt?.content_sha256 || null,
  };
}

export function assessShoppingFulfillmentFromEvidence(input) {
  const evaluatedAt = evaluatedMillis(input.evaluated_at);
  if ((input.promotion_artifacts || []).some((artifact) => !verifyShoppingArtifactAttestation("promotion", artifact))) {
    throw coded("Only process-attested promotion artifacts can alter a signed fulfillment ledger", "shopping_fulfillment_promotion_evidence_invalid");
  }
  const evaluatedIso = new Date(evaluatedAt).toISOString();
  const maxPageAge = input.max_page_evidence_age_seconds ?? 300;
  const maxIdentityAge = input.max_identity_age_seconds ?? 3_600;
  const offers = (input.offers || []).map((candidate) => {
    const listing = validatePageEvidence(candidate.listing_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["retailer_listing"] });
    const checkout = validatePageEvidence(candidate.checkout_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["checkout"], marker: "checkout", required: false });
    const returns = validatePageEvidence(candidate.return_policy_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["return_policy"], marker: "return_policy", required: false });
    const identity = resolveIdentity(input.identity, candidate.id, evaluatedAt, maxIdentityAge);
    const exactIdentity = identity.classification === "exact_match" && identity.safe_to_compare_offers === true;
    const productId = input.identity.target_product_id;
    reconcileScope(candidate, listing, checkout, productId, input.destination_country);
    const currency = explicit(checkout, "fulfillment.currency") || explicit(listing, "fulfillment.currency");
    if (currency && currency !== "USD") throw coded("Fulfillment USD fields cannot be derived from a non-USD page", "shopping_fulfillment_page_evidence_scope");

    const listingItem = exactMoney(explicit(listing, "price_usd"));
    const checkoutItem = exactMoney(explicit(checkout, "fulfillment.item_price_usd"));
    if (listingItem != null && checkoutItem != null && listingItem !== checkoutItem) {
      throw coded("Listing and checkout item prices conflict", "shopping_fulfillment_page_evidence_conflict");
    }
    const itemPrice = checkoutItem ?? listingItem;
    const charges = CHARGES.map((kind) => chargeFromEvidence(kind, checkout, listing));
    const shipsFrom = explicit(checkout, "fulfillment.ships_from_country") || explicit(listing, "fulfillment.ships_from_country");
    const destinationEligible = explicit(checkout, "fulfillment.destination_eligible");
    const incotermRaw = explicit(checkout, "fulfillment.incoterm");
    const incoterm = incotermRaw && incotermRaw !== "domestic" && incotermRaw !== "unknown" ? incotermRaw.toUpperCase() : incotermRaw;
    return {
      id: candidate.id,
      product_id: productId,
      exact_identity: exactIdentity,
      promotion_claimed: Boolean((input.promotion_artifacts || []).some((item) => normalized(item?.offer_id) === normalized(candidate.id))),
      ships_from_country: shipsFrom,
      destination_eligible: destinationEligible,
      item_price: verifiedMoney(itemPrice),
      charges,
      incoterm: incoterm || "unknown",
      incoterm_evidence_status: incoterm && incoterm !== "unknown" ? "verified" : "unknown",
      customs: {
        restricted_or_prohibited: explicit(checkout, "fulfillment.customs_restricted_or_prohibited"),
        clearance_responsibility: explicit(checkout, "fulfillment.customs_clearance_responsibility") || "unknown",
        documents_complete: explicit(checkout, "fulfillment.customs_documents_complete"),
      },
      delivery: {
        earliest_at: explicit(checkout, "fulfillment.delivery_earliest_at"),
        latest_at: explicit(checkout, "fulfillment.delivery_latest_at"),
        evidence_status: explicit(checkout, "fulfillment.delivery_earliest_at") && explicit(checkout, "fulfillment.delivery_latest_at") ? "verified" : "unknown",
        tracking_available: explicit(checkout, "fulfillment.tracking_available"),
      },
      returns: {
        policy_verified: Boolean(returns),
        destination_country: explicit(returns, "fulfillment.return_destination_country"),
        shipping_paid_by: explicit(returns, "return_shipping_paid_by") || "unknown",
        shipping_cost: verifiedMoney(explicit(returns, "return_shipping_cost_usd")),
        refundable_import_charges: explicit(returns, "fulfillment.refundable_import_charges"),
      },
    };
  });

  const calculated = assessShoppingFulfillment({
    evaluated_at: evaluatedIso,
    destination_country: input.destination_country,
    requirements: input.requirements || {},
    offers,
    promotion_artifacts: input.promotion_artifacts || [],
    max_promotion_age_seconds: input.max_promotion_age_seconds ?? 900,
  });
  for (const [index, assessment] of calculated.assessments.entries()) {
    const statedTotal = exactMoney(explicit(input.offers[index]?.checkout_evidence, "fulfillment.total_usd"));
    const calculatedTotal = assessment.fully_landed_total_usd;
    if (statedTotal != null && calculatedTotal
      && (statedTotal !== calculatedTotal.low_usd || statedTotal !== calculatedTotal.expected_usd || statedTotal !== calculatedTotal.high_usd)) {
      throw coded("Checkout total conflicts with the signed component ledger", "shopping_fulfillment_page_evidence_conflict");
    }
  }
  const evidence_receipts = (input.offers || []).map((candidate) => ({
    offer_id: candidate.id,
    listing: sourceReceipt(candidate.listing_evidence),
    checkout: sourceReceipt(candidate.checkout_evidence),
    return_policy: sourceReceipt(candidate.return_policy_evidence),
  }));
  return attestShoppingArtifact("fulfillment", { ...calculated, evidence_receipts });
}

export function validateShoppingFulfillmentArtifact(artifact, evaluated_at = Date.now(), max_age_seconds = 900) {
  if (!verifyShoppingArtifactAttestation("fulfillment", artifact)) return false;
  const evaluated = evaluatedMillis(evaluated_at);
  const artifactAt = Date.parse(artifact.evaluated_at || "");
  return Number.isFinite(artifactAt) && artifactAt <= evaluated + 5_000 && evaluated - artifactAt <= max_age_seconds * 1_000;
}
