import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { assessShoppingSafety } from "./shopping-safety.mjs";
import { resolveRequiredShoppingSafetyAuthorities, resolveShoppingSourceAuthority } from "./shopping-source-authority.mjs";

const normalized = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function coded(message, code) { return Object.assign(new Error(message), { code }); }
function explicit(fact) { return fact?.status === "explicit" ? fact.value : null; }
function millis(value, label) {
  const result = value == null ? Date.now() : Date.parse(value);
  if (!Number.isFinite(result)) throw coded(`${label} time is invalid`, "shopping_safety_evidence_invalid");
  return result;
}

function page(artifact, { evaluatedAt, maxAge, kind, authorityId, jurisdiction, authorityType = "regulator" }) {
  if (!verifyShoppingArtifactAttestation("page_evidence", artifact) || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)) {
    throw coded("Safety facts require untampered shopping_page_evidence", "shopping_safety_page_evidence_invalid");
  }
  if (artifact.source?.page_kind !== kind) throw coded(`Unexpected safety page kind: ${artifact.source?.page_kind || "missing"}`, "shopping_safety_page_evidence_scope");
  const captured = Date.parse(artifact.source?.captured_at || "");
  if (!Number.isFinite(captured) || captured !== Date.parse(artifact.source_receipt?.captured_at || "") || artifact.source?.url !== artifact.source_receipt?.url
    || captured > evaluatedAt + 5_000 || evaluatedAt - captured > maxAge * 1_000) {
    throw coded("Safety page evidence is stale or has inconsistent provenance", "shopping_safety_page_evidence_stale");
  }
  const authority = resolveShoppingSourceAuthority({ authority_id: authorityId, url: artifact.source.url, jurisdiction, authority_type: authorityType });
  if (!authority) throw coded("Safety evidence hostname is not registered for the claimed authority and jurisdiction", "shopping_safety_authority_untrusted");
  return { artifact, authority };
}

function certificationFromPage(item, context) {
  const { artifact } = page(item.evidence, { ...context, kind: "certification_directory", authorityId: item.authority_id, authorityType: "certification_body" });
  const fact = artifact.facts?.safety?.certification || {};
  if (normalized(explicit(fact.scheme)) !== normalized(item.scheme) || explicit(fact.jurisdiction) !== context.jurisdiction
    || explicit(fact.status) == null || explicit(fact.applies_to_exact_model) == null) {
    throw coded("Certification directory lacks explicit exact-model scheme, jurisdiction, or status", "shopping_safety_certification_incomplete");
  }
  return { scheme: explicit(fact.scheme), jurisdiction: explicit(fact.jurisdiction), status: explicit(fact.status), evidence_status: "verified", applies_to_exact_model: explicit(fact.applies_to_exact_model), source_id: artifact.source_receipt.source_id, expires_at: explicit(fact.expires_at) || undefined };
}

function remediationFromPage(item, context) {
  const { artifact } = page(item.evidence, { ...context, kind: "safety_remediation", authorityId: item.authority_id });
  const fact = artifact.facts?.safety?.remediation || {};
  if (!explicit(fact.notice_id) || !explicit(fact.status) || explicit(fact.restores_compliance) == null) throw coded("Remediation evidence lacks explicit notice, status, or compliance result", "shopping_safety_remediation_incomplete");
  return { notice_id: explicit(fact.notice_id), status: explicit(fact.status), evidence_status: "verified", source_id: artifact.source_receipt.source_id, restores_compliance: explicit(fact.restores_compliance) };
}

function listingPage(artifact, { evaluatedAt, maxAge }) {
  if (!verifyShoppingArtifactAttestation("page_evidence", artifact) || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)
    || artifact?.source?.page_kind !== "retailer_listing") throw coded("Safety seller requires signed retailer listing evidence", "shopping_safety_page_evidence_invalid");
  const captured = Date.parse(artifact.source?.captured_at || "");
  if (!Number.isFinite(captured) || captured !== Date.parse(artifact.source_receipt?.captured_at || "") || artifact.source?.url !== artifact.source_receipt?.url
    || captured > evaluatedAt + 5_000 || evaluatedAt - captured > maxAge * 1_000) throw coded("Safety listing evidence is stale or inconsistent", "shopping_safety_page_evidence_stale");
  return artifact;
}

function validateIdentityArtifact(identity, evaluatedAt, maxAge) {
  if (!verifyShoppingArtifactAttestation("identity", identity)) throw coded("Safety assessment requires an untampered identity artifact", "shopping_safety_identity_invalid");
  const at = Date.parse(identity.evaluated_at || "");
  if (!Number.isFinite(at) || at > evaluatedAt + 5_000 || evaluatedAt - at > maxAge * 1_000) throw coded("Safety identity evidence is stale", "shopping_safety_identity_stale");
  if (!identity.target_product_id || !Array.isArray(identity.resolutions)) throw coded("Safety identity artifact lacks required scope", "shopping_safety_identity_scope");
  return identity;
}

function identityResolution(identity, candidateId, evaluatedAt, maxAge) {
  validateIdentityArtifact(identity, evaluatedAt, maxAge);
  const resolution = identity.resolutions?.find((item) => normalized(item.candidate_id) === normalized(candidateId));
  if (!resolution || resolution.classification !== "exact_match" || resolution.safe_to_compare_offers !== true) throw coded("Safety candidate is not an exact identity match", "shopping_safety_identity_scope");
  return resolution;
}

