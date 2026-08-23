import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const unique = (items) => [...new Set(items)];
const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

export function validateCounterfeitAssessment({ artifact, offer, evaluated_at = Date.now(), max_age_seconds = 3_600 }) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  if (!verifyShoppingArtifactAttestation("counterfeit", artifact)) return null;
  if (!artifact?.evaluated_at || !Array.isArray(artifact.assessments) || !Number.isFinite(evaluatedAt)) return null;
  const artifactAt = Date.parse(artifact.evaluated_at);
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > max_age_seconds * 1_000) return null;
  const assessment = artifact.assessments.find((candidate) => same(candidate?.offer_id, offer?.id));
  if (!assessment || !same(assessment.product_id, offer?.product_key)) return null;
  if (assessment.variant != null && !same(assessment.variant, offer?.variant)) return null;
  if (!assessment.seller || !same(assessment.seller, offer?.seller)) return null;
  if (assessment.distinctions?.identity_exact !== true) return null;
  if (!same(assessment.distinctions.condition, offer?.condition || "new")) return null;
  if (!["low", "acceptable", "elevated", "unknown"].includes(assessment.risk_status)) return null;
  const availability = assessment.availability || { status: "unknown", evidence_status: "unknown" };
  if (!["in_stock", "out_of_stock", "unknown"].includes(availability.status)) return null;
  if (!["verified", "unknown"].includes(availability.evidence_status)) return null;
  if ((availability.status === "unknown") !== (availability.evidence_status === "unknown")) return null;
  const authorizationRequirement = assessment.authorization_requirement;
  const requirementStatus = authorizationRequirement?.status || "not_required";
  if (!["not_required", "satisfied", "failed", "unknown"].includes(requirementStatus)) return null;
  if (authorizationRequirement) {
    if (typeof authorizationRequirement.required !== "boolean") return null;
    if (authorizationRequirement.required !== (requirementStatus !== "not_required")) return null;
    const expectedRequirementGate = requirementStatus === "failed" ? "avoid_offer"
      : requirementStatus === "unknown" ? "research_more"
        : "eligible_for_other_shopping_checks";
    if (authorizationRequirement.gate !== expectedRequirementGate) return null;
  }
  const expectedGate = assessment.risk_status === "elevated" || requirementStatus === "failed" ? "avoid_offer"
    : assessment.risk_status === "unknown" || requirementStatus === "unknown" ? "research_more"
      : "eligible_for_other_shopping_checks";
  return assessment.purchase_gate === expectedGate ? assessment : null;
}

function priceSignal(offer, median, medianVerified) {
  if (medianVerified !== true || offer.landed_price_verified !== true || !finite(median) || median <= 0 || !finite(offer.landed_total_usd)) return null;
  const discount = Math.round((1 - offer.landed_total_usd / median) * 1000) / 10;
  if (discount >= 40) return { code: "extreme_price_anomaly", family: "price", strength: "context", discount_percent: discount };
  if (discount >= 20) return { code: "price_anomaly", family: "price", strength: "weak", discount_percent: discount };
  return { code: "price_within_expected_range", family: "price", strength: "positive", discount_percent: discount };
}

function complaintPattern(complaints = []) {
  const usable = complaints.filter((item) => item.verified === true && item.relevance === "authenticity" && item.source_type !== "search_snippet");
  const deduped = usable.filter((item, index) => usable.findIndex((other) => (other.independence_key || other.source_id) === (item.independence_key || item.source_id)) === index);
  const unresolved = deduped.filter((item) => item.resolved !== true);
  return { submitted: complaints.length, usable: usable.length, independent: deduped.length, unresolved: unresolved.length, repeated: unresolved.length >= 3 };
}

