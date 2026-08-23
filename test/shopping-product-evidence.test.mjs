import assert from "node:assert/strict";
import test from "node:test";
import { aggregateProductEvidence } from "../lib/shopping-product-evidence.mjs";
import { rankShoppingCandidates } from "../lib/shopping-preferences.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const source = (id, source_type, url, captured_at = NOW, extra = {}) => ({ id, source_type, url, captured_at, ...extra });
const objective = (product_id, attribute, value, unit, src, excerpt = "visible fact", evidence_role = "declared_specification") => ({ product_id, attribute, value, unit, evidence_role, claim_type: "objective", source: src, excerpt });
const review = (product_id, attribute, sentiment, id, excerpt, channel = "store") => ({ product_id, attribute, review_id: id, claim_type: "review", sentiment, excerpt, source: source(id, "customer_review", `https://${channel}.example/review/${id}`, NOW, { channel }) });

test("one fresh manufacturer claim verifies an objective specification", () => {
  const result = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [
    objective("a", "battery_hours", 20, "hours", source("m1", "manufacturer", "https://brand.example/spec")),
  ] });
  assert.equal(result.objective_claims[0].status, "verified");
  assert.equal(result.objective_claims[0].value, 1200);
  assert.equal(result.objective_claims[0].unit, "min");
  assert.equal(result.products[0].verified_attributes.battery_hours, 1200);
});

test("ordinary claims require independent corroboration and same-domain pages count once", () => {
  const oneDomain = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [
    objective("a", "weight_g", 250, "g", source("r1", "retailer", "https://shop.example/a")),
    objective("a", "weight_g", 250, "g", source("r2", "retailer", "https://shop.example/b")),
  ] });
  assert.equal(oneDomain.objective_claims[0].status, "insufficient_evidence");
  assert.equal(oneDomain.objective_claims[0].values[0].independent_sources, 1);

  const twoDomains = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [
    objective("a", "weight_g", 250, "g", source("r1", "retailer", "https://one.example/a")),
    objective("a", "weight_g", 0.25, "kg", source("r2", "professional_review", "https://two.example/b")),
  ] });
  assert.equal(twoDomains.objective_claims[0].status, "verified");
  assert.equal(twoDomains.objective_claims[0].value, 250);
});

test("fresh conflicting values remain a conflict even when one is authoritative", () => {
  const result = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [
    objective("a", "waterproof", true, null, source("m", "manufacturer", "https://brand.example/spec")),
    objective("a", "waterproof", false, null, source("r", "professional_review", "https://lab.example/test")),
  ] });
  assert.equal(result.objective_claims[0].status, "conflict");
  assert.deepEqual(result.products[0].verified_attributes, {});
  assert.equal(result.products[0].attribute_evidence.waterproof, "conflict");
});

test("search snippets never verify facts and stale pages do not become current evidence", () => {
  const snippet = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [
    objective("a", "battery_hours", 20, "hours", source("s", "search_snippet", "https://search.example/result")),
  ] });
  assert.equal(snippet.objective_claims[0].status, "insufficient_evidence");
  assert.equal(snippet.objective_claims[0].excluded_claims, 1);

  const stale = aggregateProductEvidence({ policy: { evaluated_at: NOW, max_age_days: 30 }, claims: [
    objective("a", "battery_hours", 20, "hours", source("m", "manufacturer", "https://brand.example/spec", "2025-01-01T00:00:00.000Z")),
  ] });
  assert.equal(stale.objective_claims[0].status, "stale");
});

test("customer reviews cannot corroborate an objective specification", () => {
  const result = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [
    objective("a", "battery_hours", 20, "hours", source("u1", "customer_review", "https://store-one.example/r/1")),
    objective("a", "battery_hours", 20, "hours", source("u2", "customer_review", "https://store-two.example/r/2")),
  ] });
  assert.equal(result.objective_claims[0].status, "insufficient_evidence");
  assert.equal(result.objective_claims[0].excluded_claims, 2);
});

test("raw measured-performance claims cannot bypass the performance evaluator", () => {
  const result = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [objective("a", "performance:battery_runtime", 600, "min", source("m", "manufacturer", "https://brand.example/test"), "up to 10 hours", "measured_performance")] });
  assert.equal(result.objective_claims[0].status, "insufficient_evidence");
  assert.deepEqual(result.products[0].verified_attributes, {});
});

