import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedListingCandidates } from "../lib/shopping-browser-evidence.mjs";
import { fuseShoppingCandidateSets } from "../lib/shopping-listing-candidates.mjs";
import { verifyShoppingArtifactAttestation } from "../lib/shopping-attestation.mjs";

const NOW = "2026-08-24T20:00:00.000Z";

function observedSnapshot(overrides = {}) {
  return {
    snapshotId: "snapshot-listings",
    title: "Search results",
    url: "https://www.amazon.com/s?k=quiet+fan",
    text: "Search results for quiet fan",
    truncated: false,
    elements: [
      { ref: "e1", role: "link", name: "Amazon Home", href: "https://www.amazon.com/", context: "Amazon Home" },
      { ref: "e2", role: "link", name: "Whisper Fan 20 dB", href: "https://www.amazon.com/Whisper-Fan/dp/B0ABCDEF12?tag=affiliate&qid=123", image: "https://images.example/fan.jpg?utm_source=search", context: "Whisper Fan 20 dB $49.99 Prime delivery" },
      { ref: "e3", role: "link", name: "Whisper Fan 20 dB duplicate", href: "https://www.amazon.com/Whisper-Fan/dp/B0ABCDEF12?ref=duplicate", context: "Whisper Fan $51.00" },
      { ref: "e4", role: "link", name: "Loud Blender", href: "https://www.amazon.com/Loud-Blender/dp/B0ZYXWV987", context: "Loud Blender $39.00" },
      { ref: "e5", role: "button", name: "Add to cart", href: "https://www.amazon.com/Whisper-Fan/dp/B0ABCDEF12", context: "$49.99" },
      { ref: "e6", role: "link", name: "Unsafe", href: "javascript:alert(1)", context: "$1.00" },
      { ref: "e7", role: "link", name: "Privacy policy", href: "https://www.amazon.com/p/privacy", context: "Privacy policy" },
    ],
    ...overrides,
  };
}

test("signed browser observations become bounded exact listing candidates", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 9, snapshot: observedSnapshot(), captured_at: NOW });
  const result = extractBrowserObservedListingCandidates(registry.resolve, {
    snapshot_id: "snapshot-listings",
    evaluated_at: NOW,
    query: "quiet whisper fan",
    max_candidates: 10,
  });

  assert.equal(verifyShoppingArtifactAttestation("listing_candidates", result), true);
  assert.match(result.candidate_set_id, /^cset_[a-f0-9]{24}$/);
  assert.equal(result.selects_product, false);
  assert.equal(result.coverage.observed_product_links, 2);
  assert.equal(result.candidates.length, 2);
  assert.match(result.candidates[0].url, /\/dp\/B0ABCDEF12$/);
  assert.equal(result.candidates[0].price.amount_usd, 49.99);
  assert.equal(result.candidates[0].price.display, "$49.99");
  assert.equal(result.candidates[0].image, "https://images.example/fan.jpg");
  assert.equal(result.candidates[0].ref, "e2");
  assert.equal("observed_context" in result.candidates[0], false);
  assert.ok(result.candidates[0].query_overlap > result.candidates[1].query_overlap);
  assert.equal(result.candidates.some((candidate) => /affiliate|duplicate|javascript/.test(candidate.url)), false);
});

test("candidate extraction is scope-bound, capped, and never claims exhaustive discovery", () => {
  const registry = createBrowserEvidenceRegistry();
  const elements = Array.from({ length: 50 }, (_, index) => ({
    ref: `e${index + 1}`,
    role: "link",
    name: `Fan ${index}`,
    href: `https://shop.example/products/fan-${index}`,
    context: `Fan ${index} $${index + 10}.00`,
  }));
  registry.capture({ tab_id: 2, snapshot: observedSnapshot({ elements }), captured_at: NOW });
  const result = extractBrowserObservedListingCandidates(registry.resolve, {
    snapshot_id: "snapshot-listings",
    evaluated_at: NOW,
    max_candidates: 3,
  });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.coverage.observed_product_links, 50);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.exhaustive, false);
});

test("missing, stale, and model-authored candidates fail closed", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 3, snapshot: observedSnapshot(), captured_at: NOW });
  assert.throws(() => extractBrowserObservedListingCandidates(registry.resolve, {
    snapshot_id: "missing",
    evaluated_at: NOW,
    candidates: [{ title: "Injected", url: "https://attacker.example/products/fake" }],
  }), { code: "shopping_snapshot_receipt_not_found" });
  assert.throws(() => extractBrowserObservedListingCandidates(registry.resolve, {
    snapshot_id: "snapshot-listings",
    evaluated_at: "2026-08-24T20:06:00.000Z",
  }), { code: "shopping_snapshot_receipt_stale" });
});

