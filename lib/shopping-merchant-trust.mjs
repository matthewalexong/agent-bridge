import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const clean = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const same = (a, b) => clean(a) === clean(b);
const REVERSIBLE_METHODS = new Set(["credit_card", "paypal_goods_services", "marketplace_protected"]);
const IRREVERSIBLE_METHODS = new Set(["wire_transfer", "crypto", "gift_card", "cash"]);

function unique(items) {
  return [...new Set(items)];
}

function entity(input = {}) {
  return { name: input.name || null, normalized_name: input.name ? clean(input.name) : null, evidence_status: input.evidence_status || "unknown" };
}

function complaintPattern(complaints = []) {
  const usable = complaints.filter((item) => item.verified === true && item.source_type !== "search_snippet");
  const deduped = usable.filter((item, index) => usable.findIndex((other) => (other.independence_key || other.source_id) === (item.independence_key || item.source_id) && other.category === item.category) === index);
  const unresolved = deduped.filter((item) => item.resolved !== true);
  const byCategory = Object.entries(Object.groupBy ? Object.groupBy(unresolved, (item) => item.category) : unresolved.reduce((groups, item) => ({ ...groups, [item.category]: [...(groups[item.category] || []), item] }), {}))
    .map(([category, items]) => ({ category, independent_reports: items.length, source_groups: new Set(items.map((item) => item.independence_key || item.source_id)).size }))
    .sort((a, b) => b.independent_reports - a.independent_reports || a.category.localeCompare(b.category));
  const repeated = byCategory.filter((item) => item.independent_reports >= 3 && item.source_groups >= 3);
  return { submitted: complaints.length, usable: usable.length, deduplicated: deduped.length, unresolved: unresolved.length, categories: byCategory, repeated_patterns: repeated };
}

function assess(candidate, requirements) {
  const roles = {
    marketplace: entity(candidate.marketplace),
    seller: entity(candidate.seller),
    legal_seller: entity(candidate.legal_seller),
    fulfiller: entity(candidate.fulfiller),
    merchant_of_record: entity(candidate.merchant_of_record),
    payment_processor: entity(candidate.payment_processor),
    return_recipient: { ...entity(candidate.return_recipient), country: candidate.return_recipient?.country || null, address_verified: candidate.return_recipient?.address_verified ?? null },
  };
  const failures = [];
  const critical_unknowns = [];
  const elevated_signals = [];
  const weak_signals = [];
  const positive_signals = [];

  for (const [role, value] of Object.entries(roles)) {
    if (value.evidence_status === "conflict") failures.push(`${role}_conflict`);
  }
  if (!roles.seller.name || roles.seller.evidence_status === "unknown") critical_unknowns.push("seller_identity");
  if (!roles.merchant_of_record.name || roles.merchant_of_record.evidence_status === "unknown") critical_unknowns.push("merchant_of_record");
  if (requirements.verified_legal_seller_required === true) {
    if (!roles.legal_seller.name || roles.legal_seller.evidence_status === "unknown") critical_unknowns.push("legal_seller");
    else if (roles.legal_seller.evidence_status !== "verified") failures.push("legal_seller_unverified");
  }
  if (requirements.return_destination_required === true) {
    if (!roles.return_recipient.name || roles.return_recipient.evidence_status === "unknown" || roles.return_recipient.address_verified == null) critical_unknowns.push("return_destination");
    else if (roles.return_recipient.address_verified !== true) failures.push("return_destination_unverified");
  }
  if (requirements.allowed_return_countries?.length) {
    if (!roles.return_recipient.country) critical_unknowns.push("return_country");
    else if (!requirements.allowed_return_countries.map((item) => item.toUpperCase()).includes(roles.return_recipient.country.toUpperCase())) failures.push("return_country_not_allowed");
  }

  const policies = candidate.policies || {};
  for (const name of ["terms_available", "privacy_available", "return_policy_available"]) {
    if (policies[name] === true) positive_signals.push(name);
    else if (policies[name] == null) critical_unknowns.push(`policies:${name}`);
  }
  if (policies.identity_consistent === false) elevated_signals.push("merchant_identity_inconsistent_across_pages");
  else if (policies.identity_consistent === true) positive_signals.push("merchant_identity_consistent");
  if (policies.checkout_consistent === false) elevated_signals.push("checkout_terms_conflict");
  else if (policies.checkout_consistent === true) positive_signals.push("checkout_terms_consistent");
  if (policies.return_terms_consistent === false) elevated_signals.push("return_terms_conflict");

  const recourse = candidate.recourse || {};
  if (!recourse.payment_method || recourse.payment_method === "unknown") critical_unknowns.push("payment_method");
  if (IRREVERSIBLE_METHODS.has(recourse.payment_method)) elevated_signals.push("irreversible_payment_method");
  if (REVERSIBLE_METHODS.has(recourse.payment_method)) positive_signals.push("reversible_payment_method");
  if (requirements.reversible_payment_required === true) {
    if (!recourse.payment_method || recourse.payment_method === "unknown") critical_unknowns.push("payment_recourse");
    else if (!REVERSIBLE_METHODS.has(recourse.payment_method) && recourse.chargeback_eligible !== true) failures.push("reversible_payment_unavailable");
  }
  if (recourse.chargeback_eligible === true) positive_signals.push("chargeback_eligible");
  if (recourse.marketplace_protection === true) positive_signals.push("marketplace_protection");
  if (requirements.buyer_protection_required === true) {
    if (recourse.marketplace_protection == null && recourse.chargeback_eligible == null) critical_unknowns.push("buyer_protection_recourse");
    else if (recourse.marketplace_protection !== true && recourse.chargeback_eligible !== true) failures.push("buyer_protection_unavailable");
  }

  const domain = candidate.domain || {};
  if (domain.age_evidence_status === "verified" && Number.isFinite(domain.age_days) && domain.age_days < 30) weak_signals.push("recent_domain");
  if (domain.brand_domain_match === false) weak_signals.push("domain_brand_mismatch");
  if (domain.registrable_domain_verified === true) positive_signals.push("registrable_domain_verified");
  if (weak_signals.includes("recent_domain") && roles.legal_seller.evidence_status !== "verified" && candidate.contact?.business_address_verified !== true) elevated_signals.push("recent_domain_with_unverified_business_identity");

  if (candidate.contact?.business_address_verified === true) positive_signals.push("business_address_verified");
  if (candidate.contact?.email_domain_match === false) weak_signals.push("contact_email_domain_mismatch");
  if (candidate.contact?.support_channel_verified === true) positive_signals.push("support_channel_verified");

  const complaints = complaintPattern(candidate.complaints);
  if (complaints.repeated_patterns.length) elevated_signals.push(...complaints.repeated_patterns.map((item) => `repeated_unresolved_${item.category}`));

  const normalizedFailures = unique(failures);
  const normalizedUnknowns = unique(critical_unknowns);
  const normalizedElevated = unique(elevated_signals);
  let status;
  if (normalizedFailures.length) status = "rejected";
  else if (normalizedElevated.length) status = "elevated";
  else if (normalizedUnknowns.length) status = "unknown";
  else if ([roles.seller, roles.legal_seller, roles.merchant_of_record].every((item) => item.evidence_status === "verified") && positive_signals.includes("reversible_payment_method")) status = "verified_established";
  else status = "acceptable";

  return {
    id: candidate.id,
    product_id: candidate.product_id ?? null,
    channel: candidate.channel || "unknown",
    roles,
    role_relationships: {
      seller_is_marketplace: Boolean(roles.seller.normalized_name && roles.seller.normalized_name === roles.marketplace.normalized_name),
      seller_is_fulfiller: Boolean(roles.seller.normalized_name && roles.seller.normalized_name === roles.fulfiller.normalized_name),
      seller_is_merchant_of_record: Boolean(roles.seller.normalized_name && roles.seller.normalized_name === roles.merchant_of_record.normalized_name),
      payment_processor_is_merchant: Boolean(roles.payment_processor.normalized_name && roles.payment_processor.normalized_name === roles.merchant_of_record.normalized_name),
    },
    status,
    failures: normalizedFailures,
    critical_unknowns: normalizedUnknowns,
    elevated_signals: normalizedElevated,
    weak_signals: unique(weak_signals),
    positive_signals: unique(positive_signals),
    evidence_scope: candidate.evidence_scope || { listing: null, checkout: null },
    complaint_evidence: complaints,
    language_guardrail: normalizedElevated.some((item) => item.startsWith("repeated_unresolved_")) ? "Complaint patterns are allegations, not findings of fraud." : null,
    purchase_gate: status === "verified_established" || status === "acceptable" ? "eligible_for_other_shopping_checks" : status === "unknown" ? "research_more" : "avoid_offer",
  };
}

