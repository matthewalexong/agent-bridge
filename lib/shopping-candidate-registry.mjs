import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { shoppingListingUrlKey } from "./shopping-listing-candidates.mjs";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length > 40) return false;
  const ids = new Set();
  for (const candidate of candidates) {
    if (!/^listing_[a-f0-9]{16}$/.test(String(candidate?.id || "")) || ids.has(candidate.id)) return false;
    ids.add(candidate.id);
    if (typeof candidate.title !== "string" || !candidate.title.trim() || candidate.title.length > 200) return false;
    if (!httpUrl(candidate.url) || (candidate.image != null && !httpUrl(candidate.image))) return false;
    if (candidate.price?.display != null && (typeof candidate.price.display !== "string" || candidate.price.display.length > 40)) return false;
  }
  return true;
}

function exactPrice(listingEvidence) {
  const fact = listingEvidence?.facts?.price_usd;
  if (!fact || !["explicit", "derived"].includes(fact.status) || !Number.isFinite(fact.value) || fact.value < 0) return null;
  return { display: `$${Number(fact.value).toFixed(2)}`, amount_usd: Number(fact.value) };
}

function exactSeller(listingEvidence) {
  const fact = listingEvidence?.facts?.seller;
  return fact && ["explicit", "derived"].includes(fact.status) && typeof fact.value === "string" && fact.value.trim()
    ? fact.value.trim().slice(0, 120)
    : null;
}

function exactAvailability(listingEvidence) {
  const fact = listingEvidence?.facts?.stock;
  if (!fact || !["explicit", "derived"].includes(fact.status)) return "Availability unknown";
  if (fact.value === "in_stock") return "In stock";
  if (fact.value === "out_of_stock") return "Out of stock";
  return "Availability unknown";
}

