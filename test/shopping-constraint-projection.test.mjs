import assert from "node:assert/strict";
import test from "node:test";
import { materializeShoppingConstraintBindings, validateShoppingConstraintBindings, validateShoppingConstraintProjectionInput } from "../lib/shopping-constraint-projection.mjs";

const clause = (character, text) => ({ clause_id: `clause_${character.repeat(24)}`, text });
const negation = (character = "f") => ({ literal_id: `literal_${character.repeat(24)}`, kind: "negation", operator: "not_allowed", value: false, unit: null });
const numberLiteral = (character, value, unit) => ({ literal_id: `literal_${character.repeat(24)}`, kind: "measurement", operator: "lte", value, unit });
const route = (constraint_id, kind, stages) => ({ constraint_id, kind, status: "active", stages, deferred_until: null });

function constraint({ id, kind, text, rule, value, stage, literals = [], hard_gate = true }) {
  const source = clause(id[0], text);
  return {
    source,
    value: {
      id, kind, requirement: text, value: String(value), hard_gate, source_clause_ids: [source.clause_id], literal_bindings: literals,
      evaluator_bindings: rule ? [{ stage, rule, value, source_clause_id: source.clause_id, source_quote: text }] : [],
    },
  };
}

test("composition projections are grounded in verbatim request text and enforced in the real evaluator requirements", () => {
  const item = constraint({ id: "material", kind: "composition", text: "No leather", rule: "excluded_material", value: "leather", stage: "composition", literals: [negation()] });
  const routes = [route("material", "composition", ["composition"])];
  assert.equal(validateShoppingConstraintBindings({ constraints: [item.value], clauses: [item.source], constraint_routes: routes }), true);
  assert.doesNotThrow(() => validateShoppingConstraintProjectionInput("composition", item.value, { requirements: { excluded_materials: [{ name: "Leather" }] } }));
  assert.throws(() => validateShoppingConstraintProjectionInput("composition", item.value, { requirements: { excluded_materials: [{ name: "wool" }] } }), { code: "shopping_constraint_input_mismatch" });

  const substituted = structuredClone(item.value);
  substituted.evaluator_bindings[0].value = "wool";
  assert.throws(() => validateShoppingConstraintBindings({ constraints: [substituted], clauses: [item.source], constraint_routes: routes }), { code: "shopping_constraint_projection_source" });
  const inventedQuote = structuredClone(item.value);
  inventedQuote.evaluator_bindings[0].source_quote = "No leather or wool";
  assert.throws(() => validateShoppingConstraintBindings({ constraints: [inventedQuote], clauses: [item.source], constraint_routes: routes }), { code: "shopping_constraint_projection_source" });
});

test("hard domain constraints cannot route without an exact evaluator projection", () => {
  const item = constraint({ id: "privacy", kind: "privacy", text: "Do not sell my data", rule: null, value: "data sale", stage: "privacy", literals: [negation("e")] });
  assert.throws(() => validateShoppingConstraintBindings({ constraints: [item.value], clauses: [item.source], constraint_routes: [route("privacy", "privacy", ["privacy"])] }), { code: "shopping_constraint_projection_missing" });
});

test("a binding cannot map request text onto a different allowlisted rule in the same domain", () => {
  const item = constraint({ id: "privacy", kind: "privacy", text: "Do not allow data sale", rule: "prohibit_targeted_ads", value: true, stage: "privacy", literals: [negation("a")] });
  assert.throws(() => validateShoppingConstraintBindings({ constraints: [item.value], clauses: [item.source], constraint_routes: [route("privacy", "privacy", ["privacy"])] }), { code: "shopping_constraint_projection_source" });
});

test("privacy, merchant, and fulfillment booleans must appear in their deterministic evaluator inputs", () => {
  const cases = [
    { item: constraint({ id: "privacy", kind: "privacy", text: "Do not allow data sale", rule: "prohibit_data_sale", value: true, stage: "privacy", literals: [negation("d")] }), stage: "privacy", good: { requirements: { prohibit_data_sale: true } }, bad: { requirements: { prohibit_data_sale: false } } },
    { item: constraint({ id: "merchant", kind: "merchant", text: "Require reversible payment", rule: "reversible_payment_required", value: true, stage: "merchant" }), stage: "merchant", good: { requirements: { reversible_payment_required: true } }, bad: { requirements: {} } },
    { item: constraint({ id: "tracking", kind: "fulfillment", text: "Tracking is required", rule: "require_tracking", value: true, stage: "fulfillment" }), stage: "fulfillment", good: { requirements: { require_tracking: true } }, bad: { requirements: { require_tracking: false } } },
  ];
  for (const { item, stage, good, bad } of cases) {
    const routes = [route(item.value.id, item.value.kind, [stage])];
    assert.equal(validateShoppingConstraintBindings({ constraints: [item.value], clauses: [item.source], constraint_routes: routes }), true);
    assert.doesNotThrow(() => validateShoppingConstraintProjectionInput(stage, item.value, good));
    assert.throws(() => validateShoppingConstraintProjectionInput(stage, item.value, bad), { code: "shopping_constraint_input_mismatch" });
  }
});

