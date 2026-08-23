import { annotateOffers, oraclePurchase } from "./purchase-judge.mjs";

// Production-shaped controller boundary. Deterministic code owns every field
// that can change what the user buys; the language model may only explain the
// already-verified result.
export function preparePurchaseDecision(task) {
  const normalizedOffers = annotateOffers(task.offers, task.requirements, task.unit_value);
  const decision = oraclePurchase(task);
  const obligations = [];
  for (const offer of normalizedOffers) {
    if (offer.shipping_usd == null) obligations.push(`offer ${offer.id}: shipping unknown`);
    if (offer.coupon_usd > 0 && offer.coupon_eligible !== true) obligations.push(`offer ${offer.id}: coupon ineligible`);
    for (const failure of offer.requirement_failures) obligations.push(`offer ${offer.id}: ${failure}`);
  }
  return {
    normalized_offers: normalizedOffers,
    verified_decision: decision,
    evidence_basis: {
      objective: task.objective,
      winner: normalizedOffers.find((offer) => offer.id === decision.selected_offer) || null,
      alternatives: normalizedOffers.filter((offer) => offer.id !== decision.selected_offer),
      missing_preference: task.requires_clarification === true ? task.user_request : null,
      explanation_obligations: obligations,
    },
  };
}

export function finalizePurchaseDecision(verifiedDecision, modelAnswer) {
  return {
    ...verifiedDecision,
    evidence: Array.isArray(modelAnswer?.evidence)
      ? modelAnswer.evidence.map((x) => String(x)).slice(0, 4)
      : [],
  };
}
