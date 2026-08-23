import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { createShoppingDecisionContext as createShoppingDecisionContextProduction, verifyShoppingDecisionContext } from "../lib/shopping-decision-context.mjs";
import { validateShoppingConstraintJob } from "../lib/shopping-constraint-routing.mjs";
import { adaptShoppingEvaluatorResult } from "../lib/shopping-dossier-stage.mjs";
import { composeShoppingDossier } from "../lib/shopping-dossier.mjs";
import { issueShoppingRequestReceipt } from "../lib/shopping-request-intent.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const createShoppingDecisionContext = (value) => createShoppingDecisionContextProduction(value, () => Date.parse(NOW));
const skipped = (reason = "Not applicable to this exact-product fixture.") => ({ required: false, reason });
const binding = ({ literal_id, kind, operator, value, unit }) => ({ literal_id, kind, operator, value, unit });
const applicability = (overrides = {}) => ({ ...Object.fromEntries(["candidate_coverage", "performance", "value", "condition", "promotion", "review_integrity", "composition", "privacy", "compatibility", "lifecycle", "preferences", "ownership", "deal"].map((name) => [name, skipped()])), ...overrides });
const receipt = (revision = 1, text = "Choose a camera. Keep the landed price under $1000.") => issueShoppingRequestReceipt({ request_id: "message-123", request_revision: revision, text, captured_at: NOW });
const input = (overrides = {}) => {
  const request_receipt = overrides.request_receipt || receipt();
  const [objectiveClause, budgetClause] = request_receipt.clauses.map((item) => item.clause_id);
  const budgetBinding = request_receipt.clauses[1]?.literal_facts.map(binding) || [];
  return { request_receipt, profile_state_revision: 7, phase: "product_recommendation", product_id: "camera-x", offer_id: null, objective: "Choose a camera.", objective_clause_ids: [objectiveClause], clause_dispositions: [{ clause_id: objectiveClause, role: "objective" }, { clause_id: budgetClause, role: "constraint", constraint_ids: ["budget"] }], market_country_code: "US", destination: { country_code: "US", region: "CA" }, constraints: [{ id: "budget", kind: "budget", requirement: "Maximum landed price", value: "USD 1000", hard_gate: true, source_clause_ids: [budgetClause], literal_bindings: budgetBinding }], applicability: applicability({ preferences: { required: true } }), max_age_seconds: 3_600, ...overrides };
};

test("decision context binds every decision-relevant request revision", () => {
  const first = createShoppingDecisionContext(input());
  const identical = createShoppingDecisionContext(input());
  assert.equal(first.context_id, identical.context_id);
  assert.equal(first.evaluated_at, NOW);
  assert.equal(createShoppingDecisionContext(input({ evaluated_at: "2099-01-01T00:00:00.000Z" })).context_id, first.context_id);
  assert.equal(verifyShoppingDecisionContext(first, NOW), true);
  assert.deepEqual(first.constraint_routes, [{ constraint_id: "budget", kind: "budget", status: "active", stages: ["preferences"], deferred_until: null }]);
  assert.match(first.artifact_attestation, /^v1\.decision_context\.[a-f0-9]{64}$/);

  for (const changed of [
    input({ request_receipt: receipt(2) }),
    input({ profile_state_revision: 8 }),
    input({ destination: { country_code: "CA" } }),
    input({ market_country_code: "CA" }),
    input({ constraints: [{ ...input().constraints[0], value: "USD 900" }] }),
    input({ applicability: applicability({ preferences: { required: true }, privacy: { required: true } }) }),
  ]) assert.notEqual(createShoppingDecisionContext(changed).context_id, first.context_id);
});

