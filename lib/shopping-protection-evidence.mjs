import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { assessShoppingProtection } from "./shopping-protection.mjs";

const normalized = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function evaluatedMillis(value) {
  const result = value == null ? Date.now() : Date.parse(value);
  if (!Number.isFinite(result)) throw coded("Protection evaluation time is invalid", "shopping_protection_evidence_invalid");
  return result;
}

function validatePageEvidence(artifact, { evaluated_at, max_age_seconds, kinds, required = true, marker = null } = {}) {
  if (artifact == null && !required) return null;
  if (!verifyShoppingArtifactAttestation("page_evidence", artifact)
    || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)) {
    throw coded("Protection facts require an untampered shopping_page_evidence artifact", "shopping_protection_page_evidence_invalid");
  }
  if (!kinds.includes(artifact?.source?.page_kind)) {
    throw coded(`Unexpected protection page evidence kind: ${artifact?.source?.page_kind || "missing"}`, "shopping_protection_page_evidence_scope");
  }
  const captured = Date.parse(artifact.source?.captured_at || "");
  const receiptCaptured = Date.parse(artifact.source_receipt?.captured_at || "");
  const evaluated = evaluatedMillis(evaluated_at);
  if (!Number.isFinite(captured) || captured !== receiptCaptured
    || artifact.source?.url !== artifact.source_receipt?.url
    || artifact.source_receipt?.source_id !== artifact.source_receipt?.snapshot_id
    || captured > evaluated + 5_000 || evaluated - captured > max_age_seconds * 1_000) {
    throw coded("Protection page evidence is stale or has inconsistent provenance", "shopping_protection_page_evidence_stale");
  }
  if (marker && artifact.facts?.document_markers?.[marker]?.value !== true) {
    throw coded(`The signed page does not contain an explicit ${marker} document marker`, "shopping_protection_page_evidence_scope");
  }
  return artifact;
}

function explicit(artifact, field) {
  const fact = artifact?.facts?.[field];
  return fact?.status === "explicit" ? fact.value : null;
}

function exactMoney(value) {
  return Number.isFinite(value)
    ? { low_usd: value, expected_usd: value, high_usd: value, evidence_status: "verified" }
    : { evidence_status: "unknown" };
}

function resolveIdentity(identity, offerId, evaluatedAt, maxAgeSeconds) {
  if (!verifyShoppingArtifactAttestation("identity", identity)) {
    throw coded("Protection assessment requires an untampered identity artifact", "shopping_protection_identity_invalid");
  }
  const artifactAt = Date.parse(identity.evaluated_at || "");
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > maxAgeSeconds * 1_000) {
    throw coded("Protection identity evidence is stale", "shopping_protection_identity_stale");
  }
  const resolution = identity.resolutions?.find((item) => normalized(item?.candidate_id) === normalized(offerId));
  if (!resolution) throw coded("Identity artifact does not cover the protection offer", "shopping_protection_identity_scope");
  return resolution;
}

function sellerAuthorization(artifact, seller) {
  if (!artifact) return null;
  if (normalized(artifact.extraction_scope?.seller_query) !== normalized(seller)) {
    throw coded("Authorized-seller evidence is scoped to a different protection seller", "shopping_protection_page_evidence_scope");
  }
  const authorization = artifact.facts?.authorization;
  if (authorization?.value === "explicit_match" && authorization.status === "explicit") return true;
  if (authorization?.value === "no_match" && authorization.status === "derived" && artifact.extraction_scope?.directory_complete === true) return false;
  return null;
}

function policyValue(artifact, field, fallback = null) {
  const value = explicit(artifact, field);
  return value == null ? fallback : value;
}

