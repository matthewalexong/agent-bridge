const DAY = 86_400_000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const cents = (value) => Math.round(value * 100) / 100;
const clean = (value) => String(value ?? "").trim();
const unique = (items) => [...new Set(items)];

const IMMEDIATE = new Set(["automatic_discount", "coupon", "instant_discount", "membership_price", "subscription_price"]);
const DEFERRED = new Set(["cashback", "rebate", "store_credit", "loyalty_points", "trade_in", "bundle_credit"]);
const TENDER_OR_FINANCE = new Set(["gift_card", "financing"]);
const USER_FACT_SOURCES = new Set(["current_user_message", "verified_account_state"]);

function verified(value) {
  return value?.evidence_status === "verified" && clean(value?.source_id);
}

function fresh(value, evaluatedAt, maxAgeSeconds) {
  const at = Date.parse(value || "");
  return Number.isFinite(at) && at <= evaluatedAt + 5_000 && evaluatedAt - at <= maxAgeSeconds * 1_000;
}

function validAcceptance(obligation, offer, evaluatedAt, maxAgeSeconds) {
  if (obligation.user_acceptance_required !== true) return true;
  const at = Date.parse(obligation.accepted_at || "");
  const capturedAt = Date.parse(offer.captured_at || "");
  return obligation.acceptance_source === "current_user_message"
    && Number.isFinite(at) && Number.isFinite(capturedAt)
    && at >= capturedAt && at <= evaluatedAt + 5_000
    && evaluatedAt - at <= maxAgeSeconds * 1_000;
}

export function validateShoppingPromotionArtifact({ artifact, offer_id, product_id, base_price_usd = null, shipping_usd = null, evaluated_at = Date.now(), max_age_seconds = 900 }) {
  if (!verifyShoppingArtifactAttestation("promotion", artifact) || artifact.action !== "eligible" || artifact.pricing_cleared !== true || artifact.purchase_allowed !== false) return null;
  if (clean(artifact.offer_id).toLowerCase() !== clean(offer_id).toLowerCase() || clean(artifact.product_id).toLowerCase() !== clean(product_id).toLowerCase()) return null;
  const artifactAt = Date.parse(artifact.evaluated_at || "");
  if (!Number.isFinite(artifactAt) || !Number.isFinite(evaluated_at) || artifactAt > evaluated_at + 5_000 || evaluated_at - artifactAt > max_age_seconds * 1_000) return null;
  if (![artifact.base_price_usd, artifact.shipping_usd, artifact.immediate_checkout_discount_usd, artifact.required_incremental_cost_usd, artifact.checkout_landed_total_usd, artifact.guaranteed_economic_cost_usd].every(finite)) return null;
  if (finite(base_price_usd) && Math.abs(artifact.base_price_usd - base_price_usd) > 0.01) return null;
  if (finite(shipping_usd) && Math.abs(artifact.shipping_usd - shipping_usd) > 0.01) return null;
  const checkout = cents(artifact.base_price_usd + artifact.shipping_usd - artifact.immediate_checkout_discount_usd);
  const economic = cents(checkout + artifact.required_incremental_cost_usd);
  if (artifact.immediate_checkout_discount_usd > artifact.base_price_usd || Math.abs(artifact.checkout_landed_total_usd - checkout) > 0.01 || Math.abs(artifact.guaranteed_economic_cost_usd - economic) > 0.01) return null;
  return artifact;
}

