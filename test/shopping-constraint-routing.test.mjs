import assert from "node:assert/strict";
import test from "node:test";
import { deriveShoppingConstraintRoutes, requiredConstraintIdsForStage, validateShoppingConstraintJob } from "../lib/shopping-constraint-routing.mjs";

const literal = (suffix, kind, operator, value, unit = null) => ({ literal_id: `literal_${suffix.repeat(24).slice(0, 24)}`, kind, operator, value, unit });
const skipped = { required: false, reason: "Not needed by this constraint fixture." };
const applicability = (overrides = {}) => ({
  candidate_coverage: skipped, performance: skipped, value: skipped, condition: skipped, promotion: skipped,
  review_integrity: skipped, composition: skipped, privacy: skipped, compatibility: skipped, lifecycle: skipped,
  preferences: skipped, ownership: skipped, deal: skipped, ...overrides,
});

function context(phase, constraints, overrides = {}) {
  const base = { phase, constraints, applicability: applicability(overrides) };
  return { ...base, constraint_routes: deriveShoppingConstraintRoutes(base) };
}

test("process-owned routes activate product constraints and explicitly defer offer-only constraints", () => {
  const constraints = [
    { id: "budget", kind: "budget", literal_bindings: [literal("a", "money", "lt", 500, "USD")] },
    { id: "compat", kind: "compatibility", literal_bindings: [] },
    { id: "deadline", kind: "deadline", literal_bindings: [literal("b", "deadline", "lte", "2026-08-30", "date")] },
  ];
  const routed = context("product_recommendation", constraints, { preferences: { required: true }, compatibility: { required: true } });
  assert.deepEqual(routed.constraint_routes, [
    { constraint_id: "budget", kind: "budget", status: "active", stages: ["preferences"], deferred_until: null },
    { constraint_id: "compat", kind: "compatibility", status: "active", stages: ["compatibility"], deferred_until: null },
    { constraint_id: "deadline", kind: "deadline", status: "deferred", stages: [], deferred_until: "offer_recommendation" },
  ]);
  assert.deepEqual(requiredConstraintIdsForStage(routed, "preferences"), ["budget"]);
  assert.throws(() => context("product_recommendation", constraints, { compatibility: { required: true } }), { code: "shopping_constraint_route_applicability" });
});

test("preference jobs must claim every routed constraint and preserve every canonical literal", () => {
  const money = literal("c", "money", "lt", 500, "USD");
  const routed = context("product_recommendation", [{ id: "budget", kind: "budget", literal_bindings: [money] }], { preferences: { required: true } });
  const valid = { constraints: [{ id: "budget", literal_id: money.literal_id, attribute: "price_usd", operator: "lt", value: 500, unit: "USD" }] };
  assert.deepEqual(validateShoppingConstraintJob({ decision_context: routed, stage: "preferences", constraint_ids: ["budget"], input: valid }), ["budget"]);
  assert.throws(() => validateShoppingConstraintJob({ decision_context: routed, stage: "preferences", constraint_ids: [], input: valid }), { code: "shopping_constraint_route_incomplete" });
  assert.throws(() => validateShoppingConstraintJob({ decision_context: routed, stage: "preferences", constraint_ids: ["budget", "budget"], input: valid }), { code: "shopping_constraint_route_invalid" });
  for (const change of [
    (item) => { item.value = 501; },
    (item) => { item.operator = "lte"; },
    (item) => { item.unit = "EUR"; },
    (item) => { delete item.literal_id; },
  ]) {
    const altered = structuredClone(valid);
    change(altered.constraints[0]);
    assert.throws(() => validateShoppingConstraintJob({ decision_context: routed, stage: "preferences", constraint_ids: ["budget"], input: altered }), { code: /shopping_constraint_input_(mismatch|missing)/ });
  }
});