test("decision context carries authorized-seller-only language into the exact counterfeit job", () => {
  const request_receipt = receipt(1, "Find the camera from an authorized seller only.");
  const clause = request_receipt.clauses[0];
  const context = createShoppingDecisionContext(input({
    request_receipt,
    phase: "offer_recommendation",
    offer_id: "offer-a",
    objective: "Find the camera.",
    objective_clause_ids: [clause.clause_id],
    clause_dispositions: [{ clause_id: clause.clause_id, role: "objective_and_constraint", constraint_ids: ["authorized"] }],
    constraints: [{ id: "authorized", kind: "merchant", requirement: "Authorized seller only", value: "authorized seller", hard_gate: true, source_clause_ids: [clause.clause_id], literal_bindings: [] }],
    applicability: applicability(),
  }));
  assert.equal(verifyShoppingDecisionContext(context, NOW), true);
  assert.deepEqual(context.constraint_routes, [{ constraint_id: "authorized", kind: "merchant", status: "active", stages: ["counterfeit"], deferred_until: null }]);
  assert.deepEqual(context.constraints[0].evaluator_bindings.map(({ stage, rule, value }) => ({ stage, rule, value })), [{ stage: "counterfeit", rule: "authorized_seller_required", value: true }]);
  assert.deepEqual(validateShoppingConstraintJob({
    decision_context: context,
    stage: "counterfeit",
    constraint_ids: ["authorized"],
    input: { requirements: { authorized_seller_required: true } },
  }), ["authorized"]);
  assert.throws(() => validateShoppingConstraintJob({
    decision_context: context,
    stage: "counterfeit",
    constraint_ids: ["authorized"],
    input: { requirements: { authorized_seller_required: false } },
  }), { code: "shopping_constraint_input_mismatch" });
});