function assess(offer, input) {
  const signals = [];
  const excluded = [];
  const unknowns = [];
  const strongFamilies = new Set();
  const contextFamilies = new Set();
  let definitiveFinding = false;

  const official = offer.official_finding;
  if (official?.counterfeit === true && official.evidence_status === "verified" && ["manufacturer", "regulator", "court", "accredited_lab"].includes(official.authority_type)) {
    signals.push({ code: "verified_official_counterfeit_finding", family: "official_finding", strength: "definitive" });
    definitiveFinding = true;
  } else if (official?.counterfeit === true) excluded.push({ code: "unverified_counterfeit_claim", reason: "A counterfeit assertion requires a verified manufacturer, regulator, court, or accredited-lab finding." });

  const authenticity = offer.authenticity_verification;
  if (authenticity?.authentic === true && authenticity.evidence_status === "verified" && ["manufacturer", "authorized_service", "accredited_lab"].includes(authenticity.authority_type)) signals.push({ code: "verified_authenticity_confirmation", family: "authenticity_confirmation", strength: "positive" });

  const authorization = offer.authorization || {};
  if (authorization.evidence_status === "conflict") unknowns.push("seller_authorization_conflict");
  else if (authorization.status === "authorized" && authorization.evidence_status === "verified") signals.push({ code: "authorized_seller", family: "provenance", strength: "positive" });
  else if (authorization.status === "unauthorized" && authorization.evidence_status === "verified") {
    signals.push({ code: "unauthorized_seller", family: "provenance", strength: "context" });
    contextFamilies.add("provenance");
  } else if (authorization.status === "unknown" || authorization.evidence_status === "unknown" || !authorization.status) unknowns.push("seller_authorization");
  else excluded.push({ code: "unverified_seller_authorization", reason: "Displayed seller status is not verified against an applicable source." });

  const warranty = offer.warranty || {};
  if (warranty.evidence_status === "conflict") unknowns.push("manufacturer_warranty_conflict");
  else if (warranty.applies === true && warranty.evidence_status === "verified") signals.push({ code: "manufacturer_warranty", family: "provenance", strength: "positive" });
  else if (warranty.applies === false && warranty.evidence_status === "verified") {
    signals.push({ code: "no_manufacturer_warranty", family: "provenance", strength: "context" });
    contextFamilies.add("provenance");
  } else if (warranty.applies == null || warranty.evidence_status === "unknown") unknowns.push("manufacturer_warranty");

  const identifier = offer.identifiers || {};
  if (identifier.conflict === true && identifier.evidence_status === "verified") {
    signals.push({ code: "verified_identifier_conflict", family: "identifier", strength: "strong" });
    strongFamilies.add("identifier");
  } else if (identifier.conflict === true) excluded.push({ code: "unverified_identifier_conflict", reason: "Identifier conflict was not verified from the exact item and authoritative identifier." });

  const packaging = (offer.packaging_signals || []).filter((item) => item.present === true);
  const verifiedPackaging = packaging.filter((item) => item.evidence_status === "verified" && item.source_type !== "search_snippet");
  if (verifiedPackaging.length) {
    for (const item of verifiedPackaging) signals.push({ code: item.type, family: "packaging_integrity", strength: "strong" });
    strongFamilies.add("packaging_integrity");
  }
  for (const item of packaging.filter((value) => !verifiedPackaging.includes(value))) excluded.push({ code: item.type, reason: "Packaging or seal signal lacks verified exact-item evidence." });

  const complaints = complaintPattern(offer.complaints);
  if (complaints.repeated) {
    signals.push({ code: "repeated_independent_authenticity_complaints", family: "complaints", strength: "strong", independent_reports: complaints.unresolved });
    strongFamilies.add("complaints");
  } else if (complaints.unresolved > 0) excluded.push({ code: "insufficient_complaint_pattern", reason: `Only ${complaints.unresolved} independent unresolved authenticity report(s); at least 3 are required.` });

  const price = priceSignal(offer, input.authorized_market_median_usd, input.authorized_market_median_verified);
  if (price) {
    signals.push(price);
    if (price.strength === "context") contextFamilies.add("price");
  } else unknowns.push("verified_authorized_market_price_comparison");

  if (offer.fulfilled_by_platform === true && offer.sold_by_platform === false) signals.push({ code: "third_party_seller_platform_fulfilled", family: "fulfillment", strength: "context_only" });
  if (offer.gray_market_disclosed === true) signals.push({ code: "gray_market_disclosed", family: "market_channel", strength: "distinct_non_counterfeit_fact" });
  if (["used", "open_box", "refurbished"].includes(offer.condition)) signals.push({ code: `condition_${offer.condition}`, family: "condition", strength: "distinct_non_counterfeit_fact" });
  if (offer.exact_product === false) signals.push({ code: "identity_mismatch", family: "identity", strength: "separate_gate" });

  const strongDecisive = strongFamilies.has("identifier") || strongFamilies.has("complaints") || (strongFamilies.has("packaging_integrity") && ["supplement", "cosmetics", "food", "medical_device"].includes(input.category));
  const corroborated = strongFamilies.size >= 2 || (strongFamilies.size >= 1 && contextFamilies.size >= 1);
  let riskStatus;
  let reason;
  if (definitiveFinding) { riskStatus = "elevated"; reason = "verified_official_counterfeit_finding"; }
  else if (strongDecisive || corroborated) { riskStatus = "elevated"; reason = "verified_adverse_evidence"; }
  else {
    const adverseStrong = strongFamilies.size > 0;
    const positiveAuth = signals.some((item) => item.code === "verified_authenticity_confirmation");
    const positiveChain = signals.some((item) => item.code === "authorized_seller") && signals.some((item) => item.code === "manufacturer_warranty");
    if (!adverseStrong && (positiveAuth || positiveChain)) { riskStatus = "low"; reason = positiveAuth ? "verified_authenticity_confirmation" : "verified_authorized_warranty_chain"; }
    else if (!adverseStrong && offer.gray_market_disclosed === true && offer.user_accepts_gray_market === true && offer.returnable === true && authorization.status === "unauthorized") { riskStatus = "acceptable"; reason = "user_accepted_disclosed_returnable_gray_market_without_authenticity_conflicts"; }
    else if (adverseStrong) { riskStatus = "unknown"; reason = "uncorroborated_adverse_signal_requires_verification"; }
    else if (authorization.status === "unauthorized" && authorization.evidence_status === "verified") { riskStatus = "unknown"; reason = "unauthorized_channel_requires_additional_authenticity_evidence"; }
    else { riskStatus = "unknown"; reason = "authenticity_evidence_insufficient"; }
  }

  const nextChecks = [];
  if (riskStatus === "unknown") {
    if (unknowns.includes("seller_authorization")) nextChecks.push("verify_seller_in_applicable_manufacturer_directory");
    if (unknowns.includes("manufacturer_warranty")) nextChecks.push("verify_exact_offer_warranty_eligibility");
    if (strongFamilies.has("packaging_integrity")) nextChecks.push("compare_exact_item_packaging_and_identifiers_with_manufacturer_evidence");
    if (!nextChecks.length) nextChecks.push("obtain_independent_exact_offer_authenticity_evidence");
  }

  const authorizationRequired = input.requirements?.authorized_seller_required === true;
  const authorizationRequirementStatus = !authorizationRequired ? "not_required"
    : authorization.status === "authorized" && authorization.evidence_status === "verified" ? "satisfied"
      : authorization.status === "unauthorized" && authorization.evidence_status === "verified" ? "failed"
        : "unknown";
  const requirementGate = authorizationRequirementStatus === "failed" ? "avoid_offer"
    : authorizationRequirementStatus === "unknown" ? "research_more"
      : "eligible_for_other_shopping_checks";
  const riskGate = riskStatus === "elevated" ? "avoid_offer" : riskStatus === "unknown" ? "research_more" : "eligible_for_other_shopping_checks";
  const purchaseGate = [riskGate, requirementGate].includes("avoid_offer") ? "avoid_offer"
    : [riskGate, requirementGate].includes("research_more") ? "research_more"
      : "eligible_for_other_shopping_checks";

  return {
    offer_id: offer.id,
    product_id: offer.product_id ?? null,
    variant: offer.variant ?? null,
    seller: offer.seller ?? null,
    availability: ["in_stock", "out_of_stock"].includes(offer.availability?.status) && offer.availability?.evidence_status === "verified"
      ? { status: offer.availability.status, evidence_status: "verified" }
      : { status: "unknown", evidence_status: "unknown" },
    risk_status: riskStatus,
    reason,
    purchase_gate: purchaseGate,
    authorization_requirement: { required: authorizationRequired, status: authorizationRequirementStatus, gate: requirementGate },
    requirement_failures: authorizationRequirementStatus === "failed" ? ["authorized_seller_required"] : [],
    requirement_unknowns: authorizationRequirementStatus === "unknown" ? ["authorized_seller_required"] : [],
    definitive_counterfeit_finding: definitiveFinding,
    accusation_allowed: definitiveFinding,
    signals,
    excluded_signals: excluded,
    critical_unknowns: unique(unknowns),
    complaint_evidence: complaints,
    next_checks: unique(nextChecks),
    distinctions: { gray_market: offer.gray_market_disclosed === true, condition: offer.condition || "new", identity_exact: offer.exact_product !== false },
    language_guardrail: definitiveFinding ? "A verified official finding may be reported with its cited authority." : "Report risk or inability to verify; do not state that the item or seller is counterfeit, fake, fraudulent, or criminal.",
  };
}

export function assessCounterfeitRisk(input) {
  const assessments = (input.offers || []).map((offer) => assess(offer, input));
  const exact = assessments.filter((item) => item.distinctions.identity_exact);
  const eligible = exact.filter((item) => item.purchase_gate === "eligible_for_other_shopping_checks");
  const research = exact.filter((item) => item.purchase_gate === "research_more");
  const mismatched = assessments.filter((item) => !item.distinctions.identity_exact);
  let action = "avoid_all_offers";
  if (mismatched.length && exact.length === 0) action = "search_exact_product";
  else if (eligible.length) action = "continue_with_safe_offers";
  else if (research.length) action = "research_more";
  return attestShoppingArtifact("counterfeit", {
    evaluated_at: new Date(input.evaluated_at || Date.now()).toISOString(),
    assessments,
    decision: {
      action,
      eligible_offer_ids: eligible.map((item) => item.offer_id),
      research_offer_ids: research.map((item) => item.offer_id),
      avoid_offer_ids: exact.filter((item) => item.purchase_gate === "avoid_offer").map((item) => item.offer_id),
      identity_mismatch_offer_ids: mismatched.map((item) => item.offer_id),
      selects_offer: false,
    },
  });
}