export function assessShoppingPromotion(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Promotion timestamp is invalid"), { code: "shopping_promotion_invalid" });
  const policy = { max_age_seconds: input.policy?.max_age_seconds ?? 900, max_acceptance_age_seconds: input.policy?.max_acceptance_age_seconds ?? 300 };
  const offer = input.offer || {};
  const blockers = [];
  const research = [];
  const clarifications = [];
  const warnings = [];
  const includedPromotionIds = [];
  const excludedPromotions = [];
  let immediateDiscount = 0;
  let deferredValue = 0;
  let incrementalCost = 0;

  if (!offer.id || !offer.product_id || offer.exact_identity !== true) blockers.push("exact_offer_identity_unverified");
  if (!fresh(offer.captured_at, evaluatedAt, policy.max_age_seconds)) research.push("promotion_evidence_stale_or_invalid");
  if (!verified(offer.base_price) || !finite(offer.base_price?.value)) research.push("base_price_unverified");
  if (!verified(offer.shipping) || !finite(offer.shipping?.value)) research.push("shipping_unverified");
  if (offer.promotion_inventory_complete !== true || offer.promotion_inventory_evidence_status !== "verified" || !clean(offer.promotion_inventory_source_id)) research.push("promotion_inventory_unverified");

  const promotions = Array.isArray(offer.promotions) ? offer.promotions : [];
  const applied = promotions.filter((promotion) => promotion.application_status === "applied");
  if (applied.length > 1 && applied.some((promotion) => promotion.stacking?.verified !== true || !clean(promotion.stacking?.source_id))) research.push("promotion_stacking_unverified");

  for (const promotion of promotions) {
    const id = clean(promotion.id) || "unknown";
    const relevant = promotion.application_status === "applied" || promotion.affects_advertised_price === true;
    let promotable = true;
    let promotionIncrementalCost = 0;
    const reasons = [];
    if (!verified(promotion)) { reasons.push("terms_unverified"); promotable = false; }
    if (promotion.expires_at) {
      const expiresAt = Date.parse(promotion.expires_at);
      if (!Number.isFinite(expiresAt)) { reasons.push("expiry_invalid"); promotable = false; }
      else if (expiresAt < evaluatedAt) { reasons.push("expired"); promotable = false; }
    }
    if (promotion.eligibility_complete !== true) { reasons.push("eligibility_incomplete"); promotable = false; }
    for (const criterion of promotion.eligibility || []) {
      if (criterion.status === "not_satisfied") { reasons.push(`ineligible:${criterion.id}`); promotable = false; }
      else if (criterion.status !== "satisfied" || !verified(criterion)) { reasons.push(`eligibility_unverified:${criterion.id}`); promotable = false; }
      else if (criterion.user_specific === true && !USER_FACT_SOURCES.has(criterion.user_fact_source)) { reasons.push(`user_eligibility_inferred:${criterion.id}`); promotable = false; }
    }
    if (promotion.obligations_complete !== true) { reasons.push("obligations_incomplete"); promotable = false; }
    for (const obligation of promotion.obligations || []) {
      if (!verified(obligation)) { reasons.push(`obligation_unverified:${obligation.id}`); promotable = false; }
      if (obligation.status === "not_satisfied") { reasons.push(`obligation_not_satisfied:${obligation.id}`); promotable = false; }
      else if (obligation.status !== "satisfied") { reasons.push(`obligation_unknown:${obligation.id}`); promotable = false; }
      if (obligation.user_acceptance_required === true && !validAcceptance(obligation, offer, evaluatedAt, policy.max_acceptance_age_seconds)) {
        clarifications.push(`promotion:${id}:fresh_user_acceptance_required:${obligation.id}`);
        promotable = false;
      }
      if (finite(obligation.incremental_cost_usd) && obligation.incremental_cost_usd > 0 && verified(obligation)) promotionIncrementalCost += obligation.incremental_cost_usd;
      if (obligation.recurring === true) warnings.push(`promotion:${id}:recurring_obligation`);
    }

    if (promotion.application_status === "rejected") reasons.push("not_applied");
    else if (promotion.application_status !== "applied" && promotion.application_status !== "available") reasons.push("application_status_unresolved");

    if (IMMEDIATE.has(promotion.type)) {
      if (promotion.application_status === "applied" && promotable) {
        if (!finite(promotion.amount_applied_usd) || promotion.amount_applied_usd < 0) { reasons.push("applied_amount_unverified"); promotable = false; }
        else { immediateDiscount += promotion.amount_applied_usd; incrementalCost += promotionIncrementalCost; includedPromotionIds.push(id); }
      } else if (promotion.affects_advertised_price === true && !["applied", "rejected"].includes(promotion.application_status) && reasons.length === 0) {
        reasons.push("advertised_discount_not_applied");
        promotable = false;
      }
    } else if (DEFERRED.has(promotion.type)) {
      if (promotable && finite(promotion.deferred_value_usd)) deferredValue += promotion.deferred_value_usd;
      warnings.push(`promotion:${id}:deferred_value_not_checkout_discount`);
    } else if (TENDER_OR_FINANCE.has(promotion.type)) {
      warnings.push(`promotion:${id}:${promotion.type}_is_not_a_discount`);
    } else {
      reasons.push("promotion_type_unknown");
      promotable = false;
    }

    if (!promotable || reasons.length) {
      excludedPromotions.push({ id, reasons: unique(reasons) });
      if (relevant && reasons.some((reason) => !reason.startsWith("ineligible:") && reason !== "expired" && reason !== "not_applied")) research.push(`promotion:${id}:${reasons[0]}`);
      if (promotion.application_status === "applied" && reasons.length) research.push(`promotion:${id}:applied_terms_not_cleared`);
    }
  }

  const base = finite(offer.base_price?.value) ? offer.base_price.value : null;
  const shipping = finite(offer.shipping?.value) ? offer.shipping.value : null;
  if (base != null && immediateDiscount > base) blockers.push("discount_exceeds_base_price");
  immediateDiscount = cents(immediateDiscount);
  deferredValue = cents(deferredValue);
  incrementalCost = cents(incrementalCost);
  const normalizedBlockers = unique(blockers);
  const normalizedResearch = unique(research);
  const normalizedClarifications = unique(clarifications);
  const action = normalizedBlockers.length ? "avoid_offer" : normalizedResearch.length ? "research_more" : normalizedClarifications.length ? "clarify" : "eligible";
  const pricingCleared = action === "eligible" && base != null && shipping != null;
  return {
    offer_id: offer.id || null,
    product_id: offer.product_id || null,
    evaluated_at: new Date(evaluatedAt).toISOString(),
    action,
    pricing_cleared: pricingCleared,
    base_price_usd: base,
    shipping_usd: shipping,
    immediate_checkout_discount_usd: immediateDiscount,
    checkout_landed_total_usd: pricingCleared ? cents(base + shipping - immediateDiscount) : null,
    deferred_value_usd: deferredValue,
    required_incremental_cost_usd: incrementalCost,
    guaranteed_economic_cost_usd: pricingCleared ? cents(base + shipping - immediateDiscount + incrementalCost) : null,
    included_promotion_ids: includedPromotionIds,
    excluded_promotions: excludedPromotions,
    blockers: normalizedBlockers,
    research: normalizedResearch,
    clarifications: normalizedClarifications,
    warnings: unique(warnings),
    selected_offer: null,
    purchase_allowed: false,
  };
}
import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
