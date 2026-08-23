import { validateShoppingPromotionArtifact } from "./shopping-promotion.mjs";
import { validateCounterfeitAssessment } from "./shopping-counterfeit.mjs";
import { validateMerchantTrustAssessment } from "./shopping-merchant-trust.mjs";
import { validateProtectionAssessment } from "./shopping-protection.mjs";
import { validateIdentityResolution } from "./shopping-identity.mjs";
import { validateSafetyAssessment } from "./shopping-safety.mjs";
import { validateProductClearance } from "./shopping-dossier.mjs";
import { validateShoppingFulfillmentArtifact } from "./shopping-fulfillment-evidence.mjs";

const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function promotionAssessment(offer, promotionArtifacts = [], evaluatedAt = Date.now(), maxAgeSeconds = 900) {
  const artifact = (promotionArtifacts || []).find((candidate) => same(candidate?.offer_id, offer.id));
  return validateShoppingPromotionArtifact({ artifact, offer_id: offer.id, product_id: offer.product_key, base_price_usd: offer.price_usd, shipping_usd: offer.shipping_usd, evaluated_at: evaluatedAt, max_age_seconds: maxAgeSeconds });
}

function hasPromotionClaim(offer) {
  return offer.promotion_claimed === true || offer.promotion_required_for_decision === true || finite(offer.coupon_usd) || offer.coupon_eligible != null;
}

function fulfillmentAssessment(offer, fulfillment, promotionArtifacts, evaluatedAt, maxFulfillmentAgeSeconds, maxPromotionAgeSeconds, destinationCountry) {
  if (!validateShoppingFulfillmentArtifact(fulfillment, evaluatedAt, maxFulfillmentAgeSeconds) || !Array.isArray(fulfillment.assessments)) return null;
  if (!same(fulfillment.destination_country, destinationCountry)) return null;
  const artifactAt = Date.parse(fulfillment.evaluated_at || "");
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > maxFulfillmentAgeSeconds * 1_000) return null;
  const assessment = fulfillment.assessments.find((candidate) => same(candidate?.id, offer.id));
  if (!assessment || !same(assessment.product_id, offer.product_key) || assessment.action !== "eligible" || assessment.safe_for_offer_comparison !== true || assessment.purchase_allowed !== false) return null;
  const range = assessment.fully_landed_total_usd;
  if (![range?.low_usd, range?.expected_usd, range?.high_usd].every(finite) || range.low_usd > range.expected_usd || range.expected_usd > range.high_usd) return null;
  if (!["verified", "estimated"].includes(assessment.fully_landed_status)) return null;
  const promotion = promotionAssessment(offer, promotionArtifacts, evaluatedAt, maxPromotionAgeSeconds);
  if (hasPromotionClaim(offer) || assessment.promotion) {
    if (!promotion || !assessment.promotion) return null;
    if (assessment.promotion.artifact_evaluated_at !== promotion.evaluated_at
      || assessment.promotion.immediate_checkout_discount_usd !== promotion.immediate_checkout_discount_usd
      || assessment.promotion.required_incremental_cost_usd !== promotion.required_incremental_cost_usd) return null;
  }
  return assessment;
}

