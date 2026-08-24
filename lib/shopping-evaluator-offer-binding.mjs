import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const EVIDENCE_COLLECTION = Object.freeze({
  identity: "candidates",
  safety: "candidates",
  merchant: "candidates",
  counterfeit: "offers",
  protection: "candidates",
  fulfillment: "offers",
});

const REQUIRED_BOUND_STAGES = new Set([...Object.keys(EVIDENCE_COLLECTION), "promotion"]);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function exactEvidence(left, right) {
  return verifyShoppingArtifactAttestation("page_evidence", left)
    && left.artifact_attestation === right?.artifact_attestation;
}

export function validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context, stage, subject, input }) {
  const offerPhase = decision_context?.phase === "offer_recommendation" || decision_context?.phase === "checkout_review";
  if (!candidate_offers) {
    if (offerPhase && REQUIRED_BOUND_STAGES.has(stage)) {
      throw coded(`Evaluator stage ${stage} requires the signed exact-offer artifact`, "shopping_candidate_offers_required");
    }
    return [];
  }
  if (!verifyShoppingArtifactAttestation("candidate_offers", candidate_offers)) {
    throw coded("Evaluator offer binding requires an intact signed candidate-offers artifact", "shopping_candidate_offers_invalid");
  }
  const offers = Array.isArray(candidate_offers.offers) ? candidate_offers.offers : [];
  const byId = new Map();
  for (const offer of offers) {
    const candidateId = String(offer?.candidate_id || "");
    if (!candidateId || byId.has(candidateId) || !verifyShoppingArtifactAttestation("page_evidence", offer?.listing_evidence)) {
      throw coded("Signed candidate offers contain an invalid or duplicate exact offer", "shopping_candidate_offers_invalid");
    }
    byId.set(candidateId, offer);
  }
  if (!byId.size) throw coded("Signed candidate offers contain no exact offers", "shopping_candidate_offers_invalid");

  const subjectId = String(subject?.offer_id || decision_context?.offer_id || "");
  if (offerPhase && (!subjectId || !byId.has(subjectId))) {
    throw coded("Evaluator subject is not present in the signed exact-offer artifact", "shopping_candidate_offer_subject_mismatch");
  }

  const collectionName = EVIDENCE_COLLECTION[stage];
  const items = collectionName ? input?.[collectionName] : null;
  if (collectionName) {
    if (!Array.isArray(items) || !items.length) {
      throw coded(`Evaluator stage ${stage} must consume at least one signed exact offer`, "shopping_candidate_offer_binding_missing");
    }
    const seen = new Set();
    for (const item of items) {
      const itemId = String(item?.id || "");
      const authoritative = byId.get(itemId);
      if (!authoritative) throw coded(`Evaluator input offer ${itemId || "unknown"} is outside the signed shortlist`, "shopping_candidate_offer_id_mismatch");
      if (seen.has(itemId)) throw coded(`Evaluator input repeats exact offer ${itemId}`, "shopping_candidate_offer_id_duplicate");
      seen.add(itemId);
      if (!exactEvidence(item?.listing_evidence, authoritative.listing_evidence)) {
        throw coded(`Evaluator input substituted listing evidence for ${itemId}`, "shopping_candidate_offer_evidence_mismatch");
      }
    }
    if (subjectId && !seen.has(subjectId)) {
      throw coded("Evaluator input omits its signed exact-offer subject", "shopping_candidate_offer_subject_omitted");
    }
    return [...seen];
  }

  if (stage === "promotion") {
    const itemId = String(input?.offer_id || "");
    const authoritative = byId.get(itemId);
    if (!authoritative || (subjectId && itemId !== subjectId)) {
      throw coded("Promotion input does not match its signed exact-offer subject", "shopping_candidate_offer_id_mismatch");
    }
    if (!exactEvidence(input?.listing_evidence, authoritative.listing_evidence)) {
      throw coded(`Promotion input substituted listing evidence for ${itemId}`, "shopping_candidate_offer_evidence_mismatch");
    }
    return [itemId];
  }

  return [];
}