test("authorized-seller-only language projects into the counterfeit evaluator, not a raw merchant flag", () => {
  const source = { ...clause("z", "Use an authorized seller only"), start: 0, end: 29, literal_facts: [] };
  const item = { id: "authorized", kind: "merchant", requirement: source.text, value: "authorized seller", hard_gate: true, source_clause_ids: [source.clause_id], literal_bindings: [], evaluator_bindings: [] };
  const routes = [route("authorized", "merchant", ["counterfeit"])];
  const [derived] = materializeShoppingConstraintBindings({ constraints: [item], clauses: [source], constraint_routes: routes, market_country_code: "US" });
  assert.deepEqual(derived.evaluator_bindings, [{ stage: "counterfeit", rule: "authorized_seller_required", value: true, source_clause_id: source.clause_id, source_quote: source.text }]);
  assert.equal(validateShoppingConstraintBindings({ constraints: [derived], clauses: [source], constraint_routes: routes }), true);
  assert.doesNotThrow(() => validateShoppingConstraintProjectionInput("counterfeit", derived, { requirements: { authorized_seller_required: true } }));
  assert.throws(() => validateShoppingConstraintProjectionInput("counterfeit", derived, { requirements: { authorized_seller_required: false } }), { code: "shopping_constraint_input_mismatch" });
});

test("condition constraints bind both condition assessment and checkout continuity", () => {
  const source = clause("c", "Only new condition");
  const item = {
    id: "condition", kind: "condition", requirement: source.text, value: "new", hard_gate: true, source_clause_ids: [source.clause_id], literal_bindings: [],
    evaluator_bindings: [
      { stage: "condition", rule: "allowed_condition", value: "new", source_clause_id: source.clause_id, source_quote: source.text },
      { stage: "checkout", rule: "allowed_condition", value: "new", source_clause_id: source.clause_id, source_quote: source.text },
    ],
  };
  const routes = [route("condition", "condition", ["condition", "checkout"])];
  assert.equal(validateShoppingConstraintBindings({ constraints: [item], clauses: [source], constraint_routes: routes }), true);
  assert.doesNotThrow(() => validateShoppingConstraintProjectionInput("condition", item, { requirements: { allowed_conditions: ["new"] } }));
  assert.throws(() => validateShoppingConstraintProjectionInput("condition", item, { requirements: { allowed_conditions: ["new", "used"] } }), { code: "shopping_constraint_input_mismatch" });
  assert.doesNotThrow(() => validateShoppingConstraintProjectionInput("checkout", item, { expected: { condition: "new" } }));
  assert.throws(() => validateShoppingConstraintProjectionInput("checkout", item, { expected: { condition: "used" } }), { code: "shopping_constraint_input_mismatch" });
});

test("numeric and certification projections preserve canonical values and exact schemes", () => {
  const battery = constraint({ id: "battery", kind: "condition", text: "At least 90 percent battery health", rule: "min_battery_health_percent", value: 90, stage: "condition", literals: [numberLiteral("b", 90, "%")] });
  const batteryRoutes = [route("battery", "condition", ["condition"])];
  assert.equal(validateShoppingConstraintBindings({ constraints: [battery.value], clauses: [battery.source], constraint_routes: batteryRoutes }), true);
  assert.doesNotThrow(() => validateShoppingConstraintProjectionInput("condition", battery.value, { requirements: { min_battery_health_percent: 90 } }));
  assert.throws(() => validateShoppingConstraintProjectionInput("condition", battery.value, { requirements: { min_battery_health_percent: 80 } }), { code: "shopping_constraint_input_mismatch" });

  const safetySource = clause("s", "Must have UL certification");
  const safety = { id: "cert", kind: "safety", requirement: safetySource.text, value: "UL", hard_gate: true, source_clause_ids: [safetySource.clause_id], literal_bindings: [], evaluator_bindings: [{ stage: "safety", rule: "certification_requirement", value: { scheme: "UL", jurisdiction: "US" }, source_clause_id: safetySource.clause_id, source_quote: safetySource.text }] };
  const safetyRoutes = [route("cert", "safety", ["safety"])];
  assert.equal(validateShoppingConstraintBindings({ constraints: [safety], clauses: [safetySource], constraint_routes: safetyRoutes }), true);
  assert.doesNotThrow(() => validateShoppingConstraintProjectionInput("safety", safety, { certification_requirements: [{ scheme: "UL", jurisdiction: "US" }] }));
  assert.throws(() => validateShoppingConstraintProjectionInput("safety", safety, { certification_requirements: [{ scheme: "CE", jurisdiction: "US" }] }), { code: "shopping_constraint_input_mismatch" });
});

