import assert from "node:assert/strict";
import test from "node:test";
import { assessReviewIntegrity } from "../lib/shopping-review-integrity.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const collection = (id = "c1", overrides = {}) => ({ id, channel_id: id, independence_key: id, product_id: "p", scope_status: "exact_product", sampling_method: "random", population_size: 100, sampled_count: 5, captured_at: NOW, evidence_status: "verified", source_id: `source-${id}`, ...overrides });
const review = (index, overrides = {}) => ({ id: `r${index}`, collection_id: index < 5 ? "c1" : "c2", product_id: "p", scope_status: "exact_product", source_id: `source-r${index}`, channel_id: index < 5 ? "c1" : "c2", reviewer_key: `person-${index}`, text_fingerprint: `text-${index}`, evidence_status: "verified", captured_at: NOW, published_at: new Date(Date.parse(NOW) - index * 7 * 86_400_000).toISOString(), moderation_status: "published", incentive_status: "none", verified_purchase: index % 2 === 0, rating: (index % 5) + 1, ...overrides });
const input = (overrides = {}) => ({ product_id: "p", evaluated_at: NOW, policy: { min_eligible_reviews: 10, min_independent_reviewers: 10, min_channels: 2, max_burst_share: 0.8 }, collections: [collection("c1"), collection("c2")], reviews: Array.from({ length: 10 }, (_, index) => review(index)), findings: [], ...overrides });

test("representative exact-product organic reviews clear review ranking only", () => {
  const result = assessReviewIntegrity(input());
  assert.equal(result.action, "eligible_for_review_ranking");
  assert.equal(result.review_evidence_cleared_for_ranking, true);
  assert.equal(result.eligible_review_ids.length, 10);
  assert.equal(result.indicators.verified_purchase_share, 0.5);
  assert.equal(result.selected_product, null);
  assert.equal(result.purchase_allowed, false);
});

test("search-selected, top-helpful, stale, and unverified collections cannot represent review prevalence", () => {
  for (const overrides of [
    { sampling_method: "search_selected" },
    { sampling_method: "top_helpful" },
    { captured_at: "2020-01-01T00:00:00.000Z" },
    { evidence_status: "claimed" },
  ]) {
    const result = assessReviewIntegrity(input({ collections: [collection("c1", overrides), collection("c2", overrides)] }));
    assert.equal(result.action, "research_more");
    assert.equal(result.review_evidence_cleared_for_ranking, false);
  }
});

test("collection claims must match supplied records, product, variant, and channel", () => {
  for (const mutate of [
    (data) => { data.collections[0].sampled_count = 6; },
    (data) => { data.collections[0].product_id = "other"; },
    (data) => { data.reviews[0].channel_id = "other"; },
  ]) {
    const data = input();
    mutate(data);
    const result = assessReviewIntegrity(data);
    assert.notEqual(result.action, "eligible_for_review_ranking");
  }
});

test("multiple pages with one independence key count as one review channel", () => {
  const result = assessReviewIntegrity(input({ collections: [collection("c1", { independence_key: "same-platform" }), collection("c2", { independence_key: "same-platform" })] }));
  assert.equal(result.coverage.channels, 1);
  assert.equal(result.action, "research_more");
});

test("a complete collection must actually contain its entire declared population", () => {
  const data = input({ collections: [collection("c1", { sampling_method: "complete", population_size: 10, sampled_count: 5 }), collection("c2")] });
  const result = assessReviewIntegrity(data);
  assert.ok(result.research.includes("collection:c1:incomplete_population_export"));
});

test("exact variant scope prevents family and different-variant leakage", () => {
  const scoped = input({ variant_id: "red", collections: [collection("c1", { scope_status: "exact_variant", variant_id: "red" }), collection("c2", { scope_status: "exact_variant", variant_id: "red" })] });
  scoped.reviews = scoped.reviews.map((item, index) => ({ ...item, scope_status: index === 0 ? "product_family" : "exact_variant", variant_id: index === 1 ? "blue" : "red" }));
  const result = assessReviewIntegrity(scoped);
  assert.equal(result.excluded_reviews.scope_unresolved, 2);
  assert.equal(result.action, "research_more");
});

test("syndicated text and repeated reviewers count once", () => {
  const data = input();
  data.reviews[8].syndication_key = "copy";
  data.reviews[9].syndication_key = "copy";
  data.reviews[7].reviewer_key = data.reviews[6].reviewer_key;
  const result = assessReviewIntegrity(data);
  assert.equal(result.coverage.eligible_reviews, 8);
  assert.equal(result.action, "research_more");
});

test("disclosed incentives and unknown incentive status are never treated as organic", () => {
  const data = input();
  data.reviews[0].incentive_status = "disclosed";
  data.reviews[1].incentive_status = "unknown";
  const result = assessReviewIntegrity(data);
  assert.equal(result.excluded_reviews.incentivized, 1);
  assert.equal(result.excluded_reviews.incentive_unknown, 1);
  assert.equal(result.action, "research_more");
});

