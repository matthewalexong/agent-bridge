import crypto from "node:crypto";
import { verifyShoppingDossierStage } from "./shopping-dossier-stage.mjs";
import { shoppingDecisionContextMatches, verifyShoppingDecisionContext } from "./shopping-decision-context.mjs";

const clean = (value) => String(value ?? "").trim();
const unique = (items) => [...new Set(items)];
const DEFAULT_AGES = { candidate_coverage: 604_800, product_evidence: 2_592_000, performance: 2_592_000, value: 2_592_000, review_integrity: 2_592_000, safety: 86_400, composition: 2_592_000, privacy: 2_592_000, compatibility: 2_592_000, lifecycle: 2_592_000, preferences: 86_400, ownership: 86_400, identity: 3_600, merchant: 3_600, counterfeit: 3_600, condition: 604_800, promotion: 900, protection: 3_600, fulfillment: 900, offer: 900, deal: 86_400, checkout: 120, checkout_consent: 120 };
const CLEARANCE_ATTESTATION_KEY = crypto.randomBytes(32);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function dossierId(input) {
  return `dossier_${crypto.createHash("sha256").update(JSON.stringify(stable(input))).digest("hex").slice(0, 24)}`;
}

function clearancePayload(artifact) {
  return {
    dossier_id: artifact?.dossier_id,
    decision_context_id: artifact?.decision_context_id,
    evaluated_at: artifact?.evaluated_at,
    phase: artifact?.phase,
    product_id: artifact?.product_id,
    offer_id: artifact?.offer_id,
    audit: {
      required: artifact?.audit?.required,
      completed: artifact?.audit?.completed,
      missing: artifact?.audit?.missing,
      stale: artifact?.audit?.stale,
      future: artifact?.audit?.future,
      mismatched: artifact?.audit?.mismatched,
      context_mismatched: artifact?.audit?.context_mismatched,
      invalid_artifacts: artifact?.audit?.invalid_artifacts,
      unconsumed_constraints: artifact?.audit?.unconsumed_constraints,
      invalid_applicability: artifact?.audit?.invalid_applicability,
      invalid_context: artifact?.audit?.invalid_context,
    },
    decision: {
      action: artifact?.decision?.action,
      selected_product: artifact?.decision?.selected_product,
      selected_offer: artifact?.decision?.selected_offer,
      blockers: artifact?.decision?.blockers,
      research: artifact?.decision?.research,
      clarifications: artifact?.decision?.clarifications,
      purchase_allowed: artifact?.decision?.purchase_allowed,
      model_override_allowed: artifact?.decision?.model_override_allowed,
    },
  };
}

function issueClearanceAttestation(artifact) {
  const digest = crypto.createHmac("sha256", CLEARANCE_ATTESTATION_KEY).update(JSON.stringify(stable(clearancePayload(artifact)))).digest("hex");
  return `v1.${digest}`;
}

