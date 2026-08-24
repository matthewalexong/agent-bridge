import test from "node:test";
import assert from "node:assert/strict";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { createShoppingCandidateOffersRegistry } from "../lib/shopping-candidate-offers-registry.mjs";

const NOW = Date.parse("2026-08-24T20:00:00.000Z");

function artifact(candidateId = "listing_aaaaaaaaaaaaaaaa", setId = "cset_bbbbbbbbbbbbbbbbbbbbbbbb", evaluatedAt = NOW) {
  const listing_evidence = attestShoppingArtifact("page_evidence", {
    source: { url: `https://shop.example/${candidateId}`, page_kind: "retailer_listing", captured_at: new Date(evaluatedAt).toISOString() },
    facts: { price_usd: { value: 99, status: "explicit" } },
  });
  return attestShoppingArtifact("candidate_offers", {
    candidate_set_id: setId,
    evaluated_at: new Date(evaluatedAt).toISOString(),
    offers: [{ candidate_id: candidateId, listing_evidence }],
  });
}

test("candidate-offers registry resolves a compact reference to exact signed evidence", () => {
  const registry = createShoppingCandidateOffersRegistry({ now: () => NOW });
  const signed = artifact();
  const reference = registry.store(signed);
  assert.match(reference.candidate_offers_id, /^candidate_offers_[a-f0-9]{32}$/);
  assert.deepEqual(reference.candidate_ids, ["listing_aaaaaaaaaaaaaaaa"]);
  assert.deepEqual(registry.resolve(reference), signed);
  assert.ok(JSON.stringify(reference).length * 3 < JSON.stringify(signed).length);
});

test("candidate-offers registry rejects altered, expired, and invalid authority", () => {
  let clock = NOW;
  const registry = createShoppingCandidateOffersRegistry({ max_age_ms: 10_000, now: () => clock });
  const signed = artifact();
  const reference = registry.store(signed);
  assert.throws(() => registry.resolve({ ...reference, candidate_ids: ["listing_cccccccccccccccc"] }), { code: "shopping_candidate_offers_reference_mismatch" });
  const tampered = structuredClone(signed);
  tampered.offers[0].listing_evidence.facts.price_usd.value = 1;
  assert.throws(() => registry.store(tampered), { code: "shopping_candidate_offers_reference_invalid" });
  clock += 10_001;
  assert.throws(() => registry.resolve(reference), { code: "shopping_candidate_offers_reference_expired" });
});

test("candidate-offers registry is bounded and unknown after eviction", () => {
  const registry = createShoppingCandidateOffersRegistry({ max_entries: 1, now: () => NOW });
  const first = registry.store(artifact());
  const second = registry.store(artifact("listing_cccccccccccccccc", "cset_dddddddddddddddddddddddd"));
  assert.throws(() => registry.resolve(first), { code: "shopping_candidate_offers_reference_unknown" });
  assert.equal(registry.resolve(second).candidate_set_id, "cset_dddddddddddddddddddddddd");
});
