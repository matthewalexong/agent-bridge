import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedListingCandidates } from "../lib/shopping-browser-evidence.mjs";
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