export function validateMerchantTrustAssessment({ artifact, offer, merchant_of_record = null, checkout_evidence = null, evaluated_at = Date.now(), max_age_seconds = 3_600 }) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  if (!verifyShoppingArtifactAttestation("merchant", artifact)) return null;
  if (!artifact?.evaluated_at || !Array.isArray(artifact.assessments) || !Number.isFinite(evaluatedAt)) return null;
  const artifactAt = Date.parse(artifact.evaluated_at);
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > max_age_seconds * 1_000) return null;
  const assessment = artifact.assessments.find((candidate) => same(candidate?.id, offer?.id));
  if (!assessment || !assessment.roles?.seller?.name || !same(assessment.roles.seller.name, offer?.seller)) return null;
  if (merchant_of_record != null && (!assessment.roles?.merchant_of_record?.name || !same(assessment.roles.merchant_of_record.name, merchant_of_record))) return null;
  if (checkout_evidence != null) {
    const scope = assessment.evidence_scope?.checkout;
    const receipt = checkout_evidence?.source_receipt;
    if (!scope || !receipt) return null;
    for (const field of ["source_id", "snapshot_id", "url", "captured_at", "content_sha256"]) {
      if (!scope[field] || scope[field] !== receipt[field]) return null;
    }
  }
  if (!["verified_established", "acceptable", "unknown", "elevated", "rejected"].includes(assessment.status)) return null;
  const expectedGate = ["verified_established", "acceptable"].includes(assessment.status) ? "eligible_for_other_shopping_checks"
    : assessment.status === "unknown" ? "research_more" : "avoid_offer";
  return assessment.purchase_gate === expectedGate ? assessment : null;
}

export function assessMerchantTrust({ requirements = {}, candidates = [], evaluated_at = null }) {
  const assessments = candidates.map((candidate) => assess(candidate, requirements));
  return attestShoppingArtifact("merchant", {
    evaluated_at: new Date(evaluated_at || Date.now()).toISOString(),
    assessments,
    decision: {
      eligible_offer_ids: assessments.filter((item) => item.purchase_gate === "eligible_for_other_shopping_checks").map((item) => item.id),
      research_offer_ids: assessments.filter((item) => item.purchase_gate === "research_more").map((item) => item.id),
      avoid_offer_ids: assessments.filter((item) => item.purchase_gate === "avoid_offer").map((item) => item.id),
      selects_offer: false,
    },
  });
}
