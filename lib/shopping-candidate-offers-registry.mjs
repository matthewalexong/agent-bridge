import crypto from "node:crypto";
import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function referenceFor(artifact) {
  const digest = crypto.createHash("sha256").update(String(artifact.artifact_attestation)).digest("hex").slice(0, 32);
  return {
    candidate_offers_id: `candidate_offers_${digest}`,
    candidate_set_id: artifact.candidate_set_id,
    candidate_ids: artifact.offers.map((offer) => offer.candidate_id),
  };
}

function validArtifact(artifact) {
  const offers = artifact?.offers;
  return verifyShoppingArtifactAttestation("candidate_offers", artifact)
    && /^cset_[a-f0-9]{24}$/.test(String(artifact?.candidate_set_id || ""))
    && Array.isArray(offers) && offers.length >= 1 && offers.length <= 5
    && new Set(offers.map((offer) => offer?.candidate_id)).size === offers.length
    && offers.every((offer) => typeof offer?.candidate_id === "string" && offer.candidate_id.length > 0
      && verifyShoppingArtifactAttestation("page_evidence", offer?.listing_evidence)
      && offer.listing_evidence?.source?.page_kind === "retailer_listing");
}

export function createShoppingCandidateOffersRegistry({ max_entries = 128, max_age_ms = 5 * 60 * 1_000, now = () => Date.now() } = {}) {
  if (!Number.isInteger(max_entries) || max_entries < 1 || max_entries > 1_024 || !Number.isInteger(max_age_ms) || max_age_ms < 10_000 || max_age_ms > 3_600_000) {
    throw coded("Candidate-offers registry bounds are invalid", "shopping_candidate_offers_registry_invalid");
  }
  const entries = new Map();

  function store(artifact) {
    if (!validArtifact(artifact)) throw coded("Candidate offers are not valid process-attested exact-page evidence", "shopping_candidate_offers_reference_invalid");
    const evaluatedAt = Date.parse(artifact.evaluated_at || "");
    const current = now();
    if (!Number.isFinite(evaluatedAt) || evaluatedAt > current + 300_000 || current - evaluatedAt > max_age_ms) {
      throw coded("Candidate offers are stale or future-dated", "shopping_candidate_offers_reference_expired");
    }
    const ref = referenceFor(artifact);
    entries.delete(ref.candidate_offers_id);
    entries.set(ref.candidate_offers_id, { stored_at: current, artifact: structuredClone(artifact) });
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return ref;
  }

  function resolve(ref) {
    const entry = entries.get(String(ref?.candidate_offers_id || ""));
    if (!entry) throw coded("Candidate-offers reference is unknown in this process; rehydrate the exact product pages", "shopping_candidate_offers_reference_unknown");
    const expected = referenceFor(entry.artifact);
    if (ref.candidate_set_id !== expected.candidate_set_id || JSON.stringify(ref.candidate_ids) !== JSON.stringify(expected.candidate_ids)) {
      throw coded("Candidate-offers reference is altered or scope-mismatched", "shopping_candidate_offers_reference_mismatch");
    }
    const current = now();
    const evaluatedAt = Date.parse(entry.artifact.evaluated_at || "");
    if (current - entry.stored_at > max_age_ms || current - evaluatedAt > max_age_ms || evaluatedAt > current + 300_000 || !validArtifact(entry.artifact)) {
      entries.delete(expected.candidate_offers_id);
      throw coded("Candidate-offers reference is expired or invalid", "shopping_candidate_offers_reference_expired");
    }
    entries.delete(expected.candidate_offers_id);
    entries.set(expected.candidate_offers_id, entry);
    return structuredClone(entry.artifact);
  }

  return { store, resolve };
}