export function requirementFailures(requirements, offer, unitValue = null, promotionArtifacts = [], fulfillment = null, evaluatedAt = Date.now(), maxPromotionAgeSeconds = 900, maxFulfillmentAgeSeconds = 900, destinationCountry = null, counterfeit = null, maxCounterfeitAgeSeconds = 3_600, merchant = null, maxMerchantAgeSeconds = 3_600, protection = null, maxProtectionAgeSeconds = 3_600, identity = null, maxIdentityAgeSeconds = 3_600, safety = null, maxSafetyAgeSeconds = 86_400, productClearance = null, maxProductClearanceAgeSeconds = 3_600) {
  const failures = [];
  const fulfillmentResult = fulfillmentAssessment(offer, fulfillment, promotionArtifacts, evaluatedAt, maxFulfillmentAgeSeconds, maxPromotionAgeSeconds, destinationCountry);
  const counterfeitResult = validateCounterfeitAssessment({ artifact: counterfeit, offer, evaluated_at: evaluatedAt, max_age_seconds: maxCounterfeitAgeSeconds });
  const merchantResult = validateMerchantTrustAssessment({ artifact: merchant, offer, evaluated_at: evaluatedAt, max_age_seconds: maxMerchantAgeSeconds });
  const protectionResult = validateProtectionAssessment({ artifact: protection, offer, evaluated_at: evaluatedAt, max_age_seconds: maxProtectionAgeSeconds });
  const identityResult = validateIdentityResolution({ artifact: identity, offer, evaluated_at: evaluatedAt, max_age_seconds: maxIdentityAgeSeconds });
  const safetyResult = validateSafetyAssessment({ artifact: safety, offer, jurisdiction: destinationCountry, evaluated_at: evaluatedAt, max_age_seconds: maxSafetyAgeSeconds });
  const clearanceResult = validateProductClearance({ artifact: productClearance, product_id: offer.product_key, evaluated_at: evaluatedAt, max_age_seconds: maxProductClearanceAgeSeconds });
  if (counterfeitResult?.availability?.status === "out_of_stock" && counterfeitResult.availability.evidence_status === "verified") failures.push("not in stock");
  else if (counterfeitResult?.availability?.status !== "in_stock" || counterfeitResult?.availability?.evidence_status !== "verified") failures.push("stock unverified");
  if (requirements.product_key && !same(offer.product_key, requirements.product_key)) failures.push("wrong product identity");
  if (requirements.variant && !same(offer.variant, requirements.variant)) failures.push(`wrong variant (needs ${requirements.variant})`);
  if (requirements.condition && !same(offer.condition, requirements.condition)) failures.push(`wrong condition (needs ${requirements.condition})`);
  if (finite(requirements.min_quantity) && requirements.min_quantity > 1) {
    const landed = fulfillmentResult?.fully_landed_total_usd?.expected_usd ?? null;
    const value = valueAssessment(unitValue, offer, landed);
    const requiredUnit = String(requirements.quantity_unit || "each").trim().toLowerCase();
    if (!value || String(value.normalized_unit).trim().toLowerCase() !== requiredUnit) failures.push(`quantity unverified in ${requiredUnit}`);
    else if (value.normalized_quantity < requirements.min_quantity) failures.push(`quantity below ${requirements.min_quantity} ${requiredUnit}`);
  }
  // The listing's raw authorized_seller field is never authoritative. A legacy
  // caller requirement is satisfied only by the signed counterfeit assessment.
  if (requirements.authorized_seller === true && counterfeitResult?.authorization_requirement?.status !== "satisfied") failures.push(counterfeitResult?.authorization_requirement?.status === "failed" ? "authorized seller requirement failed" : "authorized seller requirement unresolved");
  if (finite(requirements.max_landed_usd) && (!fulfillmentResult || (requirements.max_landed_operator === "lt" ? fulfillmentResult.fully_landed_total_usd.high_usd >= requirements.max_landed_usd : fulfillmentResult.fully_landed_total_usd.high_usd > requirements.max_landed_usd))) failures.push(`landed total may exceed $${requirements.max_landed_usd}`);
  if (!fulfillmentResult) failures.push("fully landed cost unverified");
  if (!counterfeitResult) failures.push("counterfeit risk unverified");
  else if (counterfeitResult.risk_status === "elevated") failures.push("counterfeit risk elevated");
  else if (counterfeitResult.risk_status === "unknown") failures.push("counterfeit risk unresolved");
  if (counterfeitResult?.authorization_requirement?.status === "failed") failures.push("authorized seller requirement failed");
  else if (counterfeitResult?.authorization_requirement?.status === "unknown") failures.push("authorized seller requirement unresolved");
  if (!merchantResult) failures.push("merchant trust unverified");
  else if (merchantResult.purchase_gate === "avoid_offer") failures.push("merchant trust rejected");
  else if (merchantResult.purchase_gate === "research_more") failures.push("merchant trust unresolved");
  if (!protectionResult) failures.push("purchase protection unverified");
  else if (protectionResult.purchase_gate === "avoid_offer") failures.push("purchase protection rejected");
  else if (protectionResult.purchase_gate === "research_more") failures.push("purchase protection unresolved");
  if (!identityResult) failures.push("canonical product identity unverified");
  if (!safetyResult) failures.push("official product safety unverified");
  else if (safetyResult.action === "avoid_product") failures.push("official product safety blocked");
  else if (safetyResult.action === "research_more") failures.push("official product safety unresolved");
  else if (safetyResult.action === "clarify_tradeoff") failures.push("official product safety clarification required");
  if (!clearanceResult) failures.push("product decision clearance unverified");
  if (hasPromotionClaim(offer) && !promotionAssessment(offer, promotionArtifacts, evaluatedAt, maxPromotionAgeSeconds)) failures.push("promotion price unverified");
  return [...new Set(failures)];
}

function valueAssessment(unitValue, offer, landed) {
  if (unitValue?.action !== "comparable" || unitValue.safe_for_value_ranking !== true) return null;
  const assessment = (unitValue.assessments || []).find((item) => same(item.offer_id, offer.id));
  if (assessment?.status !== "comparable" || !finite(assessment.normalized_quantity) || assessment.normalized_quantity <= 0 || !assessment.normalized_unit) return null;
  if (!finite(assessment.landed_total_usd) || landed == null || Math.abs(assessment.landed_total_usd - landed) > 0.01) return null;
  return assessment;
}