test("decision context rejects mutation, expiry, invalid scope, and process restart", () => {
  const context = createShoppingDecisionContext(input());
  for (const mutate of [
    (value) => { value.objective = "Different objective"; },
    (value) => { value.product_id = "camera-y"; },
    (value) => { value.constraints[0].value = "USD 2000"; },
    (value) => { value.constraint_routes[0].stages = ["safety"]; },
    (value) => { value.context_id = `shopping_context_${"0".repeat(32)}`; },
  ]) {
    const changed = structuredClone(context);
    mutate(changed);
    assert.equal(verifyShoppingDecisionContext(changed, NOW), false);
  }
  assert.equal(verifyShoppingDecisionContext(context, "2026-08-22T21:00:01.000Z"), false);
  assert.throws(() => createShoppingDecisionContext(input({ phase: "offer_recommendation", offer_id: null })), { code: "shopping_decision_context_scope" });

  const moduleUrl = new URL("../lib/shopping-decision-context.mjs", import.meta.url).href;
  const script = `import { verifyShoppingDecisionContext } from ${JSON.stringify(moduleUrl)}; const artifact = JSON.parse(process.argv[1]); process.stdout.write(String(verifyShoppingDecisionContext(artifact, ${JSON.stringify(NOW)})));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(context)], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "false");
});

test("decision context cannot silently omit or misclassify hinted request constraints", () => {
  const single = receipt(1, "Find a camera under $500.");
  const singleClause = single.clauses[0].clause_id;
  const singleContext = input({ request_receipt: single, objective: "Find a camera.", objective_clause_ids: [singleClause], clause_dispositions: [{ clause_id: singleClause, role: "objective_and_constraint", constraint_ids: ["budget"] }], constraints: [{ id: "budget", kind: "budget", requirement: "Maximum price", value: "USD 500", hard_gate: true, source_clause_ids: [singleClause], literal_bindings: single.clauses[0].literal_facts.map(binding) }] });
  assert.equal(verifyShoppingDecisionContext(createShoppingDecisionContext(singleContext), NOW), true);
  for (const mutate of [
    (value) => { value.constraints[0].literal_bindings[0].value = 5_000; },
    (value) => { value.constraints[0].literal_bindings[0].operator = "gte"; },
    (value) => { value.constraints[0].literal_bindings[0].unit = "EUR"; },
  ]) {
    const changed = structuredClone(singleContext);
    mutate(changed);
    assert.throws(() => createShoppingDecisionContext(changed), { code: "shopping_decision_context_literal_mismatch" });
  }
  const missingLiteral = structuredClone(singleContext);
  missingLiteral.constraints[0].literal_bindings = [];
  assert.throws(() => createShoppingDecisionContext(missingLiteral), { code: "shopping_decision_context_literal_omitted" });
  const ambiguous = receipt(1, "Find a camera with a $500 budget.");
  const ambiguousClause = ambiguous.clauses[0].clause_id;
  const ambiguousContext = input({ request_receipt: ambiguous, objective: "Find a camera.", objective_clause_ids: [ambiguousClause], clause_dispositions: [{ clause_id: ambiguousClause, role: "objective_and_constraint", constraint_ids: ["budget"] }], constraints: [{ id: "budget", kind: "budget", requirement: "Budget", value: "USD 500", hard_gate: true, source_clause_ids: [ambiguousClause], literal_bindings: ambiguous.clauses[0].literal_facts.map(binding) }] });
  assert.throws(() => createShoppingDecisionContext(ambiguousContext), { code: "shopping_decision_context_literal_ambiguous" });

  const rich = receipt(1, "I need headphones. They must be under $200. They must work with my iPhone. No leather. Deliver by Friday.");
  const [objective, budget, compatibility, composition, delivery] = rich.clauses.map((item) => item.clause_id);
  const constraints = [
    { id: "budget", kind: "budget", requirement: "Maximum price", value: "USD 200", hard_gate: true, source_clause_ids: [budget], literal_bindings: rich.clauses[1].literal_facts.map(binding) },
    { id: "compat", kind: "compatibility", requirement: "Works with phone", value: "iPhone", hard_gate: true, source_clause_ids: [compatibility] },
    { id: "material", kind: "composition", requirement: "Excluded material", value: "leather", hard_gate: true, source_clause_ids: [composition], literal_bindings: rich.clauses[3].literal_facts.map(binding), evaluator_bindings: [{ stage: "composition", rule: "excluded_material", value: "leather", source_clause_id: composition, source_quote: rich.clauses[3].text }] },
    { id: "deadline", kind: "deadline", requirement: "Arrival deadline", value: "Friday", hard_gate: true, source_clause_ids: [delivery], literal_bindings: rich.clauses[4].literal_facts.map(binding) },
    { id: "delivery", kind: "fulfillment", requirement: "Delivery required", value: "by Friday", hard_gate: true, source_clause_ids: [delivery] },
  ];
  const complete = input({
    request_receipt: rich,
    product_id: "headphones-a",
    objective: "Find headphones.",
    objective_clause_ids: [objective],
    clause_dispositions: [
      { clause_id: objective, role: "objective" },
      { clause_id: budget, role: "constraint", constraint_ids: ["budget"] },
      { clause_id: compatibility, role: "constraint", constraint_ids: ["compat"] },
      { clause_id: composition, role: "constraint", constraint_ids: ["material"] },
      { clause_id: delivery, role: "constraint", constraint_ids: ["deadline", "delivery"] },
    ],
    constraints,
    applicability: applicability({ preferences: { required: true }, compatibility: { required: true }, composition: { required: true } }),
  });
  assert.equal(verifyShoppingDecisionContext(createShoppingDecisionContext(complete), NOW), true);

  const missingProjection = structuredClone(complete);
  missingProjection.constraints.find((item) => item.id === "material").evaluator_bindings = [];
  const processProjected = createShoppingDecisionContext(missingProjection);
  assert.deepEqual(processProjected.constraints.find((item) => item.id === "material").evaluator_bindings, complete.constraints.find((item) => item.id === "material").evaluator_bindings);
  const substitutedProjection = structuredClone(complete);
  substitutedProjection.constraints.find((item) => item.id === "material").evaluator_bindings[0].value = "wool";
  assert.throws(() => createShoppingDecisionContext(substitutedProjection), { code: "shopping_constraint_projection_mismatch" });

  const omitted = structuredClone(complete);
  omitted.clause_dispositions.find((item) => item.clause_id === budget).constraint_ids = ["compat"];
  assert.throws(() => createShoppingDecisionContext(omitted), { code: "shopping_decision_context_constraint_coverage" });

  const misclassified = structuredClone(complete);
  misclassified.clause_dispositions.find((item) => item.clause_id === composition).role = "context";
  delete misclassified.clause_dispositions.find((item) => item.clause_id === composition).constraint_ids;
  misclassified.clause_dispositions.find((item) => item.clause_id === composition).reason = "Background only";
  assert.throws(() => createShoppingDecisionContext(misclassified), { code: "shopping_decision_context_constraint_omitted" });

  const missingHintKind = structuredClone(complete);
  missingHintKind.clause_dispositions.find((item) => item.clause_id === delivery).constraint_ids = ["deadline"];
  missingHintKind.constraints = missingHintKind.constraints.filter((item) => item.id !== "delivery");
  assert.throws(() => createShoppingDecisionContext(missingHintKind), { code: "shopping_decision_context_constraint_omitted" });
});

test("dossier rejects otherwise-valid stages from a different request context", () => {
  const first = createShoppingDecisionContext(input());
  const revised = createShoppingDecisionContext(input({ request_receipt: receipt(2) }));
  const productEvidence = adaptShoppingEvaluatorResult({ tool: "shopping_product_evidence", subject: { product_id: "camera-x" }, decision_context: first, input: {}, evaluated_at: NOW, result: { policy: { evaluated_at: NOW }, products: [{ id: "camera-x", attribute_evidence: { model: "verified" } }] } });
  const safetySource = attestShoppingArtifact("safety", { evaluated_at: NOW, assessments: [{ id: "offer-a", product_key: "camera-x", action: "eligible", safety_cleared_for_ranking: true }] });
  const revisedSafety = adaptShoppingEvaluatorResult({ tool: "shopping_safety_assess", subject: { product_id: "camera-x", offer_id: "offer-a" }, decision_context: revised, input: { jurisdiction: "US" }, evaluated_at: NOW, result: safetySource });
  const result = composeShoppingDossier({ evaluated_at: NOW, phase: first.phase, product_id: first.product_id, applicability: first.applicability, decision_context: first, stages: { product_evidence: productEvidence, safety: revisedSafety } });
  assert.equal(result.decision.action, "block");
  assert.deepEqual(result.audit.context_mismatched, ["safety"]);
  assert.ok(result.decision.blockers.includes("decision_context_mismatch:safety"));
  assert.equal(result.clearance_attestation, null);

  const firstSafety = adaptShoppingEvaluatorResult({ tool: "shopping_safety_assess", subject: { product_id: "camera-x", offer_id: "offer-a" }, decision_context: first, input: { jurisdiction: "US" }, evaluated_at: NOW, result: safetySource });
  const staleProfile = composeShoppingDossier({ evaluated_at: NOW, current_profile_state_revision: 8, phase: first.phase, product_id: first.product_id, applicability: first.applicability, decision_context: first, stages: { product_evidence: productEvidence, safety: firstSafety } });
  assert.equal(staleProfile.decision.action, "block");
  assert.deepEqual(staleProfile.audit.invalid_context, ["profile_revision_stale"]);
});

test("decision context process-generates common domain evaluator bindings from signed clauses", () => {
  const request_receipt = receipt(1, "Find a new phone. Do not allow data sale. Tracking is required.");
  const [objective, privacy, tracking] = request_receipt.clauses;
  const raw = {
    request_receipt, profile_state_revision: 7, phase: "offer_recommendation", product_id: "phone-x", offer_id: "offer-a",
    objective: "Find a phone.", objective_clause_ids: [objective.clause_id], market_country_code: "US", destination: { country_code: "US" },
    clause_dispositions: [
      { clause_id: objective.clause_id, role: "objective_and_constraint", constraint_ids: ["condition"] },
      { clause_id: privacy.clause_id, role: "constraint", constraint_ids: ["privacy"] },
      { clause_id: tracking.clause_id, role: "constraint", constraint_ids: ["tracking"] },
    ],
    constraints: [
      { id: "condition", kind: "condition", requirement: "Allowed condition", value: "new", hard_gate: true, source_clause_ids: [objective.clause_id] },
      { id: "privacy", kind: "privacy", requirement: "Prohibit data sale", value: "data sale", hard_gate: true, source_clause_ids: [privacy.clause_id], literal_bindings: privacy.literal_facts.map(binding) },
      { id: "tracking", kind: "fulfillment", requirement: "Tracking required", value: "tracking", hard_gate: true, source_clause_ids: [tracking.clause_id] },
    ],
    applicability: applicability({ condition: { required: true }, privacy: { required: true } }),
  };
  const context = createShoppingDecisionContext(raw);
  assert.equal(verifyShoppingDecisionContext(context, NOW), true);
  assert.deepEqual(context.constraints.map((item) => [item.id, item.evaluator_bindings.map(({ stage, rule, value }) => ({ stage, rule, value }))]), [
    ["condition", [{ stage: "condition", rule: "allowed_condition", value: ["new"] }]],
    ["privacy", [{ stage: "privacy", rule: "prohibit_data_sale", value: true }]],
    ["tracking", [{ stage: "fulfillment", rule: "require_tracking", value: true }]],
  ]);
});

test("dossier rejects a signed evaluator stage that did not consume its routed constraint", () => {
  const context = createShoppingDecisionContext(input());
  const money = context.constraints[0].literal_bindings.find((item) => item.kind === "money");
  const preferenceInput = {
    constraints: [{ id: "budget", literal_id: money.literal_id, attribute: "price_usd", operator: "lt", value: money.value, unit: money.unit }],
  };
  const preferenceResult = { decision: { action: "select", selected_candidate: "camera-x" } };
  const productEvidence = adaptShoppingEvaluatorResult({ tool: "shopping_product_evidence", subject: { product_id: "camera-x" }, decision_context: context, input: {}, evaluated_at: NOW, result: { policy: { evaluated_at: NOW }, products: [{ id: "camera-x", attribute_evidence: { model: "verified" } }] } });
  const safetySource = attestShoppingArtifact("safety", { evaluated_at: NOW, assessments: [{ id: "offer-a", product_key: "camera-x", action: "eligible", safety_cleared_for_ranking: true }] });
  const safety = adaptShoppingEvaluatorResult({ tool: "shopping_safety_assess", subject: { product_id: "camera-x", offer_id: "offer-a" }, decision_context: context, input: { jurisdiction: "US" }, evaluated_at: NOW, result: safetySource });
  const ignored = adaptShoppingEvaluatorResult({ tool: "shopping_preference_rank", subject: { product_id: "camera-x" }, decision_context: context, input: preferenceInput, evaluated_at: NOW, result: preferenceResult });
  const baseDossier = { evaluated_at: NOW, phase: context.phase, product_id: context.product_id, applicability: context.applicability, decision_context: context, stages: { product_evidence: productEvidence, safety, preferences: ignored } };
  const rejected = composeShoppingDossier(baseDossier);
  assert.equal(rejected.decision.action, "block");
  assert.deepEqual(rejected.audit.unconsumed_constraints, ["budget:preferences"]);
  assert.ok(rejected.decision.blockers.includes("unconsumed_constraint:budget:preferences"));

  const consumed = adaptShoppingEvaluatorResult({ tool: "shopping_preference_rank", subject: { product_id: "camera-x" }, decision_context: context, constraint_ids: ["budget"], input: preferenceInput, evaluated_at: NOW, result: preferenceResult });
  const accepted = composeShoppingDossier({ ...baseDossier, stages: { ...baseDossier.stages, preferences: consumed } });
  assert.equal(accepted.decision.action, "recommend_product");
  assert.deepEqual(accepted.audit.unconsumed_constraints, []);
  assert.match(accepted.clearance_attestation, /^v1\.[a-f0-9]{64}$/);
});
