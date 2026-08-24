import crypto from "node:crypto";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { SHOPPING_EVALUATOR_STAGES } from "./shopping-evaluator-batch.mjs";
import { SHOPPING_DOSSIER_STAGE_SCHEMAS } from "./shopping-dossier-stage-schema.mjs";
import { verifyShoppingDecisionContext } from "./shopping-decision-context.mjs";

const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();

function coded(message, code = "shopping_dossier_stage_invalid") {
  return Object.assign(new Error(message), { code });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function inputDigest(tool, input) {
  return crypto.createHash("sha256").update(JSON.stringify(stable({ tool, input }))).digest("hex");
}

function same(a, b) {
  return clean(a) && clean(a) === clean(b);
}

function exact(items, predicate, label) {
  const matches = (items || []).filter(predicate);
  if (matches.length !== 1) throw coded(`${label} must resolve to exactly one evaluator result`, "shopping_dossier_stage_scope");
  return matches[0];
}

function iso(...values) {
  for (const value of values) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  throw coded("Evaluator result lacks a valid evaluation timestamp", "shopping_dossier_stage_time");
}

function signed(stage, decisionContextId, evaluatedAt, fields) {
  const payload = { decision_context_id: decisionContextId, stage, evaluated_at: evaluatedAt, ...fields };
  const digest = crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex").slice(0, 24);
  return attestShoppingArtifact("dossier_stage", { artifact_id: `${stage}_${digest}`, ...payload });
}

function requireSubject(subject, offerRequired = false) {
  if (!clean(subject?.product_id)) throw coded("Dossier adaptation requires an exact product subject", "shopping_dossier_stage_scope");
  if (offerRequired && !clean(subject?.offer_id)) throw coded("Dossier adaptation requires an exact offer subject", "shopping_dossier_stage_scope");
}

function productEvidenceStatus(result, productId) {
  const product = exact(result?.products, (item) => same(item.id, productId), "Product evidence subject");
  const statuses = Object.values(product.attribute_evidence || {});
  if (statuses.includes("conflict")) return "conflict";
  if (statuses.length && statuses.every((status) => status === "stale")) return "stale";
  if (!statuses.includes("verified")) return "insufficient_evidence";
  return "verified";
}

export function adaptShoppingEvaluatorResult({ tool, subject, input, result, decision_context, constraint_ids = [], evaluated_at = new Date().toISOString() }) {
  const stage = SHOPPING_EVALUATOR_STAGES[tool];
  if (!stage) throw coded("Tool is not an adaptable shopping evaluator", "shopping_dossier_stage_not_allowed");
  const offerRequired = new Set(["condition", "promotion", "identity", "merchant", "counterfeit", "protection", "fulfillment", "offer", "deal", "checkout", "checkout_consent"]).has(stage);
  requireSubject(subject, offerRequired);
  if (!verifyShoppingDecisionContext(decision_context, evaluated_at)) throw coded("Dossier adaptation requires a fresh process-attested decision context", "shopping_dossier_stage_context_invalid");
  const productId = subject.product_id;
  const offerId = subject.offer_id;
  if (!same(decision_context.product_id, productId) || (decision_context.offer_id && !same(decision_context.offer_id, offerId))) throw coded("Evaluator subject does not match the decision context", "shopping_dossier_stage_context_mismatch");
  const fallbackAt = iso(evaluated_at);
  if (tool === "shopping_candidate_coverage" && !same(input?.market_country, decision_context.market_country_code)) throw coded("Candidate coverage market does not match the decision context", "shopping_dossier_stage_context_mismatch");
  if (tool === "shopping_safety_assess" && !same(input?.jurisdiction, decision_context.market_country_code)) throw coded("Safety jurisdiction does not match the decision context", "shopping_dossier_stage_context_mismatch");
  if (tool === "shopping_fulfillment_assess" && !same(input?.destination_country, decision_context.destination?.country_code)) throw coded("Fulfillment destination does not match the decision context", "shopping_dossier_stage_context_mismatch");
  if (tool === "shopping_checkout_preflight" && !same(input?.expected?.destination_country, decision_context.destination?.country_code)) throw coded("Checkout destination does not match the decision context", "shopping_dossier_stage_context_mismatch");
  let at;
  let fields;

  if (stage === "candidate_coverage") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    fields = { action: result?.action, candidate_set_cleared_for_ranking: result?.candidate_set_cleared_for_ranking, eligible_candidate_ids: result?.eligible_candidate_ids || [] };
  } else if (stage === "product_evidence") {
    at = iso(result?.policy?.evaluated_at, input?.policy?.evaluated_at, fallbackAt);
    fields = { product_id: productId, status: productEvidenceStatus(result, productId) };
  } else if (stage === "performance") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    const item = exact(result?.assessments, (value) => same(value.product_id, productId), "Performance subject");
    fields = { product_id: productId, action: item.action, performance_cleared_for_ranking: item.performance_cleared_for_ranking };
  } else if (stage === "value") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    fields = { action: result?.action, safe_for_value_ranking: result?.safe_for_value_ranking, eligible_product_ids: result?.eligible_product_ids || [], eligible_offer_ids: result?.eligible_offer_ids || [] };
  } else if (stage === "condition") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    if (!same(result?.product_id, productId) || !same(result?.offer_id, offerId)) throw coded("Condition result does not match the exact subject", "shopping_dossier_stage_scope");
    fields = { product_id: productId, offer_id: offerId, action: result.action, condition_cleared_for_offer_comparison: result.condition_cleared_for_offer_comparison };
  } else if (stage === "promotion") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    if (!same(result?.product_id, productId) || !same(result?.offer_id, offerId)) throw coded("Promotion result does not match the exact subject", "shopping_dossier_stage_scope");
    fields = { product_id: productId, offer_id: offerId, action: result.action, pricing_cleared: result.pricing_cleared };
  } else if (stage === "review_integrity") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    if (!same(result?.product_id, productId)) throw coded("Review-integrity result does not match the exact product", "shopping_dossier_stage_scope");
    fields = { product_id: productId, action: result.action, review_evidence_cleared_for_ranking: result.review_evidence_cleared_for_ranking };
  } else if (stage === "safety") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    if (!verifyShoppingArtifactAttestation("safety", result)) throw coded("Safety result lacks its process attestation", "shopping_dossier_stage_source_invalid");
    const item = exact(result?.assessments, (value) => offerId ? same(value.id, offerId) && same(value.product_key, productId) : same(value.product_key, productId), "Safety subject");
    fields = { product_id: productId, action: item.action, safety_cleared_for_ranking: item.safety_cleared_for_ranking };
  } else if (["composition", "privacy", "compatibility"].includes(stage)) {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    const item = exact(result?.assessments, (value) => same(value.id, productId), `${stage} subject`);
    const clearance = stage === "composition" ? { composition_cleared_for_ranking: item.composition_cleared_for_ranking }
      : stage === "privacy" ? { privacy_cleared_for_ranking: item.privacy_cleared_for_ranking }
        : { safe_for_ranking: item.safe_for_ranking };
    fields = { product_id: productId, action: item.action, ...clearance };
  } else if (stage === "lifecycle") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    const item = exact(result?.assessments, (value) => same(value.id, productId), "Lifecycle subject");
    fields = { product_id: productId, purchase_gate: item.purchase_gate, user_accepted_tradeoff: false };
  } else if (["preferences", "ownership"].includes(stage)) {
    at = fallbackAt;
    fields = { action: result?.decision?.action, selected_candidate: result?.decision?.selected_candidate ?? null, reason: result?.decision?.reason };
  } else if (stage === "identity") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    if (!verifyShoppingArtifactAttestation("identity", result) || !same(result?.target_product_id, productId)) throw coded("Identity result lacks matching process-attested product scope", "shopping_dossier_stage_source_invalid");
    const item = exact(result?.resolutions, (value) => same(value.candidate_id, offerId), "Identity offer subject");
    fields = { product_id: productId, offer_id: offerId, classification: item.classification, safe_to_compare_offers: item.safe_to_compare_offers };
  } else if (["merchant", "counterfeit", "protection"].includes(stage)) {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    if (!verifyShoppingArtifactAttestation(stage, result)) throw coded(`${stage} result lacks its process attestation`, "shopping_dossier_stage_source_invalid");
    const key = stage === "counterfeit" ? "offer_id" : "id";
    const item = exact(result?.assessments, (value) => same(value[key], offerId), `${stage} offer subject`);
    if (!same(item.product_id, productId)) throw coded(`${stage} result does not match the exact product`, "shopping_dossier_stage_scope");
    fields = stage === "merchant" ? { product_id: productId, offer_id: offerId, purchase_gate: item.purchase_gate }
      : stage === "counterfeit" ? { product_id: productId, offer_id: offerId, risk_status: item.risk_status, authorization_requirement_status: item.authorization_requirement?.status || "not_required", purchase_gate: item.purchase_gate || (item.risk_status === "elevated" ? "avoid_offer" : item.risk_status === "unknown" ? "research_more" : "eligible_for_other_shopping_checks") }
        : { product_id: productId, offer_id: offerId, status: item.status, return_window_days: item.metrics?.return_window ?? null, warranty_duration_months: item.metrics?.warranty_duration ?? null, buyer_protection_days: item.metrics?.buyer_protection ?? null };
  } else if (stage === "fulfillment") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    const item = exact(result?.assessments, (value) => same(value.id, offerId) && same(value.product_id, productId), "Fulfillment subject");
    fields = { product_id: productId, offer_id: offerId, action: item.action, fully_landed_total_usd: item.fully_landed_total_usd, fully_landed_status: item.fully_landed_status, safe_for_offer_comparison: item.safe_for_offer_comparison, delivery_earliest_at: item.delivery?.earliest_at ?? null, delivery_latest_at: item.delivery?.latest_at ?? null, tracking_available: item.delivery?.tracking_available ?? null };
  } else if (stage === "offer") {
    at = iso(input?.evaluated_at, fallbackAt);
    const item = exact(result?.normalized_offers, (value) => same(value.id, offerId) && same(value.product_key, productId), "Offer-analysis subject");
    const decision = result?.verified_decision || {};
    fields = { product_id: productId, offer_id: offerId, action: decision.action, selected_offer: decision.selected_offer ?? null, reason: decision.reason, landed_total_usd: decision.landed_total_usd ?? null, landed_total_range_usd: decision.landed_total_range_usd ?? null, landed_price_verified: item.landed_price_verified === true, promotion_affects_price: item.promotion_claimed === true || item.promotion_required_for_decision === true || item.immediate_checkout_discount_usd > 0, stock: item.stock || "unknown" };
  } else if (stage === "deal") {
    at = iso(input?.policy?.evaluated_at, fallbackAt);
    if (!same(input?.current?.product_key, productId) || !same(input?.current?.offer_id, offerId)) throw coded("Deal result does not match the exact product and offer", "shopping_dossier_stage_scope");
    fields = { product_id: productId, offer_id: offerId, timing_action: result?.timing?.action };
  } else if (stage === "checkout") {
    at = iso(input?.expected?.evaluated_at, fallbackAt);
    const checkoutItem = exact(input?.cart?.items, (value) => same(value.id, offerId) && same(value.product_key, productId), "Checkout item subject");
    if (!same(input?.expected?.offer_id, offerId) || !same(input?.expected?.product_key, productId) || !checkoutItem) throw coded("Checkout preflight does not bind the exact product and offer", "shopping_dossier_stage_scope");
    if (!verifyShoppingArtifactAttestation("checkout_preflight", result)) throw coded("Checkout preflight result lacks its process attestation", "shopping_dossier_stage_source_invalid");
    fields = { product_id: productId, offer_id: offerId, status: result?.status === "needs_verification" ? "needs_research" : result?.status, applied_discount_usd: result?.applied_discount_usd || 0, confirmation_required: result?.confirmation_required, purchase_allowed: result?.purchase_allowed };
  } else if (stage === "checkout_consent") {
    at = iso(result?.evaluated_at, input?.evaluated_at, fallbackAt);
    if (!same(result?.offer_id, offerId) || !same(result?.product_id, productId)
      || !same(input?.terms_evidence?.product_id ?? input?.product_id, productId)
      || !same(input?.terms_evidence?.offer_id ?? input?.offer_id, offerId)) throw coded("Checkout-consent result does not bind the exact product and offer", "shopping_dossier_stage_scope");
    if (!verifyShoppingArtifactAttestation("checkout_consent", result)) throw coded("Checkout-consent result lacks its process attestation", "shopping_dossier_stage_source_invalid");
    fields = { product_id: productId, offer_id: offerId, status: result.status, consent_cleared_for_confirmation: result.consent_cleared_for_confirmation, confirmation_required: result.confirmation_required, purchase_allowed: result.purchase_allowed };
  }
  if (!fields) throw coded("Evaluator stage adapter is unavailable", "shopping_dossier_stage_not_allowed");
  const consumed_constraint_ids = [...new Set(constraint_ids)].sort();
  if (consumed_constraint_ids.length !== constraint_ids.length) throw coded("Consumed constraint IDs must be distinct", "shopping_dossier_stage_constraint_invalid");
  const artifact = signed(stage, decision_context.context_id, at, { evaluator_input_sha256: inputDigest(tool, input), consumed_constraint_ids, ...fields });
  const parsed = SHOPPING_DOSSIER_STAGE_SCHEMAS[stage].safeParse(artifact);
  if (!parsed.success) throw coded(`Adapted ${stage} result does not satisfy the dossier-stage contract`, "shopping_dossier_stage_shape");
  return parsed.data;
}

export function verifyShoppingDossierStage(stageName, artifact, decisionContextId = null) {
  return artifact?.stage === stageName
    && (!decisionContextId || artifact?.decision_context_id === decisionContextId)
    && verifyShoppingArtifactAttestation("dossier_stage", artifact);
}