test("offer evaluators preserve strict budget operators and exact arrival deadlines", () => {
  const money = literal("d", "money", "lt", 1_000, "USD");
  const deadline = literal("e", "deadline", "lte", "2026-08-30", "date");
  const routed = context("offer_recommendation", [
    { id: "budget", kind: "budget", literal_bindings: [money] },
    { id: "arrival", kind: "deadline", literal_bindings: [deadline] },
  ]);
  assert.deepEqual(requiredConstraintIdsForStage(routed, "fulfillment"), ["arrival", "budget"]);
  const fulfillment = { requirements: { max_fully_landed_usd: 1_000, max_fully_landed_operator: "lt", required_by: "2026-08-30T00:00:00.000Z" } };
  assert.deepEqual(validateShoppingConstraintJob({ decision_context: routed, stage: "fulfillment", constraint_ids: ["budget", "arrival"], input: fulfillment }), ["arrival", "budget"]);
  assert.deepEqual(validateShoppingConstraintJob({ decision_context: routed, stage: "offer", constraint_ids: ["budget"], input: { requirements: { max_landed_usd: 1_000, max_landed_operator: "lt" } } }), ["budget"]);
  const weakened = structuredClone(fulfillment);
  weakened.requirements.max_fully_landed_operator = "lte";
  assert.throws(() => validateShoppingConstraintJob({ decision_context: routed, stage: "fulfillment", constraint_ids: ["arrival", "budget"], input: weakened }), { code: "shopping_constraint_input_mismatch" });
  const late = structuredClone(fulfillment);
  late.requirements.required_by = "2026-08-31T00:00:00.000Z";
  assert.throws(() => validateShoppingConstraintJob({ decision_context: routed, stage: "fulfillment", constraint_ids: ["arrival", "budget"], input: late }), { code: "shopping_constraint_input_mismatch" });
});

test("relative arrival language is deferred during product selection and fails closed before offer evaluation", () => {
  const relative = literal("f", "deadline", "by", "friday", "date");
  assert.doesNotThrow(() => context("product_recommendation", [{ id: "arrival", kind: "deadline", literal_bindings: [relative] }]));
  assert.throws(() => context("offer_recommendation", [{ id: "arrival", kind: "deadline", literal_bindings: [relative] }]), { code: "shopping_constraint_deadline_unresolved" });
});

test("compatibility jobs cannot omit the exact normalized requirement ID", () => {
  const routed = context("product_recommendation", [{ id: "iphone", kind: "compatibility", literal_bindings: [] }], { compatibility: { required: true } });
  assert.deepEqual(validateShoppingConstraintJob({ decision_context: routed, stage: "compatibility", constraint_ids: ["iphone"], input: { requirements: [{ id: "iphone" }] } }), ["iphone"]);
  assert.throws(() => validateShoppingConstraintJob({ decision_context: routed, stage: "compatibility", constraint_ids: ["iphone"], input: { requirements: [{ id: "android" }] } }), { code: "shopping_constraint_input_missing" });
});

test("authorized-seller constraints route to signed directory adjudication and must be consumed exactly", () => {
  const source = { clause_id: "clause_authorizedseller123456", text: "Use an authorized seller only" };
  const constraint = {
    id: "authorized", kind: "merchant", source_clause_ids: [source.clause_id], literal_bindings: [],
    evaluator_bindings: [{ stage: "counterfeit", rule: "authorized_seller_required", value: true, source_clause_id: source.clause_id, source_quote: source.text }],
  };
  const base = { phase: "offer_recommendation", constraints: [constraint], applicability: applicability(), request_receipt: { clauses: [source] } };
  const routed = { ...base, constraint_routes: deriveShoppingConstraintRoutes(base) };
  assert.deepEqual(routed.constraint_routes, [{ constraint_id: "authorized", kind: "merchant", status: "active", stages: ["counterfeit"], deferred_until: null }]);
  assert.deepEqual(validateShoppingConstraintJob({ decision_context: routed, stage: "counterfeit", constraint_ids: ["authorized"], input: { requirements: { authorized_seller_required: true } } }), ["authorized"]);
  assert.throws(() => validateShoppingConstraintJob({ decision_context: routed, stage: "counterfeit", constraint_ids: ["authorized"], input: { requirements: { authorized_seller_required: false } } }), { code: "shopping_constraint_input_mismatch" });
});