function clearanceAttestationValid(artifact) {
  const match = /^v1\.([a-f0-9]{64})$/.exec(clean(artifact?.clearance_attestation));
  if (!match) return false;
  const provided = Buffer.from(match[1], "hex");
  const expected = Buffer.from(issueClearanceAttestation(artifact).slice(3), "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function applicable(input, name) {
  const value = input.applicability?.[name];
  if (!value) return { required: false, invalid: true };
  if (value.required === false && !clean(value.reason)) return { required: false, invalid: true };
  return { required: value.required === true, invalid: false };
}

export function requiredShoppingDossierStages(input) {
  const names = ["product_evidence", "safety"];
  if (applicable(input, "candidate_coverage").required) names.push("candidate_coverage");
  if (applicable(input, "performance").required) names.push("performance");
  if (applicable(input, "value").required) names.push("value");
  if (["offer_recommendation", "checkout_review"].includes(input.phase) && applicable(input, "condition").required) names.push("condition");
  if (promotionRequired(input)) names.push("promotion");
  if (applicable(input, "review_integrity").required) names.push("review_integrity");
  if (applicable(input, "composition").required) names.push("composition");
  if (applicable(input, "privacy").required) names.push("privacy");
  if (applicable(input, "compatibility").required) names.push("compatibility");
  for (const name of ["lifecycle", "preferences", "ownership"]) if (applicable(input, name).required) names.push(name);
  if (["offer_recommendation", "checkout_review"].includes(input.phase)) names.push("identity", "merchant", "counterfeit", "protection", "fulfillment", "offer");
  if (["offer_recommendation", "checkout_review"].includes(input.phase) && applicable(input, "deal").required) names.push("deal");
  if (input.phase === "checkout_review") names.push("checkout", "checkout_consent");
  for (const route of input.decision_context?.constraint_routes || []) {
    if (route.status === "active") names.push(...route.stages);
  }
  return unique(names);
}

function promotionRequired(input) {
  return ["offer_recommendation", "checkout_review"].includes(input.phase)
    && (applicable(input, "promotion").required || input.stages?.offer?.promotion_affects_price === true || (input.stages?.checkout?.applied_discount_usd ?? 0) > 0);
}

function subjectMismatch(stageName, stage, productId, offerId) {
  if (stageName === "candidate_coverage") return !stage.eligible_candidate_ids?.includes(productId);
  if (["product_evidence", "performance", "review_integrity", "safety", "composition", "privacy", "compatibility", "lifecycle"].includes(stageName)) return stage.product_id !== productId;
  if (["preferences", "ownership"].includes(stageName)) return stage.selected_candidate != null && stage.selected_candidate !== productId;
  if (stageName === "value") return !stage.eligible_product_ids?.includes(productId) || (offerId != null && !stage.eligible_offer_ids?.includes(offerId));
  if (stageName === "condition") return stage.product_id !== productId || stage.offer_id !== offerId;
  if (stageName === "promotion") return stage.product_id !== productId || stage.offer_id !== offerId;
  if (stageName === "identity") return stage.offer_id !== offerId || stage.product_id !== productId;
  if (["merchant", "counterfeit", "protection", "fulfillment", "offer", "deal", "checkout", "checkout_consent"].includes(stageName)) return stage.product_id !== productId || stage.offer_id !== offerId;
  return false;
}

function auditStages(input, evaluatedAt, requireStageAttestations, requireDecisionContext) {
  const required = requiredShoppingDossierStages(input);
  const missing = [];
  const stale = [];
  const future = [];
  const mismatched = [];
  const invalidArtifacts = [];
  const contextMismatched = [];
  const unconsumedConstraints = [];
  const completed = [];
  for (const name of required) {
    const stage = input.stages?.[name];
    if (!stage) { missing.push(name); continue; }
    if (!clean(stage.artifact_id) || (requireStageAttestations && !verifyShoppingDossierStage(name, stage))) invalidArtifacts.push(name);
    if (requireDecisionContext && stage.decision_context_id !== input.decision_context?.context_id) contextMismatched.push(name);
    if (requireDecisionContext) {
      for (const route of input.decision_context?.constraint_routes || []) {
        if (route.status === "active" && route.stages.includes(name) && !stage.consumed_constraint_ids?.includes(route.constraint_id)) unconsumedConstraints.push(`${route.constraint_id}:${name}`);
      }
    }
    const at = Date.parse(stage.evaluated_at);
    const ageLimit = (input.freshness_seconds?.[name] ?? DEFAULT_AGES[name]) * 1_000;
    if (!Number.isFinite(at)) invalidArtifacts.push(name);
    else if (at - evaluatedAt > 300_000) future.push(name);
    else if (evaluatedAt - at > ageLimit) stale.push(name);
    if (subjectMismatch(name, stage, input.product_id, input.offer_id)) mismatched.push(name);
    completed.push(name);
  }
  const invalidApplicability = ["candidate_coverage", "performance", "value", "condition", "promotion", "review_integrity", "composition", "privacy", "compatibility", "lifecycle", "preferences", "ownership", "deal"].filter((name) => applicable(input, name).invalid);
  const invalidContext = [];
  if (requireDecisionContext) {
    if (!input.decision_context) invalidContext.push("missing");
    else if (!verifyShoppingDecisionContext(input.decision_context, evaluatedAt)) invalidContext.push("invalid_or_expired");
    else if (!shoppingDecisionContextMatches(input.decision_context, input)) invalidContext.push("scope_or_applicability_mismatch");
    else if (Number.isInteger(input.current_profile_state_revision) && input.decision_context.profile_state_revision !== input.current_profile_state_revision) invalidContext.push("profile_revision_stale");
  }
  return { required, completed, missing, stale, future, mismatched, context_mismatched: unique(contextMismatched), invalid_artifacts: unique(invalidArtifacts), unconsumed_constraints: unique(unconsumedConstraints), invalid_applicability: invalidApplicability, invalid_context: invalidContext };
}

function pushByAction(stage, name, research, clarify) {
  if (stage.action === "research_more") research.push(`${name}:${stage.reason || "research_required"}`);
  if (stage.action === "clarify") clarify.push(`${name}:${stage.reason || "clarification_required"}`);
}

export function validateProductClearance({ artifact, product_id, evaluated_at = Date.now(), max_age_seconds = 3_600 }) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  if (!artifact?.dossier_id || artifact.phase !== "product_recommendation" || !Number.isFinite(evaluatedAt)) return null;
  if (!clearanceAttestationValid(artifact)) return null;
  const artifactAt = Date.parse(artifact.evaluated_at || "");
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > max_age_seconds * 1_000) return null;
  if (artifact.product_id !== product_id || artifact.offer_id !== null) return null;
  const decision = artifact.decision || {};
  if (decision.action !== "recommend_product" || decision.selected_product !== product_id || decision.selected_offer !== null) return null;
  if (decision.purchase_allowed !== false || decision.model_override_allowed !== false) return null;
  if ([decision.blockers, decision.research, decision.clarifications].some((items) => !Array.isArray(items) || items.length)) return null;
  const audit = artifact.audit || {};
  const failureLists = ["missing", "stale", "future", "mismatched", "context_mismatched", "invalid_artifacts", "unconsumed_constraints", "invalid_applicability", "invalid_context"];
  if (failureLists.some((name) => !Array.isArray(audit[name]) || audit[name].length)) return null;
  if (!Array.isArray(audit.required) || !Array.isArray(audit.completed)) return null;
  if (!["product_evidence", "safety"].every((name) => audit.required.includes(name))) return null;
  if (!audit.required.every((name) => audit.completed.includes(name))) return null;
  if (new Set(audit.required).size !== audit.required.length || new Set(audit.completed).size !== audit.completed.length) return null;
  return artifact;
}