test("comparable performance artifacts enter a distinct measured-performance namespace", () => {
  const metric = { attribute: "performance:battery_runtime", value: 610, unit: "min", lower: 595, upper: 625, independent_labs: 2, measurement_ids: ["a1", "a2"] };
  const result = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [objective("a", "declared:battery_runtime", 720, "min", source("m", "manufacturer", "https://brand.example/spec"))], performance_evidence: [{ product_id: "a", attribute: "performance:battery_runtime", action: "comparable", performance_cleared_for_ranking: true, metric }] });
  assert.equal(result.products[0].verified_attributes["declared:battery_runtime"], 720);
  assert.equal(result.products[0].verified_attributes["performance:battery_runtime"], 610);
  assert.equal(result.products[0].attribute_roles["declared:battery_runtime"], "declared_specification");
  assert.equal(result.products[0].attribute_roles["performance:battery_runtime"], "measured_performance");
});

test("syndicated review text is deduplicated across stores", () => {
  const result = aggregateProductEvidence({ policy: { evaluated_at: NOW, min_relevant_reviews: 3 }, review_integrity: [{ product_id: "a", action: "eligible_for_review_ranking", eligible_review_ids: ["1", "2", "3", "4"] }], claims: [
    review("a", "comfort", "positive", "1", "Fits all day without pressure", "store-one"),
    review("a", "comfort", "positive", "2", "Fits all day without pressure", "store-two"),
    review("a", "comfort", "positive", "3", "Soft pads and no hot spots", "store-two"),
    review("a", "comfort", "negative", "4", "Clamp becomes painful", "store-three"),
  ] });
  assert.equal(result.review_themes[0].independent_reviews, 3);
  assert.equal(result.review_themes[0].relevant_reviews, 3);
  assert.equal(result.review_themes[0].status, "supported");
});

test("review themes stay subjective and expose a bounded ranking metric only with support", () => {
  const result = aggregateProductEvidence({ policy: { evaluated_at: NOW, min_relevant_reviews: 3, min_review_channels: 2 }, review_integrity: [{ product_id: "a", action: "eligible_for_review_ranking", eligible_review_ids: ["1", "2", "3"] }, { product_id: "b", action: "eligible_for_review_ranking", eligible_review_ids: ["4"] }], claims: [
    review("a", "durability", "positive", "1", "Survived daily drops", "one"),
    review("a", "durability", "positive", "2", "Still solid after a year", "one"),
    review("a", "durability", "negative", "3", "Hinge cracked", "two"),
    review("b", "durability", "positive", "4", "Feels sturdy", "one"),
  ] });
  const a = result.review_themes.find((theme) => theme.product_id === "a");
  const b = result.review_themes.find((theme) => theme.product_id === "b");
  assert.equal(a.status, "supported");
  assert.equal(a.direction, "positive");
  assert.equal(a.sentiment_score, 0.666667);
  assert.equal(result.products.find((product) => product.id === "a").review_metrics["review:durability"], 0.666667);
  assert.equal(result.products.find((product) => product.id === "a").attribute_evidence["review:durability"], "verified");
  assert.equal(b.status, "insufficient_evidence");
  assert.equal(b.sentiment_score, null);
});

test("review themes cannot become ranking metrics without exact integrity clearance", () => {
  const claims = [
    review("a", "comfort", "positive", "1", "Comfortable", "one"),
    review("a", "comfort", "positive", "2", "Soft", "two"),
    review("a", "comfort", "negative", "3", "Clamps", "three"),
  ];
  const missing = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims });
  assert.equal(missing.review_themes[0].usable_for_ranking, false);
  assert.equal(missing.review_themes[0].reason, "review_integrity_clearance_required");
  assert.deepEqual(missing.products[0].review_metrics, {});
  const excluded = aggregateProductEvidence({ policy: { evaluated_at: NOW }, review_integrity: [{ product_id: "a", action: "exclude_reviews", eligible_review_ids: ["1", "2", "3"] }], claims });
  assert.equal(excluded.review_themes[0].usable_for_ranking, false);
});

test("aggregated product output feeds the verified-only preference ranker", () => {
  const evidence = aggregateProductEvidence({ policy: { evaluated_at: NOW }, claims: [
    objective("a", "battery_minutes", 20, "hours", source("a-m", "manufacturer", "https://a.example/spec")),
    objective("b", "battery_minutes", 900, "min", source("b-m", "manufacturer", "https://b.example/spec")),
  ] });
  const candidates = evidence.products.map((product) => ({ id: product.id, attributes: { ...product.verified_attributes, ...product.review_metrics }, attribute_evidence: product.attribute_evidence }));
  const ranking = rankShoppingCandidates({
    preferences: [{ attribute: "battery_minutes", kind: "numeric", direction: "maximize", low: 600, high: 1200, weight: 1 }],
    candidates,
  });
  assert.equal(ranking.decision.action, "select");
  assert.equal(ranking.decision.selected_candidate, "a");
});
