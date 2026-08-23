import assert from "node:assert/strict";
import test from "node:test";
import { rankShoppingCandidates } from "../lib/shopping-preferences.mjs";

const numeric = (attribute, direction, low, high, weight = 1) => ({ attribute, kind: "numeric", direction, low, high, weight });
const candidate = (id, attributes, price_usd) => ({
  id,
  ...(price_usd === undefined ? {} : { price_usd, price_evidence_status: "verified" }),
  attributes,
  attribute_evidence: Object.fromEntries(Object.keys(attributes).map((attribute) => [attribute, "verified"])),
  attribute_roles: Object.fromEntries(Object.keys(attributes).map((attribute) => [attribute, "declared_specification"])),
});

test("hard constraint violations are rejected before preference scoring", () => {
  const result = rankShoppingCandidates({
    constraints: [{ attribute: "price_usd", operator: "lte", value: 100 }],
    preferences: [numeric("battery_hours", "maximize", 5, 20)],
    candidates: [
      candidate("over-budget", { battery_hours: 20 }, 120),
      candidate("fits", { battery_hours: 12 }, 90),
    ],
  });
  assert.equal(result.assessments[0].status, "rejected");
  assert.equal(result.decision.selected_candidate, "fits");
});

test("candidate coverage clearance controls which products may enter ranking", () => {
  const candidates = [candidate("covered", { rating: 4 }), candidate("uncovered", { rating: 5 })];
  let result = rankShoppingCandidates({ preferences: [numeric("rating", "maximize", 0, 5)], candidates, candidate_coverage: { action: "coverage_sufficient", candidate_set_cleared_for_ranking: true, eligible_candidate_ids: ["covered"] } });
  assert.equal(result.decision.selected_candidate, "covered");
  assert.deepEqual(result.excluded_by_candidate_coverage, ["uncovered"]);
  result = rankShoppingCandidates({ candidates, candidate_coverage: { action: "research_more", candidate_set_cleared_for_ranking: false, eligible_candidate_ids: [] } });
  assert.equal(result.decision.reason, "candidate_set_coverage_not_cleared");
  assert.equal(result.decision.selected_candidate, null);
});

test("weighted numeric, boolean, and categorical preferences select a robust winner", () => {
  const result = rankShoppingCandidates({
    preferences: [
      numeric("battery_hours", "maximize", 5, 20, 3),
      { attribute: "noise_canceling", kind: "boolean", desired: true, weight: 2 },
      { attribute: "fit", kind: "categorical", preferred_values: ["small", "medium"], weight: 1 },
    ],
    candidates: [
      candidate("a", { battery_hours: 20, noise_canceling: true, fit: "small" }),
      candidate("b", { battery_hours: 8, noise_canceling: false, fit: "medium" }),
    ],
  });
  assert.deepEqual(result.decision, { action: "select", selected_candidate: "a", reason: "robust_preference_winner", score_lower: 100, score_upper: 100, research: [] });
});

test("missing preference evidence produces bounds and research when it could change the winner", () => {
  const result = rankShoppingCandidates({
    preferences: [numeric("battery_hours", "maximize", 5, 20, 3), { attribute: "waterproof", kind: "boolean", desired: true, weight: 2 }],
    candidates: [
      candidate("known", { battery_hours: 15, waterproof: false }),
      candidate("unknown", { battery_hours: 14 }),
    ],
  });
  assert.equal(result.decision.action, "research_more");
  assert.deepEqual(result.decision.research, [{ candidate_id: "unknown", attribute: "waterproof", reason: "preference_evidence_unknown" }]);
  assert.equal(result.assessments[1].score_lower, 36);
  assert.equal(result.assessments[1].score_upper, 76);
});

test("missing evidence on a candidate that cannot beat the winner does not block selection", () => {
  const result = rankShoppingCandidates({
    preferences: [numeric("rating", "maximize", 0, 5, 9), { attribute: "warranty", kind: "boolean", desired: true, weight: 1 }],
    candidates: [
      candidate("winner", { rating: 5, warranty: true }),
      candidate("weak", { rating: 0 }),
    ],
  });
  assert.equal(result.decision.action, "select");
  assert.equal(result.decision.selected_candidate, "winner");
});

test("unknown hard constraints trigger research unless the candidate cannot contend", () => {
  const result = rankShoppingCandidates({
    constraints: [{ attribute: "weight_g", operator: "lte", value: 300 }],
    preferences: [numeric("rating", "maximize", 0, 5)],
    candidates: [
      candidate("known", { weight_g: 250, rating: 4 }),
      candidate("unknown", { rating: 5 }),
    ],
  });
  assert.equal(result.decision.action, "research_more");
  assert.deepEqual(result.decision.research, [{ candidate_id: "unknown", attribute: "weight_g", reason: "hard_constraint_unknown" }]);
});

test("multiple viable products without stated preferences require clarification", () => {
  const result = rankShoppingCandidates({
    candidates: [
      candidate("light", { weight_g: 200 }, 100),
      candidate("cheap", { weight_g: 300 }, 80),
    ],
  });
  assert.equal(result.decision.action, "clarify");
  assert.deepEqual(result.decision.clarify_attributes, ["weight_g", "price_usd"]);
});

test("an exact score tie asks about attributes that distinguish the tied products", () => {
  const result = rankShoppingCandidates({
    preferences: [numeric("battery_hours", "maximize", 0, 20)],
    candidates: [
      candidate("a", { battery_hours: 10, weight_g: 200 }, 100),
      candidate("b", { battery_hours: 10, weight_g: 300 }, 80),
    ],
  });
  assert.equal(result.decision.action, "clarify");
  assert.deepEqual(result.decision.clarify_attributes, ["weight_g", "price_usd"]);
});

test("target preferences reward proximity and string comparisons are case-insensitive", () => {
  const result = rankShoppingCandidates({
    constraints: [{ attribute: "platform", operator: "in", value: ["iOS", "Android"] }],
    preferences: [{ attribute: "screen_inches", kind: "numeric", direction: "target", target: 6.1, tolerance: 1, weight: 1 }],
    candidates: [
      candidate("near", { platform: "ios", screen_inches: 6.2 }),
      candidate("far", { platform: "ANDROID", screen_inches: 6.8 }),
    ],
  });
  assert.equal(result.decision.selected_candidate, "near");
});

test("provided but unverified attributes are unknown by default", () => {
  const result = rankShoppingCandidates({
    preferences: [numeric("battery_hours", "maximize", 0, 20)],
    candidates: [
      candidate("verified", { battery_hours: 10 }),
      { id: "unsupported", attributes: { battery_hours: 20 }, attribute_evidence: { battery_hours: "insufficient_evidence" } },
    ],
  });
  assert.equal(result.assessments[1].preference_scores[0].value, null);
  assert.deepEqual(result.assessments[1].unknown_preferences, ["battery_hours"]);
  assert.equal(result.decision.action, "research_more");
});

test("a declared specification cannot satisfy a measured-performance requirement", () => {
  const declared = candidate("declared", { "performance:battery_runtime": 720 });
  const measured = candidate("measured", { "performance:battery_runtime": 600 });
  measured.attribute_roles["performance:battery_runtime"] = "measured_performance";
  const result = rankShoppingCandidates({ preferences: [{ ...numeric("performance:battery_runtime", "maximize", 300, 800), required_evidence_role: "measured_performance" }], candidates: [declared, measured] });
  assert.equal(result.assessments[0].preference_scores[0].value, null);
  assert.equal(result.assessments[1].preference_scores[0].value, 600);
  assert.equal(result.decision.action, "research_more");
});