function coverageFromPage(item, context) {
  const { artifact, authority } = page(item.evidence, { ...context, kind: "safety_authority_search", authorityId: item.authority_id });
  const facts = artifact.facts?.safety || {};
  if (explicit(facts.authority_id) && normalized(explicit(facts.authority_id)) !== normalized(item.authority_id)) throw coded("Safety search page names a different authority", "shopping_safety_page_evidence_scope");
  const status = explicit(facts.search_status);
  if (status !== "complete" || artifact.source_receipt?.truncated === true) throw coded("Safety coverage requires an explicit complete, untruncated authority search", "shopping_safety_coverage_incomplete");
  const namedJurisdiction = explicit(facts.jurisdiction);
  const category = explicit(facts.product_category);
  const productKey = explicit(facts.product_key);
  if (namedJurisdiction !== context.jurisdiction || !category || !productKey) throw coded("Safety coverage must explicitly name the jurisdiction, category, and exact product key", "shopping_safety_coverage_incomplete");
  return {
    authority_id: authority.authority_id,
    jurisdiction: namedJurisdiction,
    product_category: category,
    status: "complete",
    searched_at: artifact.source.captured_at,
    source_id: artifact.source_receipt.source_id,
    product_key: productKey,
  };
}

function noticeFromPage(item, context) {
  const { artifact, authority } = page(item.evidence, { ...context, kind: "safety_notice", authorityId: item.authority_id });
  const fact = artifact.facts?.safety?.notice || {};
  const required = ["id", "notice_type", "status", "severity"];
  if (required.some((field) => explicit(fact[field]) == null)) throw coded("Official safety notice lacks required explicit notice fields", "shopping_safety_notice_incomplete");
  return {
    id: explicit(fact.id), notice_type: explicit(fact.notice_type), authority_type: authority.authority_type,
    evidence_status: "verified", source_id: artifact.source_receipt.source_id, status: explicit(fact.status), severity: explicit(fact.severity),
    affected: {
      product_keys: explicit(fact.product_keys) || [], models: explicit(fact.models) || [], identifiers: explicit(fact.identifiers) || {},
      serial_ranges: explicit(fact.serial_ranges) || [], manufactured_from: explicit(fact.manufactured_from) || undefined,
      manufactured_to: explicit(fact.manufactured_to) || undefined, jurisdictions: explicit(fact.jurisdictions) || [],
      scope_complete: explicit(fact.scope_complete) === true,
    },
  };
}

export function assessShoppingSafetyFromEvidence(input) {
  const evaluatedAt = millis(input.evaluated_at, "Safety evaluation");
  const evaluatedIso = new Date(evaluatedAt).toISOString();
  const context = { evaluatedAt, maxAge: input.max_page_evidence_age_seconds ?? 300, jurisdiction: input.jurisdiction.toUpperCase() };
  const verifiedIdentity = validateIdentityArtifact(input.identity, evaluatedAt, input.max_identity_age_seconds ?? 3_600);
  const productCategory = verifiedIdentity.product_category;
  if (!productCategory) throw coded("Safety identity lacks an explicit signed manufacturer product category", "shopping_safety_category_unresolved");
  const authorityPolicy = resolveRequiredShoppingSafetyAuthorities({ jurisdiction: context.jurisdiction, product_category: productCategory });
  if (authorityPolicy.status !== "resolved" || !authorityPolicy.authorities.length) {
    throw coded(`Safety authority policy is unresolved: ${authorityPolicy.reason}`, "shopping_safety_authority_policy_unresolved");
  }
  const evidence_receipts = [];
  const record = (kind, artifact, offer_id = null) => {
    if (artifact) evidence_receipts.push({ ...(offer_id ? { offer_id } : {}), kind, url: artifact.source.url, captured_at: artifact.source.captured_at, artifact_attestation: artifact.artifact_attestation });
  };
  for (const item of input.coverage_evidence || []) record("safety_authority", item.evidence);
  for (const item of input.notice_evidence || []) record("safety_notice", item.evidence);
  const coverage = (input.coverage_evidence || []).map((item) => coverageFromPage(item, context));
  const notices = (input.notice_evidence || []).map((item) => noticeFromPage(item, context));
  const candidates = (input.candidates || []).map((candidate) => {
    const resolution = identityResolution(input.identity, candidate.id, evaluatedAt, input.max_identity_age_seconds ?? 3_600);
    const listing = listingPage(candidate.listing_evidence, context);
    record("listing", candidate.listing_evidence, candidate.id);
    for (const item of candidate.certification_evidence || []) record("certification", item.evidence, candidate.id);
    for (const item of candidate.remediation_evidence || []) record("safety_remediation", item.evidence, candidate.id);
    const seller = explicit(listing.facts?.seller);
    if (!seller) throw coded("Signed safety listing does not expose the seller", "shopping_safety_seller_unresolved");
    return {
      id: candidate.id, identity_verified: true, product_key: input.identity.target_product_id,
      variant: resolution.offer_variant ?? undefined, condition: resolution.canonical.condition || "new", seller,
      model: input.identity.canonical_target?.model || undefined,
      identifiers: {
        ...(input.identity.canonical_target?.identifiers?.trade_item_code ? { gtin: input.identity.canonical_target.identifiers.trade_item_code } : {}),
        ...(input.identity.canonical_target?.identifiers?.mpn ? { mpn: input.identity.canonical_target.identifiers.mpn } : {}),
      },
      serial_number: candidate.serial_number, manufactured_at: candidate.manufactured_at,
      certifications: (candidate.certification_evidence || []).map((item) => certificationFromPage(item, context)),
      remediations: (candidate.remediation_evidence || []).map((item) => remediationFromPage(item, context)),
    };
  });
  const assessed = assessShoppingSafety({ ...input, evaluated_at: evaluatedIso, product_category: productCategory, required_authorities: authorityPolicy.authorities, authority_policy: authorityPolicy, coverage, notices, candidates });
  const { artifact_attestation: _attestation, ...payload } = assessed;
  return attestShoppingArtifact("safety", { ...payload, evidence_receipts });
}
