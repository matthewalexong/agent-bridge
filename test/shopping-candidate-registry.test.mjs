import assert from "node:assert/strict";
import test from "node:test";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { createShoppingCandidateRegistry } from "../lib/shopping-candidate-registry.mjs";

function artifact(overrides = {}) {
  const sourceReceipt = attestShoppingArtifact("browser_snapshot", {
    source_id: "snapshot-1",
    snapshot_id: "snapshot-1",
    tab_id: 1,
    url: "https://shop.example/search",
    captured_at: "2026-08-24T20:00:00.000Z",
    truncated: false,
    content_sha256: "a".repeat(64),
    elements_sha256: "b".repeat(64),
  });
  return attestShoppingArtifact("listing_candidates", {
    candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa",
    source_receipt: sourceReceipt,
    candidates: [{
      id: "listing_bbbbbbbbbbbbbbbb",
      title: "Observed Fan",
      url: "https://shop.example/products/fan",
      image: "https://shop.example/images/fan.jpg",
      price: { display: "$49.99", amount_usd: 49.99 },
    }],
    ...overrides,
  });
}

function hydratedArtifact(set, candidateId, priceFact = { value: 44, status: "explicit" }, extraFacts = {}) {
  const candidate = set.candidates.find((item) => item.id === candidateId);
  const listingEvidence = attestShoppingArtifact("page_evidence", {
    source: { url: candidate.url, page_kind: "retailer_listing", captured_at: "2026-08-24T20:00:01.000Z" },
    facts: { price_usd: priceFact, ...extraFacts },
  });
  return attestShoppingArtifact("candidate_offers", {
    candidate_set_id: set.candidate_set_id,
    evaluated_at: "2026-08-24T20:00:01.000Z",
    offers: [{ candidate_id: candidate.id, candidate: { title: candidate.title, url: candidate.url, image: candidate.image || null, observed_search_price: candidate.price || null }, listing_evidence: listingEvidence, url_binding: { candidate_key: candidate.url, observed_key: candidate.url, status: "exact_listing" } }],
  });
}

test("candidate registry reconstructs exact cards in requested order", () => {
  const registry = createShoppingCandidateRegistry();
  const set = artifact({ candidates: [
    { id: "listing_bbbbbbbbbbbbbbbb", title: "Observed Fan", url: "https://shop.example/products/fan", price: { display: "$49.99", amount_usd: 49.99 } },
    { id: "listing_cccccccccccccccc", title: "Observed Fan Pro", url: "https://shop.example/products/fan-pro", image: "https://shop.example/pro.jpg", price: null },
  ] });
  registry.store(set);
  registry.hydrate(hydratedArtifact(set, "listing_cccccccccccccccc", { value: null, status: "unknown" }));
  registry.hydrate(hydratedArtifact(set, "listing_bbbbbbbbbbbbbbbb", { value: 44, status: "explicit" }));
  assert.deepEqual(registry.cards(set.candidate_set_id, ["listing_cccccccccccccccc", "listing_bbbbbbbbbbbbbbbb"]), [
    { url: "https://shop.example/products/fan-pro", title: "Observed Fan Pro", image: "https://shop.example/pro.jpg", availability: "Availability unknown" },
    { url: "https://shop.example/products/fan", title: "Observed Fan", price: "$44.00", price_label: "Item price", availability: "Availability unknown" },
  ]);
});

