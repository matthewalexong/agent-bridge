import assert from "node:assert/strict";
import test from "node:test";
import { assessCandidateCoverage } from "../lib/shopping-candidate-coverage.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const lanes = [
  { id: "catalog", kind: "manufacturer_catalog", required: true },
  { id: "testing", kind: "independent_testing", required: true },
  { id: "retail", kind: "specialist_retailer", required: true },
  { id: "used", kind: "used_or_refurbished", required: false, reason: "The user requested new products only." },
];
const search = (id, lane_id, query_family, overrides = {}) => ({ id, lane_id, query_family, query_text: `${query_family} headphones`, category: "headphones", market_country: "US", status: "complete", evidence_status: "verified", source_id: `search-${id}`, searched_at: NOW, ...overrides });
const result = (candidate_id, search_id, independence_key, overrides = {}) => ({ id: `${candidate_id}-${search_id}`, candidate_id, search_id, category: "headphones", market_country: "US", identity_status: "exact_candidate", market_status: "available", hard_constraint_status: "eligible", direct_source_verified: true, evidence_status: "verified", source_id: `page-${candidate_id}-${search_id}`, independence_key, ownership_key: independence_key, placement: "organic", commercial_relationship: "none", ...overrides });
const base = (overrides = {}) => ({
  category: "headphones", market_country: "US", evaluated_at: NOW,
  policy: { min_eligible_candidates: 3, min_independent_sources: 3, min_query_families: 2, require_noncommercial_source: true },
  lanes,
  searches: [search("s1", "catalog", "neutral-category"), search("s2", "testing", "user-constraint"), search("s3", "retail", "neutral-category")],
  results: [result("a", "s1", "brand-a", { commercial_relationship: "brand", placement: "direct_catalog" }), result("a", "s2", "lab"), result("b", "s2", "lab"), result("b", "s3", "store"), result("c", "s3", "store")],
  ...overrides,
});

test("a bounded diverse market-scoped plan clears ranking without claiming exhaustiveness", () => {
  const got = assessCandidateCoverage(base());
  assert.equal(got.action, "coverage_sufficient");
  assert.equal(got.candidate_set_cleared_for_ranking, true);
  assert.deepEqual(got.eligible_candidate_ids, ["a", "b", "c"]);
  assert.equal(got.world_market_exhaustive, false);
  assert.equal(got.selected_candidate, null);
  assert.equal(got.purchase_allowed, false);
});

test("every required discovery lane needs a fresh verified exact-scope completed search", () => {
  for (const change of [{ status: "partial" }, { evidence_status: "unknown" }, { category: "earbuds" }, { market_country: "CA" }, { searched_at: "2020-01-01T00:00:00.000Z" }]) {
    const data = base();
    Object.assign(data.searches[0], change);
    const got = assessCandidateCoverage(data);
    assert.equal(got.action, "research_more");
    assert.ok(got.research.includes("required_lane_uncovered:catalog"));
  }
});

test("skipped lanes require a concrete reason", () => {
  const data = base();
  data.lanes[3] = { ...data.lanes[3], reason: "" };
  assert.ok(assessCandidateCoverage(data).research.includes("lane:used:skip_reason_missing"));
});

test("the discovery plan requires unique lane/search IDs and at least one required lane", () => {
  let data = base();
  data.lanes.push({ ...data.lanes[0] });
  assert.ok(assessCandidateCoverage(data).research.includes("duplicate_lane_id"));
  data = base();
  data.searches.push({ ...data.searches[0] });
  assert.ok(assessCandidateCoverage(data).research.includes("duplicate_search_id"));
  data = base({ lanes: [{ id: "optional", kind: "other", required: false, reason: "Not applicable." }], searches: [], results: [] });
  assert.ok(assessCandidateCoverage(data).research.includes("required_lane_missing"));
});