export function composeShoppingDossier(input, { require_stage_attestations = true, require_decision_context = true } = {}) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Dossier evaluation timestamp is invalid"), { code: "shopping_dossier_invalid" });
  const audit = auditStages(input, evaluatedAt, require_stage_attestations, require_decision_context);
  const blockers = [];
  const research = [];
  const clarifications = [];
  const warnings = [];
  const stages = input.stages || {};

  for (const name of audit.missing) research.push(`missing_stage:${name}`);
  for (const name of audit.stale) research.push(`stale_stage:${name}`);
  for (const name of audit.future) blockers.push(`future_dated_stage:${name}`);
  for (const name of audit.mismatched) blockers.push(`scope_mismatch:${name}`);
  for (const name of audit.context_mismatched) blockers.push(`decision_context_mismatch:${name}`);
  for (const name of audit.invalid_artifacts) blockers.push(`invalid_artifact:${name}`);
  for (const item of audit.unconsumed_constraints) blockers.push(`unconsumed_constraint:${item}`);
  for (const name of audit.invalid_applicability) blockers.push(`unjustified_stage_skip:${name}`);
  for (const reason of audit.invalid_context) blockers.push(`invalid_decision_context:${reason}`);

  if (stages.product_evidence) {
    if (["conflict", "insufficient_evidence", "stale"].includes(stages.product_evidence.status)) research.push(`product_evidence:${stages.product_evidence.status}`);
    else if (stages.product_evidence.status !== "verified") blockers.push("product_evidence:invalid_status");
  }
  if (applicable(input, "candidate_coverage").required && stages.candidate_coverage) {
    if (stages.candidate_coverage.action === "research_more") research.push("candidate_coverage:research_more");
    else if (stages.candidate_coverage.action !== "coverage_sufficient") blockers.push("candidate_coverage:invalid_action");
    if (stages.candidate_coverage.action === "coverage_sufficient" && stages.candidate_coverage.candidate_set_cleared_for_ranking !== true) blockers.push("candidate_coverage:clearance_violation");
  }
  if (applicable(input, "performance").required && stages.performance) {
    if (stages.performance.action === "research_more") research.push("performance:research_more");
    else if (stages.performance.action === "conflict") research.push("performance:conflict");
    else if (stages.performance.action !== "comparable") blockers.push("performance:invalid_action");
    if (stages.performance.action === "comparable" && stages.performance.performance_cleared_for_ranking !== true) blockers.push("performance:clearance_violation");
  }
  if (applicable(input, "value").required && stages.value) {
    if (stages.value.action === "research_more") research.push("value:research_more");
    else if (stages.value.action !== "comparable") blockers.push("value:invalid_action");
    if (stages.value.action === "comparable" && stages.value.safe_for_value_ranking !== true) blockers.push("value:clearance_violation");
  }
  if (["offer_recommendation", "checkout_review"].includes(input.phase) && applicable(input, "condition").required && stages.condition) {
    if (stages.condition.action === "research_more") research.push("condition:research_more");
    else if (stages.condition.action === "clarify_tradeoff") clarifications.push("condition:tradeoff_not_accepted");
    else if (stages.condition.action === "avoid_offer") blockers.push("condition:avoid_offer");
    else if (stages.condition.action !== "eligible") blockers.push("condition:invalid_action");
    if (stages.condition.action === "eligible" && stages.condition.condition_cleared_for_offer_comparison !== true) blockers.push("condition:clearance_violation");
  }
  if (promotionRequired(input) && stages.promotion) {
    if (stages.promotion.action === "research_more") research.push("promotion:research_more");
    else if (stages.promotion.action === "clarify") clarifications.push("promotion:fresh_acceptance_required");
    else if (stages.promotion.action === "avoid_offer") blockers.push("promotion:avoid_offer");
    else if (stages.promotion.action !== "eligible") blockers.push("promotion:invalid_action");
    if (stages.promotion.action === "eligible" && stages.promotion.pricing_cleared !== true) blockers.push("promotion:clearance_violation");
  }
  if (applicable(input, "review_integrity").required && stages.review_integrity) {
    if (stages.review_integrity.action === "research_more") research.push("review_integrity:research_more");
    else if (stages.review_integrity.action === "exclude_reviews") blockers.push("review_integrity:reviews_must_be_excluded");
    else if (stages.review_integrity.action !== "eligible_for_review_ranking") blockers.push("review_integrity:invalid_action");
    if (stages.review_integrity.action === "eligible_for_review_ranking" && stages.review_integrity.review_evidence_cleared_for_ranking !== true) blockers.push("review_integrity:clearance_violation");
  }
  if (stages.safety) {
    if (stages.safety.action === "research_more") research.push("safety:research_more");
    else if (stages.safety.action === "clarify_tradeoff") clarifications.push("safety:tradeoff_not_accepted");
    else if (stages.safety.action === "avoid_product") blockers.push("safety:avoid_product");
    else if (stages.safety.action !== "eligible") blockers.push("safety:invalid_action");
    if (stages.safety.action === "eligible" && stages.safety.safety_cleared_for_ranking !== true) blockers.push("safety:clearance_violation");
  }
  if (applicable(input, "composition").required && stages.composition) {
    if (stages.composition.action === "research_more") research.push("composition:research_more");
    else if (stages.composition.action === "clarify") clarifications.push("composition:cross_contact_tradeoff");
    else if (stages.composition.action === "reject") blockers.push("composition:rejected");
    else if (stages.composition.action !== "eligible") blockers.push("composition:invalid_action");
    if (stages.composition.action === "eligible" && stages.composition.composition_cleared_for_ranking !== true) blockers.push("composition:clearance_violation");
  }
  if (applicable(input, "privacy").required && stages.privacy) {
    if (stages.privacy.action === "research_more") research.push("privacy:research_more");
    else if (stages.privacy.action === "clarify_tradeoff") clarifications.push("privacy:tradeoff_not_accepted");
    else if (stages.privacy.action === "reject") blockers.push("privacy:rejected");
    else if (stages.privacy.action !== "eligible") blockers.push("privacy:invalid_action");
    if (stages.privacy.action === "eligible" && stages.privacy.privacy_cleared_for_ranking !== true) blockers.push("privacy:clearance_violation");
  }
  if (applicable(input, "compatibility").required && stages.compatibility) {
    if (stages.compatibility.action === "research_more") research.push("compatibility:research_more");
    else if (stages.compatibility.action === "incompatible") blockers.push("compatibility:incompatible");
    else if (stages.compatibility.action !== "compatible") blockers.push("compatibility:invalid_action");
    if (stages.compatibility.action === "compatible" && stages.compatibility.safe_for_ranking !== true) blockers.push("compatibility:ranking_safety_violation");
  }
  if (applicable(input, "lifecycle").required && stages.lifecycle) {
    if (stages.lifecycle.purchase_gate === "avoid_product") blockers.push("lifecycle:avoid_product");
    else if (stages.lifecycle.purchase_gate === "research_more") research.push("lifecycle:research_more");
    else if (stages.lifecycle.purchase_gate === "clarify_tradeoff" && stages.lifecycle.user_accepted_tradeoff !== true) clarifications.push("lifecycle:tradeoff_not_accepted");
    else if (!["eligible_for_ranking", "clarify_tradeoff"].includes(stages.lifecycle.purchase_gate)) blockers.push("lifecycle:invalid_gate");
  }
  if (applicable(input, "preferences").required && stages.preferences) pushByAction(stages.preferences, "preferences", research, clarifications);
  if (applicable(input, "ownership").required && stages.ownership) pushByAction(stages.ownership, "ownership", research, clarifications);

  if (["offer_recommendation", "checkout_review"].includes(input.phase)) {
    if (stages.identity) {
      if (stages.identity.classification === "insufficient_evidence") research.push("identity:insufficient_evidence");
      else if (stages.identity.classification !== "exact_match" || stages.identity.safe_to_compare_offers !== true) blockers.push(`identity:${stages.identity.classification || "invalid"}`);
    }
    if (stages.merchant) {
      if (stages.merchant.purchase_gate === "research_more") research.push("merchant:research_more");
      else if (stages.merchant.purchase_gate === "avoid_offer") blockers.push("merchant:avoid_offer");
      else if (stages.merchant.purchase_gate !== "eligible_for_other_shopping_checks") blockers.push("merchant:invalid_gate");
    }
    if (stages.counterfeit) {
      if (stages.counterfeit.risk_status === "unknown") research.push("counterfeit:risk_unknown");
      else if (stages.counterfeit.risk_status === "elevated") blockers.push("counterfeit:risk_elevated");
      else if (!["low", "acceptable"].includes(stages.counterfeit.risk_status)) blockers.push("counterfeit:invalid_status");
      const authorizationStatus = stages.counterfeit.authorization_requirement_status || "not_required";
      if (authorizationStatus === "failed") blockers.push("counterfeit:authorized_seller_required");
      else if (authorizationStatus === "unknown") research.push("counterfeit:authorized_seller_unresolved");
      else if (!["not_required", "satisfied"].includes(authorizationStatus)) blockers.push("counterfeit:authorization_requirement_invalid");
      const expectedGate = stages.counterfeit.risk_status === "elevated" || authorizationStatus === "failed" ? "avoid_offer"
        : stages.counterfeit.risk_status === "unknown" || authorizationStatus === "unknown" ? "research_more"
          : "eligible_for_other_shopping_checks";
      if (stages.counterfeit.purchase_gate && stages.counterfeit.purchase_gate !== expectedGate) blockers.push("counterfeit:purchase_gate_inconsistent");
    }
    if (stages.protection) {
      if (stages.protection.status === "needs_research") research.push("protection:needs_research");
      else if (stages.protection.status === "rejected") blockers.push("protection:rejected");
      else if (stages.protection.status !== "eligible") blockers.push("protection:invalid_status");
    }
    if (stages.fulfillment) {
      if (stages.fulfillment.action === "research_more") research.push("fulfillment:research_more");
      else if (stages.fulfillment.action === "clarify") clarifications.push("fulfillment:clarify");
      else if (stages.fulfillment.action === "avoid_offer") blockers.push("fulfillment:avoid_offer");
      else if (stages.fulfillment.action !== "eligible") blockers.push("fulfillment:invalid_action");
      if (stages.fulfillment.fully_landed_status === "unknown") research.push("fulfillment:fully_landed_cost_unknown");
      if (stages.fulfillment.safe_for_offer_comparison !== true && stages.fulfillment.action === "eligible") blockers.push("fulfillment:comparison_safety_violation");
    }
    if (stages.offer) {
      pushByAction(stages.offer, "offer", research, clarifications);
      if (stages.offer.action === "select" && stages.offer.selected_offer !== input.offer_id) blockers.push("offer:selected_offer_mismatch");
      if (stages.offer.landed_price_verified !== true) research.push("offer:landed_price_unverified");
      if (stages.offer.stock !== "in_stock") research.push("offer:stock_unverified");
      const fulfillmentRange = stages.fulfillment?.fully_landed_total_usd;
      const offerRange = stages.offer.landed_total_range_usd;
      if (stages.offer.action === "select" && stages.fulfillment?.action === "eligible") {
        if (!fulfillmentRange || !offerRange
          || Math.abs(fulfillmentRange.low_usd - offerRange.low_usd) > 0.01
          || Math.abs(fulfillmentRange.expected_usd - offerRange.expected_usd) > 0.01
          || Math.abs(fulfillmentRange.high_usd - offerRange.high_usd) > 0.01
          || Math.abs(offerRange.expected_usd - stages.offer.landed_total_usd) > 0.01) blockers.push("offer:fulfillment_cost_mismatch");
      }
    }
    if (applicable(input, "deal").required && stages.deal) {
      if (stages.deal.timing_action === "research_more") research.push("deal:research_more");
      else if (stages.deal.timing_action === "avoid_offer") blockers.push("deal:avoid_offer");
      else if (["monitor", "wait"].includes(stages.deal.timing_action)) warnings.push(`deal:${stages.deal.timing_action}`);
      else if (!["buy_now", "buy_if_needed"].includes(stages.deal.timing_action)) blockers.push("deal:invalid_action");
    }
  }

  if (input.phase === "checkout_review" && stages.checkout) {
    if (stages.checkout.purchase_allowed !== false) blockers.push("checkout:purchase_authority_violation");
    if (stages.checkout.status !== "ready_for_confirmation") research.push(`checkout:${stages.checkout.status || "not_ready"}`);
    if (stages.checkout.confirmation_required !== true) blockers.push("checkout:confirmation_boundary_missing");
  }
  if (input.phase === "checkout_review" && stages.checkout_consent) {
    if (stages.checkout_consent.purchase_allowed !== false) blockers.push("checkout_consent:purchase_authority_violation");
    if (stages.checkout_consent.confirmation_required !== true) blockers.push("checkout_consent:confirmation_boundary_missing");
    if (stages.checkout_consent.status === "blocked") blockers.push("checkout_consent:blocked");
    else if (stages.checkout_consent.status === "remove_unrequested_items") blockers.push("checkout_consent:unrequested_items_selected");
    else if (stages.checkout_consent.status === "needs_research") research.push("checkout_consent:needs_research");
    else if (stages.checkout_consent.status === "clarify_consent") clarifications.push("checkout_consent:fresh_acknowledgement_required");
    else if (stages.checkout_consent.status !== "ready_for_confirmation") blockers.push("checkout_consent:invalid_status");
    if (stages.checkout_consent.status === "ready_for_confirmation" && stages.checkout_consent.consent_cleared_for_confirmation !== true) blockers.push("checkout_consent:clearance_violation");
  }

  const normalizedBlockers = unique(blockers);
  const normalizedResearch = unique(research);
  const normalizedClarifications = unique(clarifications);
  let action;
  if (normalizedBlockers.length) action = "block";
  else if (normalizedResearch.length) action = "research_more";
  else if (normalizedClarifications.length) action = "clarify";
  else if (warnings.some((item) => /^deal:(monitor|wait)$/.test(item))) action = "defer_purchase";
  else if (input.phase === "checkout_review") action = "present_checkout_for_confirmation";
  else if (input.phase === "offer_recommendation") action = "recommend_offer";
  else action = "recommend_product";

  const dossier = {
    dossier_id: dossierId(input),
    decision_context_id: input.decision_context?.context_id || null,
    evaluated_at: new Date(evaluatedAt).toISOString(),
    phase: input.phase,
    product_id: input.product_id,
    offer_id: input.offer_id || null,
    audit,
    decision: {
      action,
      selected_product: ["recommend_product", "recommend_offer", "defer_purchase", "present_checkout_for_confirmation"].includes(action) ? input.product_id : null,
      selected_offer: ["recommend_offer", "defer_purchase", "present_checkout_for_confirmation"].includes(action) ? input.offer_id : null,
      blockers: normalizedBlockers,
      research: normalizedResearch,
      clarifications: normalizedClarifications,
      warnings: unique(warnings),
      purchase_allowed: false,
      new_explicit_confirmation_required: input.phase === "checkout_review",
      model_override_allowed: false,
    },
  };
  return {
    ...dossier,
    clearance_attestation: dossier.phase === "product_recommendation" && dossier.decision.action === "recommend_product"
      ? issueClearanceAttestation(dossier)
      : null,
  };
}
