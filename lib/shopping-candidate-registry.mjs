import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

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

export function createShoppingCandidateRegistry({ max_entries = 100, max_age_ms = 5 * 60 * 1_000, now = () => Date.now() } = {}) {
  const sets = new Map();

  function store(artifact) {
    if (!verifyShoppingArtifactAttestation("listing_candidates", artifact) ||
        !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt) ||
        !/^cset_[a-f0-9]{24}$/.test(String(artifact?.candidate_set_id || "")) ||
        !validCandidates(artifact?.candidates)) {
      throw coded("Candidate set is not process-attested", "shopping_candidate_set_invalid");
    }
    const candidates = Array.isArray(artifact.candidates) ? structuredClone(artifact.candidates) : [];
    sets.set(artifact.candidate_set_id, { stored_at: now(), candidates });
    while (sets.size > max_entries) sets.delete(sets.keys().next().value);
    return artifact.candidate_set_id;
  }

  function cards(candidate_set_id, candidate_ids) {
    if (!/^cset_[a-f0-9]{24}$/.test(String(candidate_set_id || ""))) {
      throw coded("Candidate set ID is invalid", "shopping_candidate_set_invalid");
    }
    const entry = sets.get(candidate_set_id);
    if (!entry) throw coded("Candidate set is unavailable; take a fresh snapshot", "shopping_candidate_set_not_found");
    if (now() - entry.stored_at > max_age_ms) {
      sets.delete(candidate_set_id);
      throw coded("Candidate set expired; take a fresh snapshot", "shopping_candidate_set_stale");
    }
    if (!Array.isArray(candidate_ids) || candidate_ids.length < 1 || candidate_ids.length > 5 || new Set(candidate_ids).size !== candidate_ids.length) {
      throw coded("Choose 1-5 unique candidate IDs", "shopping_candidate_selection_invalid");
    }
    const byId = new Map(entry.candidates.map((candidate) => [candidate.id, candidate]));
    return candidate_ids.map((id) => {
      const candidate = byId.get(id);
      if (!candidate) throw coded(`Candidate ${id} is not in ${candidate_set_id}`, "shopping_candidate_not_found");
      return {
        url: candidate.url,
        title: candidate.title,
        ...(candidate.image ? { image: candidate.image } : {}),
        ...(candidate.price?.display ? { price: candidate.price.display } : {}),
      };
    });
  }

  function clear() {
    sets.clear();
  }

  return { store, cards, clear, size: () => sets.size };
}