export function normalizeShoppingOffers(offers, requirements = {}, unitValue = null, promotionArtifacts = [], fulfillment = null, evaluatedAt = Date.now(), maxPromotionAgeSeconds = 900, maxFulfillmentAgeSeconds = 900, destinationCountry = null, counterfeit = null, maxCounterfeitAgeSeconds = 3_600, merchant = null, maxMerchantAgeSeconds = 3_600, protection = null, maxProtectionAgeSeconds = 3_600, identity = null, maxIdentityAgeSeconds = 3_600, safety = null, maxSafetyAgeSeconds = 86_400, productClearance = null, maxProductClearanceAgeSeconds = 3_600) {
  return (offers || []).map((offer) => {
    const promotion = promotionAssessment(offer, promotionArtifacts, evaluatedAt, maxPromotionAgeSeconds);
    const fulfillmentResult = fulfillmentAssessment(offer, fulfillment, promotionArtifacts, evaluatedAt, maxFulfillmentAgeSeconds, maxPromotionAgeSeconds, destinationCountry);
    const range = fulfillmentResult?.fully_landed_total_usd ?? null;
    const landed = range?.expected_usd ?? null;
    const counterfeitResult = validateCounterfeitAssessment({ artifact: counterfeit, offer, evaluated_at: evaluatedAt, max_age_seconds: maxCounterfeitAgeSeconds });
    const merchantResult = validateMerchantTrustAssessment({ artifact: merchant, offer, evaluated_at: evaluatedAt, max_age_seconds: maxMerchantAgeSeconds });
    const protectionResult = validateProtectionAssessment({ artifact: protection, offer, evaluated_at: evaluatedAt, max_age_seconds: maxProtectionAgeSeconds });
    const identityResult = validateIdentityResolution({ artifact: identity, offer, evaluated_at: evaluatedAt, max_age_seconds: maxIdentityAgeSeconds });
    const safetyResult = validateSafetyAssessment({ artifact: safety, offer, jurisdiction: destinationCountry, evaluated_at: evaluatedAt, max_age_seconds: maxSafetyAgeSeconds });
    const clearanceResult = validateProductClearance({ artifact: productClearance, product_id: offer.product_key, evaluated_at: evaluatedAt, max_age_seconds: maxProductClearanceAgeSeconds });
    const failures = requirementFailures(requirements, offer, unitValue, promotionArtifacts, fulfillment, evaluatedAt, maxPromotionAgeSeconds, maxFulfillmentAgeSeconds, destinationCountry, counterfeit, maxCounterfeitAgeSeconds, merchant, maxMerchantAgeSeconds, protection, maxProtectionAgeSeconds, identity, maxIdentityAgeSeconds, safety, maxSafetyAgeSeconds, productClearance, maxProductClearanceAgeSeconds);
    const value = valueAssessment(unitValue, offer, landed);
    return {
      ...offer,
      stock: counterfeitResult?.availability?.status ?? "unknown",
      stock_verified: counterfeitResult?.availability?.evidence_status === "verified",
      computed_landed_total_usd: landed,
      computed_landed_range_usd: range,
      normalized_value_quantity: value?.normalized_quantity ?? null,
      normalized_value_unit: value?.normalized_unit ?? null,
      computed_unit_cost_usd: value ? Math.round((landed / value.normalized_quantity) * 1_000_000) / 1_000_000 : null,
      unit_value_verified: Boolean(value),
      promotion_pricing_verified: !hasPromotionClaim(offer) || Boolean(promotion),
      immediate_checkout_discount_usd: promotion?.immediate_checkout_discount_usd ?? 0,
      deferred_value_usd: promotion?.deferred_value_usd ?? 0,
      required_incremental_cost_usd: promotion?.required_incremental_cost_usd ?? 0,
      fulfillment_verified: Boolean(fulfillmentResult),
      counterfeit_risk_verified: Boolean(counterfeitResult),
      counterfeit_risk_status: counterfeitResult?.risk_status ?? "unknown",
      merchant_trust_verified: Boolean(merchantResult),
      merchant_trust_status: merchantResult?.status ?? "unknown",
      purchase_protection_verified: Boolean(protectionResult),
      purchase_protection_status: protectionResult?.status ?? "needs_research",
      canonical_identity_verified: Boolean(identityResult),
      canonical_identity_classification: identityResult?.classification ?? "insufficient_evidence",
      official_safety_verified: Boolean(safetyResult),
      official_safety_action: safetyResult?.action ?? "research_more",
      product_decision_clearance_verified: Boolean(clearanceResult),
      landed_price_verified: Boolean(fulfillmentResult),
      hard_requirements_met: failures.length === 0,
      requirement_failures: failures,
    };
  });
}