test("duplicate, incentive, burst, and extreme-rating signals limit use without alleging fraud", () => {
  const burst = input({ policy: { min_eligible_reviews: 10, min_independent_reviewers: 10, min_channels: 2, max_burst_share: 0.5 } });
  burst.reviews = burst.reviews.map((item, index) => ({ ...item, published_at: new Date(Date.parse(NOW) - index * 3_600_000).toISOString() }));
  const result = assessReviewIntegrity(burst);
  assert.equal(result.action, "exclude_reviews");
  assert.ok(result.signals.includes("review_burst_exceeds_policy"));
  assert.equal(result.fraud_claim_allowed, false);
  assert.match(result.language_guardrail, /not_fake_reviews/);
});

test("high duplicate and disclosed-incentive shares independently exclude review metrics", () => {
  const duplicates = input({ policy: { min_eligible_reviews: 5, min_independent_reviewers: 5, min_channels: 2, max_duplicate_share: 0.1, max_burst_share: 1 } });
  duplicates.reviews[8].text_fingerprint = duplicates.reviews[0].text_fingerprint;
  duplicates.reviews[9].text_fingerprint = duplicates.reviews[1].text_fingerprint;
  assert.ok(assessReviewIntegrity(duplicates).signals.includes("duplicate_share_exceeds_policy"));

  const incentives = input({ policy: { min_eligible_reviews: 5, min_independent_reviewers: 5, min_channels: 2, max_incentivized_share: 0.1, max_burst_share: 1 } });
  incentives.reviews[0].incentive_status = "disclosed";
  incentives.reviews[1].incentive_status = "disclosed";
  const result = assessReviewIntegrity(incentives);
  assert.ok(result.signals.includes("incentivized_share_exceeds_policy"));
  assert.equal(result.action, "exclude_reviews");
});

test("extreme rating concentration is a bounded exclusion signal, not a fraud finding", () => {
  const reviews = Array.from({ length: 20 }, (_, index) => review(index, { id: `x${index}`, collection_id: index < 10 ? "c1" : "c2", channel_id: index < 10 ? "c1" : "c2", reviewer_key: `x-person-${index}`, text_fingerprint: `x-text-${index}`, rating: 5 }));
  const result = assessReviewIntegrity(input({ policy: { min_eligible_reviews: 20, min_independent_reviewers: 20, min_channels: 2, max_burst_share: 1 }, collections: [collection("c1", { sampled_count: 10 }), collection("c2", { sampled_count: 10 })], reviews }));
  assert.ok(result.signals.includes("rating_concentration_extreme"));
  assert.equal(result.action, "exclude_reviews");
  assert.equal(result.fraud_claim_allowed, false);
});

test("verified active platform enforcement excludes reviews but does not authorize a fraud accusation", () => {
  const finding = { id: "f", product_id: "p", type: "fake_review_enforcement", authority_type: "platform", applies_to_exact_product: true, status: "active", evidence_status: "verified", source_id: "platform-notice" };
  const result = assessReviewIntegrity(input({ findings: [finding] }));
  assert.equal(result.integrity_status, "compromised");
  assert.equal(result.action, "exclude_reviews");
  assert.equal(result.fraud_claim_allowed, false);
});

test("only exact verified active regulator or court findings permit attributed accusation language", () => {
  const finding = { id: "f", product_id: "p", type: "review_suppression", authority_type: "regulator", applies_to_exact_product: true, status: "active", evidence_status: "verified", source_id: "order" };
  assert.equal(assessReviewIntegrity(input({ findings: [finding] })).fraud_claim_allowed, true);
  for (const change of [{ applies_to_exact_product: false }, { evidence_status: "claimed" }, { status: "resolved" }, { authority_type: "customer_review" }]) {
    assert.equal(assessReviewIntegrity(input({ findings: [{ ...finding, ...change }] })).fraud_claim_allowed, false);
  }
  assert.equal(assessReviewIntegrity(input({ findings: [{ ...finding, product_id: "other" }] })).fraud_claim_allowed, false);
});

test("missing reviewer or content keys, removed reviews, and stale timestamps abstain", () => {
  const data = input();
  Object.assign(data.reviews[0], { reviewer_key: "" });
  Object.assign(data.reviews[1], { text_fingerprint: "" });
  Object.assign(data.reviews[2], { moderation_status: "removed" });
  Object.assign(data.reviews[3], { published_at: "2020-01-01T00:00:00.000Z" });
  const result = assessReviewIntegrity(data);
  assert.equal(result.action, "research_more");
  assert.equal(result.coverage.eligible_reviews, 6);
});

test("no review-integrity outcome selects a product or authorizes purchase", () => {
  for (const result of [assessReviewIntegrity(input()), assessReviewIntegrity(input({ reviews: [] }))]) {
    assert.equal(result.selected_product, null);
    assert.equal(result.purchase_allowed, false);
  }
});
