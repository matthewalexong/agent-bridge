import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { assessShoppingPromotion } from "./shopping-promotion.mjs";

const normalized = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const CONSEQUENTIAL_TYPES = new Set(["membership_price", "subscription_price"]);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function evaluatedMillis(value) {
  const result = typeof value === "number" ? value : value == null ? Date.now() : Date.parse(value);
  if (!Number.isFinite(result)) throw coded("Promotion evaluation time is invalid", "shopping_promotion_evidence_invalid");
  return result;
}

function validatePageEvidence(artifact, { evaluated_at, max_age_seconds, kind, marker = null } = {}) {
  if (!verifyShoppingArtifactAttestation("page_evidence", artifact)
    || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)) {
    throw coded("Promotion facts require untampered shopping_page_evidence", "shopping_promotion_page_evidence_invalid");
  }
  if (artifact?.source?.page_kind !== kind) throw coded(`Unexpected promotion page kind: ${artifact?.source?.page_kind || "missing"}`, "shopping_promotion_page_evidence_scope");
  const captured = Date.parse(artifact.source?.captured_at || "");
  const receiptCaptured = Date.parse(artifact.source_receipt?.captured_at || "");
  const evaluated = evaluatedMillis(evaluated_at);
  if (!Number.isFinite(captured) || captured !== receiptCaptured
    || artifact.source?.url !== artifact.source_receipt?.url
    || artifact.source_receipt?.source_id !== artifact.source_receipt?.snapshot_id
    || artifact.source_receipt?.truncated === true
    || captured > evaluated + 5_000 || evaluated - captured > max_age_seconds * 1_000) {
    throw coded("Promotion page evidence is stale, truncated, or has inconsistent provenance", "shopping_promotion_page_evidence_stale");
  }
  if (marker && artifact.facts?.document_markers?.[marker]?.value !== true) throw coded(`Promotion evidence lacks an explicit ${marker} marker`, "shopping_promotion_page_evidence_scope");
  return artifact;
}

function explicit(artifact, path) {
  let value = artifact?.facts;
  for (const key of path.split(".")) value = value?.[key];
  return value?.status === "explicit" ? value.value : null;
}

function resolveIdentity(identity, offerId, evaluatedAt, maxAgeSeconds) {
  if (!verifyShoppingArtifactAttestation("identity", identity)) throw coded("Promotion assessment requires an untampered identity artifact", "shopping_promotion_identity_invalid");
  const artifactAt = Date.parse(identity.evaluated_at || "");
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > maxAgeSeconds * 1_000) throw coded("Promotion identity evidence is stale", "shopping_promotion_identity_stale");
  const resolution = identity.resolutions?.find((item) => normalized(item?.candidate_id) === normalized(offerId));
  if (!resolution) throw coded("Identity artifact does not cover the promotion offer", "shopping_promotion_identity_scope");
  return resolution;
}

