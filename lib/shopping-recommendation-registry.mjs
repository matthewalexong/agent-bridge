import crypto from "node:crypto";

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

  function store(dossier) {
    if (!eligible(dossier)) return null;
    const evaluatedAt = Date.parse(dossier.evaluated_at || "");
    const current = now();
    if (!Number.isFinite(evaluatedAt) || evaluatedAt > current + 300_000 || current - evaluatedAt > max_age_ms) return null;
    const candidate_id = candidateId(dossier);
    const recommendation_id = `shopping_recommendation_${crypto.randomBytes(16).toString("hex")}`;
    const reference = { recommendation_id, dossier_id: dossier.dossier_id, phase: dossier.phase, candidate_id };
    entries.set(recommendation_id, { issued_at: current, reference });
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return structuredClone(reference);
  }

  function authorize(reference, candidate_id) {
    const entry = entries.get(String(reference?.recommendation_id || ""));
    if (!entry) throw coded("Recommendation reference is unknown in this process; rerun final dossier composition", "shopping_recommendation_reference_unknown");
    if (JSON.stringify(reference) !== JSON.stringify(entry.reference) || candidate_id !== entry.reference.candidate_id) {
      throw coded("Recommendation reference is altered or selects a different candidate", "shopping_recommendation_reference_mismatch");
    }
    if (now() - entry.issued_at > max_age_ms) {
      entries.delete(entry.reference.recommendation_id);
      throw coded("Recommendation reference expired; refresh final evidence and dossier", "shopping_recommendation_reference_expired");
    }
    entries.delete(entry.reference.recommendation_id);
    entries.set(entry.reference.recommendation_id, entry);
    return true;
  }

  return { store, authorize };
}