export function createShoppingCandidateRegistry({ max_entries = 100, max_age_ms = 5 * 60 * 1_000, now = () => Date.now() } = {}) {
  const sets = new Map();

  function store(artifact) {
    const receipts = Array.isArray(artifact?.source_receipts) ? artifact.source_receipts : [artifact?.source_receipt];
    if (!verifyShoppingArtifactAttestation("listing_candidates", artifact) ||
        receipts.length < 1 || receipts.length > 8 || !receipts.every((receipt) => verifyShoppingArtifactAttestation("browser_snapshot", receipt)) ||
        !/^cset_[a-f0-9]{24}$/.test(String(artifact?.candidate_set_id || "")) ||
        !validCandidates(artifact?.candidates)) {
      throw coded("Candidate set is not process-attested", "shopping_candidate_set_invalid");
    }
    const storedArtifact = structuredClone(artifact);
    sets.set(artifact.candidate_set_id, { stored_at: now(), artifact: storedArtifact, hydrated: new Map() });
    while (sets.size > max_entries) sets.delete(sets.keys().next().value);
    return artifact.candidate_set_id;
  }

  function hydrate(candidateOffers) {
    if (!verifyShoppingArtifactAttestation("candidate_offers", candidateOffers)) {
      throw coded("Candidate offers are not process-attested", "shopping_candidate_offers_invalid");
    }
    const artifact = resolve(candidateOffers.candidate_set_id);
    const entry = sets.get(candidateOffers.candidate_set_id);
    const byId = new Map(artifact.candidates.map((candidate) => [candidate.id, candidate]));
    const hydrated = new Map(entry.hydrated);
    const offers = candidateOffers.offers || [];
    if (!Array.isArray(offers) || offers.length < 1 || offers.length > 5 || new Set(offers.map((offer) => offer?.candidate_id)).size !== offers.length) {
      throw coded("Candidate offers contain an invalid exact-page selection", "shopping_candidate_offers_invalid");
    }
    for (const offer of offers) {
      const candidate = byId.get(offer?.candidate_id);
      const candidateKey = shoppingListingUrlKey(candidate?.url);
      const evidenceKey = shoppingListingUrlKey(offer?.listing_evidence?.source?.url);
      if (!candidate || offer?.candidate?.url !== candidate.url || offer?.candidate?.title !== candidate.title ||
          !candidateKey || candidateKey !== evidenceKey || offer?.url_binding?.status !== "exact_listing" ||
          offer.url_binding.candidate_key !== candidateKey || offer.url_binding.observed_key !== evidenceKey ||
          !verifyShoppingArtifactAttestation("page_evidence", offer?.listing_evidence) || offer.listing_evidence?.source?.page_kind !== "retailer_listing") {
        throw coded("Candidate offer does not match its registered signed candidate", "shopping_candidate_offer_registry_mismatch");
      }
      hydrated.set(candidate.id, {
        price: exactPrice(offer.listing_evidence),
        seller: exactSeller(offer.listing_evidence),
        availability: exactAvailability(offer.listing_evidence),
        evidence_attestation: offer.listing_evidence.artifact_attestation,
        candidate_offers_attestation: candidateOffers.artifact_attestation,
      });
    }
    entry.hydrated = hydrated;
    return candidateOffers.candidate_set_id;
  }

  function resolve(candidate_set_id) {
    if (!/^cset_[a-f0-9]{24}$/.test(String(candidate_set_id || ""))) {
      throw coded("Candidate set ID is invalid", "shopping_candidate_set_invalid");
    }
    const entry = sets.get(candidate_set_id);
    if (!entry) throw coded("Candidate set is unavailable; take fresh search snapshots", "shopping_candidate_set_not_found");
    if (now() - entry.stored_at > max_age_ms) {
      sets.delete(candidate_set_id);
      throw coded("Candidate set expired; take fresh search snapshots", "shopping_candidate_set_stale");
    }
    return structuredClone(entry.artifact);
  }

  function cards(candidate_set_id, candidate_ids) {
    const artifact = resolve(candidate_set_id);
    if (!Array.isArray(candidate_ids) || candidate_ids.length < 1 || candidate_ids.length > 5 || new Set(candidate_ids).size !== candidate_ids.length) {
      throw coded("Choose 1-5 unique candidate IDs", "shopping_candidate_selection_invalid");
    }
    const byId = new Map(artifact.candidates.map((candidate) => [candidate.id, candidate]));
    return candidate_ids.map((id) => {
      const candidate = byId.get(id);
      if (!candidate) throw coded(`Candidate ${id} is not in ${candidate_set_id}`, "shopping_candidate_not_found");
      const exact = sets.get(candidate_set_id).hydrated.get(id);
      if (!exact) throw coded(`Candidate ${id} has not been verified on its exact product page`, "shopping_candidate_not_hydrated");
      return {
        url: candidate.url,
        title: candidate.title,
        ...(candidate.image ? { image: candidate.image } : {}),
        ...(exact.price?.display ? { price: exact.price.display, price_label: "Item price" } : {}),
        ...(exact.seller ? { seller: exact.seller } : {}),
        availability: exact.availability,
      };
    });
  }

  function binding(candidate_set_id, candidate_id) {
    const artifact = resolve(candidate_set_id);
    if (!artifact.candidates.some((candidate) => candidate.id === candidate_id)) {
      throw coded(`Candidate ${candidate_id} is not in ${candidate_set_id}`, "shopping_candidate_not_found");
    }
    const exact = sets.get(candidate_set_id).hydrated.get(candidate_id);
    if (!exact) throw coded(`Candidate ${candidate_id} has not been verified on its exact product page`, "shopping_candidate_not_hydrated");
    return {
      candidate_set_id,
      candidate_id,
      evidence_attestation: exact.evidence_attestation,
      candidate_offers_attestation: exact.candidate_offers_attestation,
    };
  }

  function clear() {
    sets.clear();
  }

  return { store, hydrate, resolve, cards, binding, clear, size: () => sets.size };
}
