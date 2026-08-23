import test from "node:test";
import assert from "node:assert/strict";
import { resolveProductIdentities } from "../lib/shopping-identity.mjs";

const resolveOne = (target, candidate, options = {}) => resolveProductIdentities({ target, candidates: [{ id: "A", ...candidate }], ...options }).resolutions[0];

test("model punctuation and brand typography normalize without fuzzy matching", () => {
  const result = resolveOne(
    { brand: "Sony", product_line: "WH-1000XM5", model: "WH-1000XM5" },
    { brand: "SONY®", product_line: "WH 1000XM5", model: "WH1000XM5" },
    { required_fields: ["brand", "product_line", "model"] },
  );
  assert.equal(result.classification, "exact_match");
});

test("fragrance terminology and conventional volume equivalents normalize", () => {
  const result = resolveOne(
    { brand: "Armaf", product_line: "Odyssey Homme Black EDP", edition: "base", size: "3.4 fl oz" },
    { brand: "ARMAF", product_line: "Odyssey Homme Black Eau de Parfum", edition: "original", size: "100 ml" },
    { required_fields: ["brand", "product_line", "edition", "size"] },
  );
  assert.equal(result.classification, "exact_match");
});

test("same-name spin-off is a different edition", () => {
  const result = resolveOne(
    { brand: "Armaf", product_line: "Odyssey Homme Black Eau de Parfum", edition: "base" },
    { brand: "Armaf", product_line: "Odyssey Homme Black Eau de Parfum", edition: "Black Forest Dessert" },
    { required_fields: ["brand", "product_line", "edition"] },
  );
  assert.equal(result.classification, "different_edition");
  assert.equal(result.safe_to_compare_offers, false);
});

test("generation, capacity, and region mismatches remain distinct variants", () => {
  assert.equal(resolveOne({ generation: "Gen 2" }, { generation: "Gen 1" }, { required_fields: ["generation"] }).classification, "different_generation");
  assert.equal(resolveOne({ capacity: "1 TB" }, { capacity: "500 GB" }, { required_fields: ["capacity"] }).classification, "different_variant");
  assert.equal(resolveOne({ region: "US" }, { region: "UK" }, { required_fields: ["region"] }).classification, "different_variant");
});

test("condition and bundle changes cannot enter exact-offer comparison", () => {
  assert.equal(resolveOne({ condition: "new" }, { condition: "refurbished" }, { required_fields: ["condition"] }).classification, "different_condition");
  const bundle = resolveOne(
    { bundle_count: 1, bundle_contents: ["camera body"] },
    { bundle_count: 2, bundle_contents: ["camera body", "generic battery"] },
    { required_fields: ["bundle_count"] },
  );
  assert.equal(bundle.classification, "different_bundle");
});

test("global identifier conflicts override matching marketing text", () => {
  const result = resolveOne(
    { brand: "Acme", product_line: "Filter Pro", identifiers: { upc: "012345678905" } },
    { brand: "Acme", product_line: "Filter Pro", identifiers: { upc: "999999999999" } },
    { required_fields: ["brand", "product_line"] },
  );
  assert.equal(result.classification, "identity_conflict");
  assert.deepEqual(result.identifier_conflicts, ["trade_item_code"]);
});

test("UPC and zero-padded EAN identify the same trade item", () => {
  const result = resolveOne(
    { brand: "Acme", identifiers: { upc: "123456789012" } },
    { brand: "Acme", identifiers: { ean: "0123456789012" } },
    { required_fields: ["brand"] },
  );
  assert.equal(result.classification, "exact_match");
  assert.deepEqual(result.identifier_matches, ["trade_item_code"]);
});

test("missing hard identity evidence abstains", () => {
  const result = resolveOne(
    { brand: "Nintendo", product_line: "Game X", region: "US" },
    { brand: "Nintendo", product_line: "Game X" },
    { required_fields: ["brand", "product_line", "region"] },
  );
  assert.equal(result.classification, "insufficient_evidence");
  assert.deepEqual(result.missing_fields, ["region"]);
});

test("user-declared flexible color does not block an otherwise exact match", () => {
  const result = resolveOne(
    { brand: "Acme", model: "K1", color: "black" },
    { brand: "Acme", model: "K1", color: "white" },
    { required_fields: ["brand", "model", "color"], flexible_fields: ["color"] },
  );
  assert.equal(result.classification, "exact_match");
});

test("compatible replacement remains an alternative, not an exact product", () => {
  const result = resolveOne(
    { brand: "PureAir", product_line: "OEM PA7 Filter", compatibility_key: "PA7" },
    { brand: "FilterCo", product_line: "PA7 Compatible Filter", compatibility_keys: ["PA-7"] },
    { required_fields: ["brand", "product_line"], mode: "compatible_part" },
  );
  assert.equal(result.classification, "compatible_alternative");
  assert.equal(result.safe_to_compare_offers, false);
});

test("shared words without exact line equality are a different product", () => {
  const result = resolveOne(
    { brand: "Armaf", product_line: "Odyssey Homme Black" },
    { brand: "Avon", product_line: "Odyssey Black" },
    { required_fields: ["brand", "product_line"] },
  );
  assert.equal(result.classification, "different_product");
});