test("the process derives common evaluator bindings and rejects caller-authored alternatives", () => {
  const source = { ...clause("a", "No leather"), start: 0, end: 10, literal_facts: [{ ...negation("a"), start: 0, end: 2 }] };
  const material = { id: "material", kind: "composition", requirement: "Excluded material", value: "leather", hard_gate: true, source_clause_ids: [source.clause_id], literal_bindings: [negation("a")], evaluator_bindings: [] };
  const routes = [route("material", "composition", ["composition"])];
  const derived = materializeShoppingConstraintBindings({ constraints: [material], clauses: [source], constraint_routes: routes, market_country_code: "US" });
  assert.deepEqual(derived[0].evaluator_bindings, [{ stage: "composition", rule: "excluded_material", value: "leather", source_clause_id: source.clause_id, source_quote: "No leather" }]);
  const callerSubstitution = structuredClone(material);
  callerSubstitution.evaluator_bindings = [{ ...derived[0].evaluator_bindings[0], value: "wool" }];
  assert.throws(() => materializeShoppingConstraintBindings({ constraints: [callerSubstitution], clauses: [source], constraint_routes: routes, market_country_code: "US" }), { code: "shopping_constraint_projection_mismatch" });
  const misleadingSummary = { ...material, value: "no", evaluator_bindings: [] };
  const processGrounded = materializeShoppingConstraintBindings({ constraints: [misleadingSummary], clauses: [source], constraint_routes: routes, market_country_code: "US" });
  assert.throws(() => validateShoppingConstraintBindings({ constraints: processGrounded, clauses: [source], constraint_routes: routes }), { code: "shopping_constraint_projection_source" });
});

test("condition, privacy, fulfillment, and certification bindings are process-generated per routed stage", () => {
  const privacySource = { ...clause("b", "Do not allow data sale"), start: 0, end: 22, literal_facts: [{ ...negation("b"), start: 0, end: 2 }] };
  const conditionSource = { ...clause("c", "Only new condition"), start: 0, end: 18, literal_facts: [] };
  const fulfillmentSource = { ...clause("d", "Tracking and delivery are required"), start: 0, end: 34, literal_facts: [] };
  const safetySource = { ...clause("e", "Must have UL certification"), start: 0, end: 26, literal_facts: [] };
  const constraints = [
    { id: "privacy", kind: "privacy", requirement: privacySource.text, value: "data sale", hard_gate: true, source_clause_ids: [privacySource.clause_id], literal_bindings: [negation("b")], evaluator_bindings: [] },
    { id: "condition", kind: "condition", requirement: conditionSource.text, value: "new", hard_gate: true, source_clause_ids: [conditionSource.clause_id], literal_bindings: [], evaluator_bindings: [] },
    { id: "delivery", kind: "fulfillment", requirement: fulfillmentSource.text, value: "tracking and delivery", hard_gate: true, source_clause_ids: [fulfillmentSource.clause_id], literal_bindings: [], evaluator_bindings: [] },
    { id: "cert", kind: "safety", requirement: safetySource.text, value: "UL", hard_gate: true, source_clause_ids: [safetySource.clause_id], literal_bindings: [], evaluator_bindings: [] },
  ];
  const routes = [route("privacy", "privacy", ["privacy"]), route("condition", "condition", ["condition", "checkout"]), route("delivery", "fulfillment", ["fulfillment"]), route("cert", "safety", ["safety"])];
  const derived = materializeShoppingConstraintBindings({ constraints, clauses: [privacySource, conditionSource, fulfillmentSource, safetySource], constraint_routes: routes, market_country_code: "US" });
  assert.deepEqual(derived.map((item) => item.evaluator_bindings.map(({ stage, rule, value }) => ({ stage, rule, value }))), [
    [{ stage: "privacy", rule: "prohibit_data_sale", value: true }],
    [{ stage: "condition", rule: "allowed_condition", value: ["new"] }, { stage: "checkout", rule: "allowed_condition", value: ["new"] }],
    [{ stage: "fulfillment", rule: "require_tracking", value: true }, { stage: "fulfillment", rule: "delivery_evidence_required", value: true }],
    [{ stage: "safety", rule: "certification_requirement", value: { scheme: "UL", jurisdiction: "US" } }],
  ]);
});