test("candidate registry refuses final cards until exact pages are hydrated", () => {
  const registry = createShoppingCandidateRegistry();
  const set = artifact();
  registry.store(set);
  assert.throws(() => registry.cards(set.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb"]), { code: "shopping_candidate_not_hydrated" });
  registry.hydrate(hydratedArtifact(set, "listing_bbbbbbbbbbbbbbbb"));
  assert.equal(registry.cards(set.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb"])[0].price, "$44.00");
});

test("candidate cards carry only signed exact-page seller and availability facts", () => {
  const registry = createShoppingCandidateRegistry();
  const set = artifact();
  registry.store(set);
  registry.hydrate(hydratedArtifact(set, "listing_bbbbbbbbbbbbbbbb", { value: 44, status: "explicit" }, {
    seller: { value: "Verified Fan Shop", status: "explicit" },
    stock: { value: "in_stock", status: "explicit" },
  }));
  assert.deepEqual(registry.cards(set.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb"])[0], {
    url: "https://shop.example/products/fan", title: "Observed Fan", image: "https://shop.example/images/fan.jpg",
    price: "$44.00", price_label: "Item price", seller: "Verified Fan Shop", availability: "In stock",
  });
});

test("candidate registry exposes the exact signed card binding and replaces it on rehydration", () => {
  const registry = createShoppingCandidateRegistry();
  const set = artifact();
  registry.store(set);
  const first = hydratedArtifact(set, "listing_bbbbbbbbbbbbbbbb", { value: 44, status: "explicit" });
  registry.hydrate(first);
  assert.deepEqual(registry.binding(set.candidate_set_id, "listing_bbbbbbbbbbbbbbbb"), {
    candidate_set_id: set.candidate_set_id,
    candidate_id: "listing_bbbbbbbbbbbbbbbb",
    evidence_attestation: first.offers[0].listing_evidence.artifact_attestation,
    candidate_offers_attestation: first.artifact_attestation,
  });
  const changed = hydratedArtifact(set, "listing_bbbbbbbbbbbbbbbb", { value: 39, status: "explicit" });
  registry.hydrate(changed);
  assert.notEqual(registry.binding(set.candidate_set_id, "listing_bbbbbbbbbbbbbbbb").candidate_offers_attestation, first.artifact_attestation);
  assert.equal(registry.cards(set.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb"])[0].price, "$39.00");
});

test("candidate cards expose out-of-stock while withholding unsupported seller text", () => {
  const registry = createShoppingCandidateRegistry();
  const set = artifact();
  registry.store(set);
  registry.hydrate(hydratedArtifact(set, "listing_bbbbbbbbbbbbbbbb", { value: 44, status: "explicit" }, {
    seller: { value: "Guessed Shop", status: "estimated" },
    stock: { value: "out_of_stock", status: "explicit" },
  }));
  const card = registry.cards(set.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb"])[0];
  assert.equal(card.seller, undefined);
  assert.equal(card.availability, "Out of stock");
});

test("candidate registry rejects tampering, unknown IDs, duplicates, and expiry", () => {
  let clock = 1_000;
  const registry = createShoppingCandidateRegistry({ max_age_ms: 500, now: () => clock });
  const set = artifact();
  registry.store(set);
  assert.throws(() => registry.cards(set.candidate_set_id, ["listing_0000000000000000"]), { code: "shopping_candidate_not_found" });
  assert.throws(() => registry.cards(set.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb", "listing_bbbbbbbbbbbbbbbb"]), { code: "shopping_candidate_selection_invalid" });
  const tampered = structuredClone(set);
  tampered.candidates[0].url = "https://attacker.example/products/fake";
  assert.throws(() => registry.store(tampered), { code: "shopping_candidate_set_invalid" });
  clock = 1_501;
  assert.throws(() => registry.cards(set.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb"]), { code: "shopping_candidate_set_stale" });
});

test("candidate registry validates nested browser authority and safe card URLs", () => {
  const registry = createShoppingCandidateRegistry();
  const invalidSource = artifact();
  invalidSource.source_receipt.url = "https://attacker.example";
  invalidSource.artifact_attestation = attestShoppingArtifact("listing_candidates", invalidSource).artifact_attestation;
  assert.throws(() => registry.store(invalidSource), { code: "shopping_candidate_set_invalid" });
  const unsafe = artifact({ candidates: [{ id: "listing_bbbbbbbbbbbbbbbb", title: "Unsafe", url: "javascript:alert(1)" }] });
  assert.throws(() => registry.store(unsafe), { code: "shopping_candidate_set_invalid" });
});

test("candidate hydration rejects tampering and cross-candidate registry substitution", () => {
  const registry = createShoppingCandidateRegistry();
  const set = artifact({ candidates: [
    { id: "listing_bbbbbbbbbbbbbbbb", title: "Observed Fan", url: "https://shop.example/products/fan", price: { display: "$49.99", amount_usd: 49.99 } },
    { id: "listing_cccccccccccccccc", title: "Observed Fan Pro", url: "https://shop.example/products/fan-pro", price: null },
  ] });
  registry.store(set);
  const crossed = hydratedArtifact(set, "listing_bbbbbbbbbbbbbbbb");
  crossed.offers[0].candidate.url = set.candidates[1].url;
  crossed.artifact_attestation = attestShoppingArtifact("candidate_offers", crossed).artifact_attestation;
  assert.throws(() => registry.hydrate(crossed), { code: "shopping_candidate_offer_registry_mismatch" });
  const tampered = hydratedArtifact(set, "listing_bbbbbbbbbbbbbbbb");
  tampered.offers[0].listing_evidence.facts.price_usd.value = 1;
  assert.throws(() => registry.hydrate(tampered), { code: "shopping_candidate_offers_invalid" });
});

test("candidate registry accepts a signed fused set with several browser receipts", () => {
  const registry = createShoppingCandidateRegistry();
  const first = artifact();
  const secondReceipt = attestShoppingArtifact("browser_snapshot", {
    source_id: "snapshot-2", snapshot_id: "snapshot-2", tab_id: 2, url: "https://other.example/search",
    captured_at: "2026-08-24T20:00:00.000Z", truncated: false, content_sha256: "c".repeat(64), elements_sha256: "d".repeat(64),
  });
  const fused = attestShoppingArtifact("listing_candidates", {
    candidate_set_id: "cset_cccccccccccccccccccccccc",
    source_receipts: [first.source_receipt, secondReceipt],
    candidates: first.candidates,
  });
  assert.equal(registry.store(fused), fused.candidate_set_id);
  registry.hydrate(hydratedArtifact(fused, "listing_bbbbbbbbbbbbbbbb"));
  assert.equal(registry.cards(fused.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb"])[0].url, "https://shop.example/products/fan");
});
