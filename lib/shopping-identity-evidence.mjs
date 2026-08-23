import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { resolveProductIdentities } from "./shopping-identity.mjs";

const IDENTITY_FIELDS = ["brand", "product_line", "model", "generation", "edition", "region", "capacity", "size", "color", "condition", "bundle_count"];

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function evaluatedMillis(value) {
  const result = value == null ? Date.now() : Date.parse(value);
  if (!Number.isFinite(result)) throw coded("Identity evaluation time is invalid", "shopping_identity_evidence_invalid");
  return result;
}

function validatePageEvidence(artifact, { evaluated_at, max_age_seconds, kind, marker = null } = {}) {
  if (!verifyShoppingArtifactAttestation("page_evidence", artifact)
    || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)) {
    throw coded("Product identity requires an untampered shopping_page_evidence artifact", "shopping_identity_page_evidence_invalid");
  }
  if (artifact?.source?.page_kind !== kind) {
    throw coded(`Unexpected identity page evidence kind: ${artifact?.source?.page_kind || "missing"}`, "shopping_identity_page_evidence_scope");
  }
  const captured = Date.parse(artifact.source?.captured_at || "");
  const receiptCaptured = Date.parse(artifact.source_receipt?.captured_at || "");
  const evaluated = evaluatedMillis(evaluated_at);
  if (!Number.isFinite(captured) || captured !== receiptCaptured
    || artifact.source?.url !== artifact.source_receipt?.url
    || artifact.source_receipt?.source_id !== artifact.source_receipt?.snapshot_id
    || captured > evaluated + 5_000 || evaluated - captured > max_age_seconds * 1_000) {
    throw coded("Product identity page evidence is stale or has inconsistent provenance", "shopping_identity_page_evidence_stale");
  }
  if (marker && artifact.facts?.document_markers?.[marker]?.value !== true) {
    throw coded("The target page lacks explicit manufacturer product identity markers", "shopping_identity_page_evidence_scope");
  }
  return artifact;
}

function explicit(fact) {
  return fact?.status === "explicit" ? fact.value : null;
}

function identityFromPage(artifact) {
  const source = artifact.facts?.identity || {};
  const identity = Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, explicit(source[field])]));
  identity.bundle_contents = explicit(source.bundle_contents) || [];
  identity.compatibility_key = explicit(source.compatibility_key);
  identity.compatibility_keys = explicit(source.compatibility_keys) || [];
  identity.product_category = explicit(source.product_category);
  identity.identifiers = Object.fromEntries(["upc", "ean", "gtin", "mpn"].map((field) => [field, explicit(artifact.facts?.identifiers?.[field])]));
  return identity;
}

function hasStableTarget(identity) {
  return Boolean(identity.brand && (identity.model || identity.product_line || identity.identifiers.upc || identity.identifiers.ean || identity.identifiers.gtin || identity.identifiers.mpn));
}

export function resolveProductIdentitiesFromEvidence(input) {
  const evaluatedAt = evaluatedMillis(input.evaluated_at);
  const evaluatedIso = new Date(evaluatedAt).toISOString();
  const maxAge = input.max_page_evidence_age_seconds ?? 300;
  const targetPage = validatePageEvidence(input.target_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxAge, kind: "manufacturer_product", marker: "manufacturer_product" });
  const target = identityFromPage(targetPage);
  if (!hasStableTarget(target)) {
    throw coded("Manufacturer target evidence lacks a stable brand plus model, product line, or identifier", "shopping_identity_target_insufficient");
  }
  const candidates = (input.candidates || []).map((candidate) => {
    const listing = validatePageEvidence(candidate.listing_evidence, { evaluated_at: evaluatedIso, max_age_seconds: maxAge, kind: "retailer_listing" });
    const identity = identityFromPage(listing);
    if (!identity.condition) {
      throw coded("The signed listing does not expose condition; take a condition-visible snapshot", "shopping_identity_condition_unresolved");
    }
    return { id: candidate.id, offer_variant: candidate.offer_variant, ...identity };
  });
  const requiredFields = IDENTITY_FIELDS.filter((field) => target[field] != null && target[field] !== "");
  return resolveProductIdentities({
    evaluated_at: evaluatedIso,
    target_product_id: input.target_product_id,
    target,
    candidates,
    required_fields: requiredFields,
    flexible_fields: [],
    mode: input.mode || "exact_product",
  });
}