test("multi-source fusion preserves offers, exact-URL deduplication, and source diversity", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 1, captured_at: NOW, snapshot: observedSnapshot({
    snapshotId: "snapshot-amazon",
    url: "https://www.amazon.com/s?k=quiet+fan",
    elements: [
      { ref: "e1", role: "link", name: "Whisper Fan", href: "https://www.amazon.com/Whisper/dp/B0ABCDEF12", context: "Whisper Fan $49.99" },
      { ref: "e2", role: "link", name: "Whisper Fan Pro", href: "https://www.amazon.com/Whisper-Pro/dp/B0ABCDEF13", context: "Whisper Fan Pro $69.99" },
    ],
  }) });
  registry.capture({ tab_id: 2, captured_at: NOW, snapshot: observedSnapshot({
    snapshotId: "snapshot-walmart",
    url: "https://www.walmart.com/search?q=quiet+fan",
    elements: [
      { ref: "e1", role: "link", name: "Whisper Fan", href: "https://www.walmart.com/ip/Whisper-Fan/123456789", context: "Whisper Fan $47.99" },
      { ref: "e2", role: "link", name: "Amazon duplicate", href: "https://www.amazon.com/Whisper/dp/B0ABCDEF12?utm_source=walmart", context: "Whisper Fan $50.99" },
    ],
  }) });
  const amazon = extractBrowserObservedListingCandidates(registry.resolve, { snapshot_id: "snapshot-amazon", evaluated_at: NOW, query: "quiet whisper fan" });
  const walmart = extractBrowserObservedListingCandidates(registry.resolve, { snapshot_id: "snapshot-walmart", evaluated_at: NOW, query: "quiet whisper fan" });
  const fused = fuseShoppingCandidateSets([amazon, walmart], { query: "quiet whisper fan", max_candidates: 3 });
  assert.equal(verifyShoppingArtifactAttestation("listing_candidates", fused), true);
  assert.equal(fused.coverage.source_pages, 2);
  assert.equal(fused.coverage.input_candidates, 4);
  assert.equal(fused.coverage.unique_candidates, 3);
  assert.equal(fused.coverage.merchant_domains, 2);
  assert.equal(fused.coverage.returned, 3);
  assert.equal(new Set(fused.candidates.slice(0, 2).map((candidate) => new URL(candidate.url).hostname)).size, 2);
  assert.equal(fused.candidates.some((candidate) => /B0ABCDEF12/.test(candidate.url)), true);
  const repeated = fused.candidates.find((candidate) => /B0ABCDEF12/.test(candidate.url));
  assert.equal(repeated.sources.length, 2);
  assert.equal(fused.selects_product, false);
});

test("fusion rejects repeated and tampered source sets without collapsing lookalike titles", () => {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 1, captured_at: NOW, snapshot: observedSnapshot({ snapshotId: "source-a" }) });
  registry.capture({ tab_id: 2, captured_at: NOW, snapshot: observedSnapshot({
    snapshotId: "source-b",
    url: "https://shop.example/search",
    elements: [{ ref: "e1", role: "link", name: "Whisper Fan 20 dB", href: "https://shop.example/products/whisper-fan", context: "Whisper Fan 20 dB $48.00" }],
  }) });
  const a = extractBrowserObservedListingCandidates(registry.resolve, { snapshot_id: "source-a", evaluated_at: NOW });
  const b = extractBrowserObservedListingCandidates(registry.resolve, { snapshot_id: "source-b", evaluated_at: NOW });
  const fused = fuseShoppingCandidateSets([a, b]);
  assert.ok(fused.candidates.filter((candidate) => /Whisper Fan 20 dB/i.test(candidate.title)).length >= 2, "same titles at different URLs remain distinct offers");
  assert.throws(() => fuseShoppingCandidateSets([a, a]), { code: "shopping_candidate_fusion_invalid" });
  const tampered = structuredClone(b);
  tampered.candidates[0].url = "https://attacker.example/products/fake";
  assert.throws(() => fuseShoppingCandidateSets([a, tampered]), { code: "shopping_candidate_fusion_invalid" });
});