test("source pages must be direct, verified, independently and corporately identified", () => {
  for (const change of [{ direct_source_verified: false }, { evidence_status: "unknown" }, { source_id: "" }, { independence_key: "" }, { ownership_key: "" }]) {
    const data = base();
    Object.assign(data.results[0], change);
    const got = assessCandidateCoverage(data);
    assert.equal(got.action, "research_more");
    assert.ok(got.unresolved_candidate_ids.includes("a") || got.eligible_candidate_ids.includes("a"));
  }
});

test("wrong category, unavailable, and hard-constraint failures are excluded; unknowns remain unresolved", () => {
  const data = base();
  data.results.push(result("wrong", "s1", "x", { identity_status: "different_category" }));
  data.results.push(result("gone", "s1", "y", { market_status: "unavailable" }));
  data.results.push(result("fails", "s1", "z", { hard_constraint_status: "rejected" }));
  data.results.push(result("unknown", "s1", "u", { hard_constraint_status: "unknown" }));
  const got = assessCandidateCoverage(data);
  assert.deepEqual(got.excluded_candidate_ids.sort(), ["fails", "gone", "wrong"]);
  assert.deepEqual(got.unresolved_candidate_ids, ["unknown"]);
  assert.equal(got.action, "research_more");
});

test("sponsored and affiliate placements cannot manufacture source independence", () => {
  const data = base();
  data.results = [
    result("a", "s1", "ad-a", { placement: "sponsored", commercial_relationship: "sponsored" }),
    result("b", "s2", "ad-b", { placement: "affiliate", commercial_relationship: "affiliate" }),
    result("c", "s3", "store", { commercial_relationship: "seller", placement: "direct_catalog" }),
  ];
  const got = assessCandidateCoverage(data);
  assert.equal(got.coverage.independent_sources, 1);
  assert.ok(got.research.includes("independent_source_count_below_minimum"));
  assert.ok(got.research.includes("paid_placement_share_exceeds_policy"));
});

test("multiple domains under one owner expose concentration rather than fake diversity", () => {
  const data = base({ policy: { min_eligible_candidates: 3, min_independent_sources: 3, min_query_families: 2, require_noncommercial_source: true, max_single_owner_share: 0.5 } });
  data.results = [result("a", "s1", "site-a", { ownership_key: "group" }), result("b", "s2", "site-b", { ownership_key: "group" }), result("c", "s3", "site-c", { ownership_key: "other" })];
  const got = assessCandidateCoverage(data);
  assert.equal(got.coverage.independent_sources, 3);
  assert.ok(got.research.includes("single_owner_concentration_exceeds_policy"));
});

test("repeated appearances of one candidate on one source do not inflate coverage", () => {
  const data = base();
  data.results.push({ ...data.results[1], id: "duplicate-a-lab", search_id: "s3" });
  const got = assessCandidateCoverage(data);
  assert.equal(got.coverage.independent_sources, 3);
  assert.equal(got.bias_indicators.single_owner_share, 0.4);
});

test("one repeated query framing cannot satisfy query diversity", () => {
  const data = base();
  data.searches.forEach((item) => { item.query_family = "best-overall"; });
  assert.ok(assessCandidateCoverage(data).research.includes("query_family_count_below_minimum"));
});

test("different family labels cannot disguise identical query text", () => {
  const data = base();
  data.searches.forEach((item) => { item.query_text = "best headphones"; });
  assert.ok(assessCandidateCoverage(data).research.includes("query_text_diversity_below_minimum"));
});

test("commercial catalogs alone cannot satisfy an explicitly required noncommercial lane", () => {
  const data = base();
  data.results.forEach((item) => { item.commercial_relationship = "seller"; item.placement = "direct_catalog"; });
  assert.ok(assessCandidateCoverage(data).research.includes("noncommercial_source_missing"));
});

test("candidate coverage partitions but never ranks, selects, claims exhaustiveness, or buys", () => {
  const got = assessCandidateCoverage(base({ results: [] }));
  assert.equal(got.action, "research_more");
  assert.equal(got.selected_candidate, null);
  assert.equal(got.world_market_exhaustive, false);
  assert.equal(got.purchase_allowed, false);
});
