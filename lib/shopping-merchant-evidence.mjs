import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { assessMerchantTrust } from "./shopping-merchant-trust.mjs";

const normalized = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function evaluatedMillis(value) {
  const result = value == null ? Date.now() : Date.parse(value);
  if (!Number.isFinite(result)) throw coded("Merchant evaluation time is invalid", "shopping_merchant_evidence_invalid");
  return result;
}

function validatePageEvidence(artifact, { evaluated_at, max_age_seconds, kind, required = true, marker = null } = {}) {
  if (artifact == null && !required) return null;
  if (!verifyShoppingArtifactAttestation("page_evidence", artifact)
    || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)) {
    throw coded("Merchant facts require an untampered shopping_page_evidence artifact", "shopping_merchant_page_evidence_invalid");
  }
  if (artifact?.source?.page_kind !== kind) {
    throw coded(`Unexpected merchant page evidence kind: ${artifact?.source?.page_kind || "missing"}`, "shopping_merchant_page_evidence_scope");
  }
  const captured = Date.parse(artifact.source?.captured_at || "");
  const receiptCaptured = Date.parse(artifact.source_receipt?.captured_at || "");
  const evaluated = evaluatedMillis(evaluated_at);
  if (!Number.isFinite(captured) || captured !== receiptCaptured
    || artifact.source?.url !== artifact.source_receipt?.url
    || artifact.source_receipt?.source_id !== artifact.source_receipt?.snapshot_id
    || captured > evaluated + 5_000 || evaluated - captured > max_age_seconds * 1_000) {
    throw coded("Merchant page evidence is stale or has inconsistent provenance", "shopping_merchant_page_evidence_stale");
  }
  if (marker && artifact.facts?.document_markers?.[marker]?.value !== true) {
    throw coded(`The signed page does not contain an explicit ${marker} document marker`, "shopping_merchant_page_evidence_scope");
  }
  return artifact;
}

function explicit(artifact, field) {
  const fact = artifact?.facts?.[field];
  return fact?.status === "explicit" ? fact.value : null;
}

function entity(artifacts, field) {
  const values = artifacts.map((artifact) => explicit(artifact, field)).filter((value) => typeof value === "string" && value.trim());
  if (!values.length) return { name: null, evidence_status: "unknown" };
  const distinct = [...new Map(values.map((value) => [normalized(value), value])).values()];
  if (distinct.length > 1) return { name: null, evidence_status: "conflict" };
  return { name: distinct[0], evidence_status: "verified" };
}

function scalar(artifacts, field) {
  const values = artifacts.map((artifact) => explicit(artifact, field)).filter((value) => value != null);
  if (!values.length) return { value: null, conflict: false };
  const distinct = [...new Set(values.map((value) => JSON.stringify(value)))].map((value) => JSON.parse(value));
  return distinct.length > 1 ? { value: null, conflict: true } : { value: distinct[0], conflict: false };
}

function consistency(leftArtifact, rightArtifact, field) {
  const left = explicit(leftArtifact, field);
  const right = explicit(rightArtifact, field);
  if (left == null || right == null) return null;
  return typeof left === "string" && typeof right === "string" ? normalized(left) === normalized(right) : left === right;
}

function evidenceScope(artifact) {
  if (!artifact) return null;
  const receipt = artifact.source_receipt || {};
  return {
    source_id: receipt.source_id || null,
    snapshot_id: receipt.snapshot_id || null,
    url: receipt.url || null,
    captured_at: receipt.captured_at || null,
    content_sha256: receipt.content_sha256 || null,
  };
}

export function assessMerchantTrustFromEvidence(input) {
  const evaluatedAt = evaluatedMillis(input.evaluated_at);
  const evaluatedIso = new Date(evaluatedAt).toISOString();
  const maxAge = input.max_page_evidence_age_seconds ?? 300;
  const candidates = (input.candidates || []).map((candidate) => {
    const listing = validatePageEvidence(candidate.listing_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxAge, kind: "retailer_listing" });
    const terms = validatePageEvidence(candidate.terms_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxAge, kind: "merchant_terms", marker: "merchant_terms", required: false });
    const privacy = validatePageEvidence(candidate.privacy_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxAge, kind: "merchant_privacy", marker: "merchant_privacy", required: false });
    const returns = validatePageEvidence(candidate.return_policy_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxAge, kind: "return_policy", marker: "return_policy", required: false });
    const checkout = validatePageEvidence(candidate.checkout_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxAge, kind: "checkout", marker: "checkout", required: false });

    const seller = entity([listing], "seller");
    if (!seller.name) throw coded("The signed listing does not expose a seller; take a seller-visible snapshot", "shopping_merchant_seller_unresolved");
    const merchantOfRecord = entity([checkout, terms].filter(Boolean), "merchant_of_record");
    const legalSeller = entity([terms].filter(Boolean), "legal_seller");
    const fulfiller = entity([listing], "fulfiller");
    const paymentProcessor = entity([checkout, terms].filter(Boolean), "payment_processor");
    const returnRecipient = entity([returns].filter(Boolean), "return_recipient");
    const payment = scalar([checkout, terms].filter(Boolean), "payment_method");
    const chargeback = scalar([checkout, terms].filter(Boolean), "chargeback_eligible");
    const buyerProtection = scalar([checkout, terms].filter(Boolean), "marketplace_protection");
    const checkoutRoleConsistency = consistency(terms, checkout, "merchant_of_record");
    const checkoutPaymentConsistency = consistency(terms, checkout, "payment_method");
    const checkoutConsistent = [checkoutRoleConsistency, checkoutPaymentConsistency].includes(false) ? false
      : [checkoutRoleConsistency, checkoutPaymentConsistency].includes(true) ? true : null;
    const legalAndMerchant = legalSeller.name && merchantOfRecord.name
      ? normalized(legalSeller.name) === normalized(merchantOfRecord.name) : null;
    const returnTermsConsistent = consistency(listing, returns, "return_days");

    return {
      id: candidate.id,
      product_id: candidate.product_id,
      channel: "unknown",
      marketplace: { name: null, evidence_status: "unknown" },
      seller,
      legal_seller: legalSeller,
      fulfiller: fulfiller,
      merchant_of_record: merchantOfRecord,
      payment_processor: paymentProcessor,
      return_recipient: { ...returnRecipient, country: null, address_verified: null },
      domain: { hostname: listing.source?.hostname || null, registrable_domain_verified: null, age_days: null, age_evidence_status: "unknown", brand_domain_match: null },
      contact: { business_address_verified: null, email_domain_match: null, support_channel_verified: null },
      policies: {
        terms_available: terms ? true : null,
        privacy_available: privacy ? true : null,
        return_policy_available: returns ? true : null,
        identity_consistent: legalAndMerchant,
        checkout_consistent: checkoutConsistent,
        return_terms_consistent: returnTermsConsistent,
      },
      recourse: {
        payment_method: payment.conflict ? "unknown" : payment.value || "unknown",
        chargeback_eligible: chargeback.conflict ? null : chargeback.value,
        marketplace_protection: buyerProtection.conflict ? null : buyerProtection.value,
      },
      evidence_scope: {
        listing: evidenceScope(listing),
        checkout: evidenceScope(checkout),
      },
      complaints: [],
    };
  });
  return assessMerchantTrust({ requirements: input.requirements || {}, candidates, evaluated_at: evaluatedIso });
}