export function decideShoppingOffer({ requirements = {}, objective = "landed_total", offers = [], clarification_required = false, unit_value = null, promotion_artifacts = [], fulfillment = null, counterfeit = null, merchant = null, protection = null, identity = null, safety = null, product_clearance = null, destination_country = null, evaluated_at = null, max_promotion_age_seconds = 900, max_fulfillment_age_seconds = 900, max_counterfeit_age_seconds = 3_600, max_merchant_age_seconds = 3_600, max_protection_age_seconds = 3_600, max_identity_age_seconds = 3_600, max_safety_age_seconds = 86_400, max_product_clearance_age_seconds = 3_600, allow_expected_landed_selection = false }) {
  if (clarification_required) return { action: "clarify", selected_offer: null, landed_total_usd: null };
  const evaluatedAt = Date.parse(evaluated_at || new Date().toISOString());
  const eligible = normalizeShoppingOffers(offers, requirements, unit_value, promotion_artifacts, fulfillment, evaluatedAt, max_promotion_age_seconds, max_fulfillment_age_seconds, destination_country, counterfeit, max_counterfeit_age_seconds, merchant, max_merchant_age_seconds, protection, max_protection_age_seconds, identity, max_identity_age_seconds, safety, max_safety_age_seconds, product_clearance, max_product_clearance_age_seconds)
    .map((offer, index) => ({ offer, index }))
    .filter(({ offer }) => offer.hard_requirements_met && offer.landed_price_verified);
  if (!eligible.length) return { action: "research_more", selected_offer: null, landed_total_usd: null };
  if (objective === "unit_cost") {
    const unresolved = eligible.filter(({ offer }) => offer.unit_value_verified !== true).map(({ offer }) => offer.id);
    if (unresolved.length) return { action: "research_more", selected_offer: null, landed_total_usd: null, reason: "unit_value_not_cleared", unresolved_offer_ids: unresolved };
    const ranged = eligible.filter(({ offer }) => offer.computed_landed_range_usd.low_usd !== offer.computed_landed_range_usd.high_usd).map(({ offer }) => offer.id);
    if (ranged.length) return { action: "research_more", selected_offer: null, landed_total_usd: null, reason: "unit_cost_requires_exact_fully_landed_cost", unresolved_offer_ids: ranged };
  }
  const metric = ({ offer }) => objective === "unit_cost" ? offer.computed_unit_cost_usd : offer.computed_landed_total_usd;
  eligible.sort((a, b) => metric(a) - metric(b) || (b.offer.return_days || 0) - (a.offer.return_days || 0) || a.index - b.index);
  if (objective === "landed_total" && allow_expected_landed_selection !== true && eligible.some(({ offer }) => offer.computed_landed_range_usd.low_usd !== offer.computed_landed_range_usd.high_usd)) {
    const robust = eligible.filter((candidate) => eligible.every((other) => candidate === other || candidate.offer.computed_landed_range_usd.high_usd <= other.offer.computed_landed_range_usd.low_usd));
    if (robust.length !== 1) return { action: "clarify", selected_offer: null, landed_total_usd: null, reason: "fully_landed_cost_ranges_overlap", overlapping_offer_ids: eligible.map(({ offer }) => offer.id) };
    const winner = robust[0].offer;
    return { action: "select", selected_offer: winner.id, landed_total_usd: winner.computed_landed_total_usd, landed_total_range_usd: winner.computed_landed_range_usd };
  }
  const winner = eligible[0].offer;
  return { action: "select", selected_offer: winner.id, landed_total_usd: winner.computed_landed_total_usd, landed_total_range_usd: winner.computed_landed_range_usd };
}

export function analyzeShoppingOffers(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  const normalized_offers = normalizeShoppingOffers(input.offers, input.requirements, input.unit_value, input.promotion_artifacts, input.fulfillment, evaluatedAt, input.max_promotion_age_seconds, input.max_fulfillment_age_seconds, input.destination_country, input.counterfeit, input.max_counterfeit_age_seconds, input.merchant, input.max_merchant_age_seconds, input.protection, input.max_protection_age_seconds, input.identity, input.max_identity_age_seconds, input.safety, input.max_safety_age_seconds, input.product_clearance, input.max_product_clearance_age_seconds);
  const verified_decision = decideShoppingOffer(input);
  return { normalized_offers, verified_decision };
}