export function assessShoppingProtectionFromEvidence(input) {
  const evaluatedAt = evaluatedMillis(input.evaluated_at);
  const evaluatedIso = new Date(evaluatedAt).toISOString();
  const maxPageAge = input.max_page_evidence_age_seconds ?? 300;
  const maxIdentityAge = input.max_identity_age_seconds ?? 3_600;
  const evidence_receipts = [];
  const candidates = (input.candidates || []).map((candidate) => {
    const listing = validatePageEvidence(candidate.listing_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["retailer_listing"] });
    const returnPolicy = validatePageEvidence(candidate.return_policy_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["return_policy"], marker: "return_policy", required: false });
    const warrantyPolicy = validatePageEvidence(candidate.warranty_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["manufacturer_warranty"], marker: "warranty", required: false });
    const authorization = validatePageEvidence(candidate.authorization_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["manufacturer_authorized_sellers"], required: false });
    const repairPolicy = validatePageEvidence(candidate.repairability_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["repairability"], marker: "repairability", required: false });
    const buyerPolicy = validatePageEvidence(candidate.buyer_protection_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxPageAge, kinds: ["merchant_terms", "checkout"], marker: candidate.buyer_protection_evidence?.source?.page_kind === "checkout" ? "checkout" : "merchant_terms", required: false });
    for (const [kind, artifact] of [["listing", listing], ["return_policy", returnPolicy], ["warranty", warrantyPolicy], ["authorization", authorization], ["repairability", repairPolicy], ["buyer_protection", buyerPolicy]]) {
      if (artifact) evidence_receipts.push({ offer_id: candidate.id, kind, url: artifact.source.url, captured_at: artifact.source.captured_at, artifact_attestation: artifact.artifact_attestation });
    }
    const seller = explicit(listing, "seller");
    if (typeof seller !== "string" || !seller.trim()) {
      throw coded("The signed listing does not expose a seller; take a seller-visible snapshot", "shopping_protection_seller_unresolved");
    }
    const identity = resolveIdentity(input.identity, candidate.id, evaluatedAt, maxIdentityAge);
    const exactProduct = identity.classification === "exact_match" && identity.safe_to_compare_offers === true;
    if (!exactProduct) throw coded("Protection candidate is not an exact identity match", "shopping_protection_identity_scope");
    const condition = ["new", "used", "open_box", "refurbished"].includes(identity.canonical?.condition) ? identity.canonical.condition : "new";
    const itemPrice = explicit(listing, "price_usd");
    const shipping = explicit(listing, "shipping_usd");
    const landed = Number.isFinite(itemPrice) && Number.isFinite(shipping) ? Math.round((itemPrice + shipping) * 100) / 100 : null;
    const finalSale = explicit(returnPolicy, "final_sale");
    const warrantyProvider = explicit(warrantyPolicy, "warranty_provider");
    return {
      id: candidate.id,
      product_id: input.identity.target_product_id,
      variant: identity.offer_variant ?? null,
      condition,
      seller,
      item_price_usd: Number.isFinite(itemPrice) ? itemPrice : null,
      price_verified: Number.isFinite(itemPrice),
      shipping_usd: Number.isFinite(shipping) ? shipping : null,
      shipping_verified: Number.isFinite(shipping),
      landed_total_usd: landed,
      landed_price_verified: Number.isFinite(landed),
      seller_authorized: sellerAuthorization(authorization, seller),
      purchase_date: null,
      delivered_at: null,
      returns: {
        policy_verified: Boolean(returnPolicy),
        final_sale: typeof finalSale === "boolean" ? finalSale : null,
        window_days: policyValue(returnPolicy, "return_days"),
        window_starts_on: policyValue(returnPolicy, "return_window_starts_on", "unknown"),
        opened_items: policyValue(returnPolicy, "opened_items", "unknown"),
        restocking_fee_percent: policyValue(returnPolicy, "restocking_fee_percent"),
        return_shipping_paid_by: policyValue(returnPolicy, "return_shipping_paid_by", "unknown"),
        return_shipping_cost_usd: exactMoney(explicit(returnPolicy, "return_shipping_cost_usd")),
        original_shipping_refundable: policyValue(returnPolicy, "original_shipping_refundable"),
        refund_method: policyValue(returnPolicy, "refund_method", "unknown"),
      },
      warranty: {
        policy_verified: Boolean(warrantyPolicy),
        provider: warrantyProvider || null,
        duration_months: policyValue(warrantyPolicy, "warranty_duration_months"),
        authorized_seller_required: policyValue(warrantyPolicy, "warranty_authorized_seller_required"),
        registration_required: policyValue(warrantyPolicy, "warranty_registration_required"),
        registration_deadline_days: policyValue(warrantyPolicy, "warranty_registration_deadline_days"),
        parts_covered: policyValue(warrantyPolicy, "warranty_parts_covered"),
        labor_covered: policyValue(warrantyPolicy, "warranty_labor_covered"),
        deductible_usd: exactMoney(explicit(warrantyPolicy, "warranty_deductible_usd")),
        claim_shipping_paid_by: policyValue(warrantyPolicy, "warranty_claim_shipping_paid_by", "unknown"),
        claim_shipping_cost_usd: exactMoney(explicit(warrantyPolicy, "warranty_claim_shipping_cost_usd")),
        uncovered_repair_cost_usd: { evidence_status: "unknown" },
        estimated_downtime_days_high: policyValue(warrantyPolicy, "warranty_estimated_downtime_days_high"),
      },
      repairability: {
        evidence_verified: Boolean(repairPolicy),
        parts_availability: policyValue(repairPolicy, "repair_parts_availability", "unknown"),
        manual_availability: policyValue(repairPolicy, "repair_manual_availability", "unknown"),
        critical_components_replaceable: policyValue(repairPolicy, "critical_components_replaceable"),
      },
      buyer_protection: { window_days: policyValue(buyerPolicy, "buyer_protection_days") },
    };
  });
  const requirements = {
    ...(input.requirements || {}),
    returns_required: input.requirements?.returns_required ?? true,
    policy_inventory_required: true,
  };
  const assessed = assessShoppingProtection({ ...input, evaluated_at: evaluatedIso, requirements, candidates });
  const { artifact_attestation: _attestation, ...payload } = assessed;
  return attestShoppingArtifact("protection", { ...payload, evidence_receipts });
}
