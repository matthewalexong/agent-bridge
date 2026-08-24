import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const EVIDENCE_COLLECTION = Object.freeze({
  identity: "candidates",
  safety: "candidates",
  merchant: "candidates",
  counterfeit: "offers",
  protection: "candidates",
  fulfillment: "offers",
});

const REQUIRED_BOUND_STAGES = new Set([
  ...Object.keys(EVIDENCE_COLLECTION),
  "condition", "promotion", "offer", "deal", "checkout", "checkout_consent",
]);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function exactEvidence(left, right) {
  return verifyShoppingArtifactAttestation("page_evidence", left)
    && left.artifact_attestation === right?.artifact_attestation;
}

function authoritativeOfferMap(candidateOffers) {
  if (!verifyShoppingArtifactAttestation("candidate_offers", candidateOffers)) {
    throw coded("Evaluator offer binding requires an intact signed candidate-offers artifact", "shopping_candidate_offers_invalid");
  }
  const offers = Array.isArray(candidateOffers.offers) ? candidateOffers.offers : [];
  const byId = new Map();
  for (const offer of offers) {
    const candidateId = String(offer?.candidate_id || "");
    if (!candidateId || byId.has(candidateId) || !verifyShoppingArtifactAttestation("page_evidence", offer?.listing_evidence)) {
      throw coded("Signed candidate offers contain an invalid or duplicate exact offer", "shopping_candidate_offers_invalid");
    }
    byId.set(candidateId, offer);
  }
  if (!byId.size) throw coded("Signed candidate offers contain no exact offers", "shopping_candidate_offers_invalid");
  return byId;
}

function requireBoundId({ byId, itemId, subjectId, label }) {
  const normalized = String(itemId || "");
  if (!normalized || !byId.has(normalized) || (subjectId && normalized !== subjectId)) {
    throw coded(`${label} does not match its signed exact-offer subject`, "shopping_candidate_offer_id_mismatch");
  }
  return normalized;
}

export function projectShoppingEvaluatorOfferInput({ candidate_offers, stage, input }) {
  if (!candidate_offers) return input;
  const byId = authoritativeOfferMap(candidate_offers);
  const projected = structuredClone(input || {});
  const collectionName = EVIDENCE_COLLECTION[stage];
  if (collectionName && Array.isArray(projected[collectionName])) {
    for (const item of projected[collectionName]) {
      if (item?.listing_evidence != null) continue;
      const itemId = String(item?.id || "");
      const authoritative = byId.get(itemId);
      if (!authoritative) throw coded(`Evaluator input offer ${itemId || "unknown"} is outside the signed shortlist`, "shopping_candidate_offer_id_mismatch");
      item.listing_evidence = structuredClone(authoritative.listing_evidence);
    }
  } else if (stage === "promotion" && projected.listing_evidence == null) {
    const itemId = String(projected.offer_id || "");
    const authoritative = byId.get(itemId);
    if (!authoritative) throw coded(`Promotion input offer ${itemId || "unknown"} is outside the signed shortlist`, "shopping_candidate_offer_id_mismatch");
    projected.listing_evidence = structuredClone(authoritative.listing_evidence);
  }
  return projected;
}

export function validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context, stage, subject, input }) {
  const offerPhase = decision_context?.phase === "offer_recommendation" || decision_context?.phase === "checkout_review";
  if (!candidate_offers) {
    if (offerPhase && REQUIRED_BOUND_STAGES.has(stage)) {
      throw coded(`Evaluator stage ${stage} requires the signed exact-offer artifact`, "shopping_candidate_offers_required");
    }
    return [];
  }
  const byId = authoritativeOfferMap(candidate_offers);

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
    const itemId = requireBoundId({ byId, itemId: input?.offer_id, subjectId, label: "Promotion input" });
    const authoritative = byId.get(itemId);
    if (!exactEvidence(input?.listing_evidence, authoritative.listing_evidence)) {
      throw coded(`Promotion input substituted listing evidence for ${itemId}`, "shopping_candidate_offer_evidence_mismatch");
    }
    return [itemId];
  }

  if (stage === "condition") {
    return [requireBoundId({ byId, itemId: input?.offer?.id, subjectId, label: "Condition input" })];
  }

  if (stage === "deal") {
    return [requireBoundId({ byId, itemId: input?.current?.offer_id, subjectId, label: "Deal input" })];
  }

  if (stage === "offer") {
    const items = input?.offers;
    if (!Array.isArray(items) || !items.length) {
      throw coded("Offer analysis must consume at least one signed exact offer", "shopping_candidate_offer_binding_missing");
    }
    const seen = new Set();
    for (const item of items) {
      const itemId = String(item?.id || "");
      if (!itemId || !byId.has(itemId)) throw coded(`Offer analysis input ${itemId || "unknown"} is outside the signed shortlist`, "shopping_candidate_offer_id_mismatch");
      if (seen.has(itemId)) throw coded(`Offer analysis repeats exact offer ${itemId}`, "shopping_candidate_offer_id_duplicate");
      seen.add(itemId);
    }
    if (subjectId && !seen.has(subjectId)) throw coded("Offer analysis omits its signed exact-offer subject", "shopping_candidate_offer_subject_omitted");
    return [...seen];
  }

  if (stage === "checkout") {
    const itemId = requireBoundId({ byId, itemId: input?.expected?.offer_id, subjectId, label: "Checkout expectation" });
    if (!Array.isArray(input?.cart?.items) || !input.cart.items.some((item) => String(item?.id || "") === itemId)) {
      throw coded("Checkout cart omits its signed exact-offer subject", "shopping_candidate_offer_subject_omitted");
    }
    return [itemId];
  }

  if (stage === "checkout_consent") {
    const termsId = requireBoundId({ byId, itemId: input?.terms_evidence?.offer_id, subjectId, label: "Checkout terms" });
    const patternId = requireBoundId({ byId, itemId: input?.pattern_evidence?.offer_id, subjectId, label: "Checkout pattern" });
    if (termsId !== patternId) throw coded("Checkout consent mixed different exact offers", "shopping_candidate_offer_id_mismatch");
    return [termsId];
  }

  return [];
}
