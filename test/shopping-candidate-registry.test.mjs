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

test("candidate registry reconstructs exact cards in requested order", () => {
  const registry = createShoppingCandidateRegistry();
  const set = artifact({ candidates: [
    { id: "listing_bbbbbbbbbbbbbbbb", title: "Observed Fan", url: "https://shop.example/products/fan", price: { display: "$49.99", amount_usd: 49.99 } },
    { id: "listing_cccccccccccccccc", title: "Observed Fan Pro", url: "https://shop.example/products/fan-pro", image: "https://shop.example/pro.jpg", price: null },
  ] });
  registry.store(set);
  assert.deepEqual(registry.cards(set.candidate_set_id, ["listing_cccccccccccccccc", "listing_bbbbbbbbbbbbbbbb"]), [
    { url: "https://shop.example/products/fan-pro", title: "Observed Fan Pro", image: "https://shop.example/pro.jpg" },
    { url: "https://shop.example/products/fan", title: "Observed Fan", price: "$49.99" },
  ]);
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
  assert.equal(registry.cards(fused.candidate_set_id, ["listing_bbbbbbbbbbbbbbbb"])[0].url, "https://shop.example/products/fan");
});
