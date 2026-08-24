import crypto from "node:crypto";
import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function candidateId(dossier) {
  if (dossier?.phase === "product_recommendation" && dossier?.decision?.action === "recommend_product") return dossier.decision.selected_product;
  if (dossier?.phase === "offer_recommendation" && dossier?.decision?.action === "recommend_offer") return dossier.decision.selected_offer;
  return null;
}

function eligible(dossier) {
  const decision = dossier?.decision || {};
  const candidate_id = candidateId(dossier);
  return /^listing_[a-f0-9]{16}$/.test(String(candidate_id || ""))
    && typeof dossier?.dossier_id === "string"
    && [decision.blockers, decision.research, decision.clarifications].every((items) => Array.isArray(items) && items.length === 0)
    && decision.purchase_allowed === false
    && decision.model_override_allowed === false;
}

export function createShoppingRecommendationRegistry({ max_entries = 128, max_age_ms = 15 * 60 * 1_000, now = () => Date.now() } = {}) {
  if (!Number.isInteger(max_entries) || max_entries < 1 || max_entries > 1_024 || !Number.isInteger(max_age_ms) || max_age_ms < 10_000 || max_age_ms > 3_600_000) {
    throw coded("Recommendation registry bounds are invalid", "shopping_recommendation_registry_invalid");
  }
  const entries = new Map();
  const contexts = new Map();

  function bindCandidateOffers(context_id, artifact) {
    const contextId = String(context_id || "");
    const offers = artifact?.offers;
    const current = now();
    const evaluatedAt = Date.parse(artifact?.evaluated_at || "");
    if (!contextId || !verifyShoppingArtifactAttestation("candidate_offers", artifact)
      || !/^cset_[a-f0-9]{24}$/.test(String(artifact?.candidate_set_id || ""))
      || !Array.isArray(offers) || offers.length < 1 || offers.length > 5
      || new Set(offers.map((offer) => offer?.candidate_id)).size !== offers.length
      || offers.some((offer) => !/^listing_[a-f0-9]{16}$/.test(String(offer?.candidate_id || ""))
        || !verifyShoppingArtifactAttestation("page_evidence", offer?.listing_evidence))
      || !Number.isFinite(evaluatedAt) || evaluatedAt > current + 300_000 || current - evaluatedAt > max_age_ms) {
      throw coded("Recommendation evidence requires fresh signed exact candidate offers", "shopping_recommendation_offer_binding_invalid");
    }
    const prior = contexts.get(contextId);
    if (prior && prior.artifact_attestation !== artifact.artifact_attestation) {
      throw coded("A decision context cannot mix different exact candidate-offer evidence", "shopping_recommendation_offer_binding_conflict");
    }
    const binding = {
      stored_at: current,
      artifact_attestation: artifact.artifact_attestation,
      candidate_set_id: artifact.candidate_set_id,
      offers: new Map(offers.map((offer) => [offer.candidate_id, offer.listing_evidence.artifact_attestation])),
    };
    contexts.delete(contextId);
    contexts.set(contextId, binding);
    while (contexts.size > max_entries) contexts.delete(contexts.keys().next().value);
    return true;
  }

  function store(dossier) {
    if (!eligible(dossier)) return null;
    const evaluatedAt = Date.parse(dossier.evaluated_at || "");
    const current = now();
    if (!Number.isFinite(evaluatedAt) || evaluatedAt > current + 300_000 || current - evaluatedAt > max_age_ms) return null;
    const candidate_id = candidateId(dossier);
    const context = contexts.get(String(dossier?.decision_context_id || ""));
    const evidence_attestation = context?.offers.get(candidate_id);
    if (!context || current - context.stored_at > max_age_ms || !evidence_attestation) return null;
    const recommendation_id = `shopping_recommendation_${crypto.randomBytes(16).toString("hex")}`;
    const reference = { recommendation_id, dossier_id: dossier.dossier_id, phase: dossier.phase, candidate_id };
    entries.set(recommendation_id, { issued_at: current, reference, binding: {
      candidate_set_id: context.candidate_set_id,
      candidate_id,
      evidence_attestation,
      candidate_offers_attestation: context.artifact_attestation,
    } });
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return structuredClone(reference);
  }

  function authorize(reference, candidate_id, card_binding) {
    const entry = entries.get(String(reference?.recommendation_id || ""));
    if (!entry) throw coded("Recommendation reference is unknown in this process; rerun final dossier composition", "shopping_recommendation_reference_unknown");
    if (JSON.stringify(reference) !== JSON.stringify(entry.reference) || candidate_id !== entry.reference.candidate_id) {
      throw coded("Recommendation reference is altered or selects a different candidate", "shopping_recommendation_reference_mismatch");
    }
    if (JSON.stringify(card_binding) !== JSON.stringify(entry.binding)) {
      throw coded("Verified card evidence differs from the final dossier evidence", "shopping_recommendation_card_evidence_mismatch");
    }
    if (now() - entry.issued_at > max_age_ms) {
      entries.delete(entry.reference.recommendation_id);
      throw coded("Recommendation reference expired; refresh final evidence and dossier", "shopping_recommendation_reference_expired");
    }
    entries.delete(entry.reference.recommendation_id);
    entries.set(entry.reference.recommendation_id, entry);
    return true;
  }

  return { bindCandidateOffers, store, authorize };
}