function money(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

function reconcileScope(input, listing, checkout) {
  const checkoutOffer = explicit(checkout, "fulfillment.offer_id");
  const checkoutProduct = explicit(checkout, "fulfillment.product_id");
  if (!checkoutOffer || normalized(checkoutOffer) !== normalized(input.offer_id)) throw coded("Signed checkout does not identify the exact promotion offer", "shopping_promotion_page_evidence_scope");
  if (!checkoutProduct || normalized(checkoutProduct) !== normalized(input.identity.target_product_id)) throw coded("Signed checkout does not identify the promotion product", "shopping_promotion_page_evidence_scope");
  const listingSeller = explicit(listing, "seller");
  const checkoutSeller = explicit(checkout, "seller");
  if (!listingSeller || !checkoutSeller || normalized(listingSeller) !== normalized(checkoutSeller)) throw coded("Listing and checkout seller scope is missing or conflicting", "shopping_promotion_page_evidence_conflict");
}

export function assessShoppingPromotionFromEvidence(input) {
  const evaluatedAt = evaluatedMillis(input.evaluated_at);
  const evaluatedIso = new Date(evaluatedAt).toISOString();
  const maxPageAge = input.max_page_evidence_age_seconds ?? 300;
  const maxIdentityAge = input.max_identity_age_seconds ?? 3_600;
  const listing = validatePageEvidence(input.listing_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kind: "retailer_listing" });
  const checkout = validatePageEvidence(input.checkout_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kind: "checkout", marker: "promotion_inventory" });
  const identity = resolveIdentity(input.identity, input.offer_id, evaluatedAt, maxIdentityAge);
  reconcileScope(input, listing, checkout);

  const listingPrice = money(explicit(listing, "price_usd"));
  const checkoutPrice = money(explicit(checkout, "fulfillment.item_price_usd"));
  const listingShipping = money(explicit(listing, "shipping_usd"));
  const checkoutShipping = money(explicit(checkout, "shipping_usd"));
  if (listingPrice != null && checkoutPrice != null && listingPrice !== checkoutPrice) throw coded("Listing and checkout prices conflict", "shopping_promotion_page_evidence_conflict");
  if (listingShipping != null && checkoutShipping != null && listingShipping !== checkoutShipping) throw coded("Listing and checkout shipping conflicts", "shopping_promotion_page_evidence_conflict");
  const sourceId = checkout.source_receipt.source_id;
  const records = Array.isArray(checkout.facts?.promotions) ? checkout.facts.promotions : [];
  const seen = new Set();
  const promotions = records.map((record) => {
    const id = String(record?.id || "").trim();
    if (!id || seen.has(normalized(id))) throw coded("Promotion identifiers must be present and unique", "shopping_promotion_page_evidence_conflict");
    seen.add(normalized(id));
    const consequential = CONSEQUENTIAL_TYPES.has(record.type);
    return {
      id,
      type: record.type || "unknown",
      code: record.code || undefined,
      application_status: record.application_status || "unknown",
      affects_advertised_price: record.affects_advertised_price === true,
      amount_applied_usd: money(record.amount_applied_usd) ?? undefined,
      deferred_value_usd: money(record.deferred_value_usd) ?? undefined,
      expires_at: record.expires_at || undefined,
      eligibility_complete: record.eligibility_complete === true,
      eligibility: [],
      stacking: { verified: record.stacking_verified === true, source_id: record.stacking_verified === true ? sourceId : undefined },
      obligations_complete: consequential ? false : record.obligations_complete === true,
      obligations: [],
      evidence_status: "verified",
      source_id: sourceId,
    };
  });
  const basePrice = checkoutPrice ?? listingPrice;
  const shipping = checkoutShipping ?? listingShipping;
  const raw = assessShoppingPromotion({
    evaluated_at: evaluatedIso,
    policy: input.policy || {},
    offer: {
      id: input.offer_id,
      product_id: input.identity.target_product_id,
      exact_identity: identity.classification === "exact_match" && identity.safe_to_compare_offers === true,
      captured_at: checkout.source.captured_at,
      base_price: { value: basePrice, evidence_status: basePrice == null ? "unknown" : "verified", source_id: sourceId },
      shipping: { value: shipping, evidence_status: shipping == null ? "unknown" : "verified", source_id: sourceId },
      promotion_inventory_complete: true,
      promotion_inventory_evidence_status: "verified",
      promotion_inventory_source_id: sourceId,
      promotions,
    },
  });
  const signedDiscount = money(explicit(checkout, "fulfillment.discount_usd"));
  if (signedDiscount != null && signedDiscount !== raw.immediate_checkout_discount_usd) throw coded("Signed checkout discount conflicts with promotion inventory", "shopping_promotion_page_evidence_conflict");
  return attestShoppingArtifact("promotion", {
    ...raw,
    evidence_receipts: {
      listing: { artifact_attestation: listing.artifact_attestation, source_id: listing.source_receipt.source_id, url: listing.source.url, captured_at: listing.source.captured_at, content_sha256: listing.source_receipt.content_sha256 },
      checkout: { artifact_attestation: checkout.artifact_attestation, source_id: checkout.source_receipt.source_id, url: checkout.source.url, captured_at: checkout.source.captured_at, content_sha256: checkout.source_receipt.content_sha256 },
    },
  });
}
