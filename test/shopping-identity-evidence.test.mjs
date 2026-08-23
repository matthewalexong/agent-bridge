import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserEvidenceRegistry, extractBrowserObservedShoppingPageEvidence } from "../lib/shopping-browser-evidence.mjs";
import { resolveProductIdentitiesFromEvidence } from "../lib/shopping-identity-evidence.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

function page(id, text, page_kind) {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 13, captured_at: NOW, snapshot: {
    snapshotId: id,
    title: id,
    url: `https://identity.example/${id}`,
    text,
    truncated: false,
  } });
  return extractBrowserObservedShoppingPageEvidence(registry.resolve, { snapshot_id: id, evaluated_at: NOW, page_kind });
}

const target = () => page("identity-target", "Brand: Acme\nProduct Line: Camera X\nProduct Category: cameras\nModel: CX-1\nGeneration: 2\nEdition: Pro\nRegion: US\nCapacity: 1 TB\nMPN: ACME-CX1-PRO", "manufacturer_product");
const listing = (edition = "Pro", includeCondition = true) => page("identity-listing", `Brand: Acme\nProduct Line: Camera X\nModel: CX-1\nGeneration: 2\nEdition: ${edition}\nRegion: US\nCapacity: 1 TB\nMPN: ACME-CX1-PRO${includeCondition ? "\nCondition: new" : ""}\nSold by: Acme Camera`, "retailer_listing");

test("canonical identity compares signed manufacturer and listing fields with automatic required scope", () => {
  const result = resolveProductIdentitiesFromEvidence({
    evaluated_at: NOW,
    target_product_id: "camera-x",
    target_evidence: target(),
    candidates: [{ id: "offer-a", offer_variant: "pro-us-1tb", listing_evidence: listing() }],
  });
  assert.deepEqual(result.required_fields, ["brand", "product_line", "model", "generation", "edition", "region", "capacity"]);
  assert.equal(result.resolutions[0].classification, "exact_match");
  assert.equal(result.resolutions[0].safe_to_compare_offers, true);
  assert.equal(result.resolutions[0].canonical.condition, "new");
  assert.equal(result.product_category, "cameras");
});

test("model-authored identity fields cannot override signed listing evidence", () => {
  const result = resolveProductIdentitiesFromEvidence({
    evaluated_at: NOW,
    target_product_id: "camera-x",
    target_evidence: target(),
    candidates: [{ id: "offer-a", listing_evidence: listing("Standard"), brand: "Acme", model: "CX-1", edition: "Pro", condition: "new" }],
  });
  assert.equal(result.resolutions[0].classification, "different_edition");
  assert.equal(result.resolutions[0].safe_to_compare_offers, false);
});

test("tampered, stale, wrong-kind, and condition-free identity evidence fails closed", () => {
  const tampered = target();
  tampered.facts.identity.model.value = "Injected";
  assert.throws(() => resolveProductIdentitiesFromEvidence({
    evaluated_at: NOW,
    target_product_id: "camera-x",
    target_evidence: tampered,
    candidates: [{ id: "offer-a", listing_evidence: listing() }],
  }), { code: "shopping_identity_page_evidence_invalid" });

  assert.throws(() => resolveProductIdentitiesFromEvidence({
    evaluated_at: "2026-08-22T20:06:00.000Z",
    target_product_id: "camera-x",
    target_evidence: target(),
    candidates: [{ id: "offer-a", listing_evidence: listing() }],
  }), { code: "shopping_identity_page_evidence_stale" });

  assert.throws(() => resolveProductIdentitiesFromEvidence({
    evaluated_at: NOW,
    target_product_id: "camera-x",
    target_evidence: listing(),
    candidates: [{ id: "offer-a", listing_evidence: listing() }],
  }), { code: "shopping_identity_page_evidence_scope" });

  assert.throws(() => resolveProductIdentitiesFromEvidence({
    evaluated_at: NOW,
    target_product_id: "camera-x",
    target_evidence: target(),
    candidates: [{ id: "offer-a", listing_evidence: listing("Pro", false) }],
  }), { code: "shopping_identity_condition_unresolved" });
});
