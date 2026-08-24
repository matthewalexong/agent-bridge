import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { shoppingListingUrlKey } from "./shopping-listing-candidates.mjs";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

export function bindShoppingCandidateOffers({ candidate_set, bindings, evaluated_at = new Date().toISOString() } = {}) {
  if (!verifyShoppingArtifactAttestation("listing_candidates", candidate_set)) {
    throw coded("Candidate offer binding requires a signed candidate set", "shopping_candidate_set_invalid");
  }
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 5) {
    throw coded("Hydrate 1-5 shortlisted candidates at a time", "shopping_candidate_binding_invalid");
  }
  const byId = new Map((candidate_set.candidates || []).map((candidate) => [candidate.id, candidate]));
  const seen = new Set();
  const offers = bindings.map((binding) => {
    const candidateId = String(binding?.candidate_id || "");
    if (seen.has(candidateId)) throw coded("Each candidate can be hydrated once", "shopping_candidate_binding_invalid");
    seen.add(candidateId);
    const candidate = byId.get(candidateId);
    if (!candidate) throw coded(`Candidate ${candidateId} is not in the signed set`, "shopping_candidate_not_found");
    const evidence = binding.listing_evidence;
    if (!verifyShoppingArtifactAttestation("page_evidence", evidence) || evidence?.source?.page_kind !== "retailer_listing") {
      throw coded("Candidate hydration requires signed retailer listing evidence", "shopping_candidate_evidence_invalid");
    }
    const candidateKey = shoppingListingUrlKey(candidate.url);
    const observedKey = shoppingListingUrlKey(evidence.source.url);
    if (!candidateKey || candidateKey !== observedKey) {
      throw coded(`Observed product page does not match candidate ${candidateId}`, "shopping_candidate_snapshot_mismatch");
    }
    return {
      candidate_id: candidateId,
      candidate: {
        title: candidate.title,
        url: candidate.url,
        image: candidate.image || null,
        observed_search_price: candidate.price || null,
      },
      listing_evidence: evidence,
      url_binding: { candidate_key: candidateKey, observed_key: observedKey, status: "exact_listing" },
    };
  });
  return attestShoppingArtifact("candidate_offers", {
    candidate_set_id: candidate_set.candidate_set_id,
    evaluated_at,
    offers,
    all_requested_candidates_hydrated: offers.length === bindings.length,
    selects_product: false,
    selects_offer: false,
    purchase_allowed: false,
  });
}
