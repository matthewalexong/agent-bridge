import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { runShoppingEvaluatorBatch, SHOPPING_EVALUATOR_STAGES } from "../lib/shopping-evaluator-batch.mjs";
import { validateShoppingConstraintJob } from "../lib/shopping-constraint-routing.mjs";

function definition(stage, schema, handler) {
  return { stage, schema, handler };
}

test("evaluator batch starts independent jobs concurrently and preserves input order", async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = new Map([
    ["shopping_compatibility_assess", definition("compatibility", z.object({ value: z.number().int() }), async (input) => { started.push(input.value); await gate; return { structuredContent: { value: input.value } }; })],
    ["shopping_value_assess", definition("value", z.object({ value: z.number().int() }), async (input) => { started.push(input.value); await gate; return { structuredContent: { value: input.value } }; })],
    ["shopping_safety_assess", definition("safety", z.object({ value: z.number().int() }), async (input) => { started.push(input.value); await gate; return { structuredContent: { value: input.value } }; })],
  ]);
  const running = runShoppingEvaluatorBatch({
    max_concurrency: 3,
    required_stages: ["product_evidence", "safety", "compatibility", "value"],
    jobs: [
      { job_id: "compat", tool: "shopping_compatibility_assess", arguments: { value: 1 } },
      { job_id: "value", tool: "shopping_value_assess", arguments: { value: 2 } },
      { job_id: "safety", tool: "shopping_safety_assess", arguments: { value: 3 } },
    ],
  }, registry);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3]);
  release();
  const result = await running;
  assert.deepEqual(result.results.map((item) => item.job_id), ["compat", "value", "safety"]);
  assert.equal(result.wave.evaluation_wave_complete, true);
  assert.deepEqual(result.dossier_requirements.completed_in_this_wave, ["safety", "compatibility", "value"]);
  assert.deepEqual(result.dossier_requirements.not_in_this_wave, ["product_evidence"]);
  assert.equal(result.readiness.recommendation_ready, false);
  assert.equal(result.readiness.dossier_composition_required, true);
  assert.equal(result.decision_context_ref, null);
});

test("evaluator dependency graph runs ready layers concurrently and binds complete upstream results", async () => {
  const started = [];
  const observed = {};
  const registry = new Map([
    ["shopping_identity_resolve", definition("identity", z.object({}), async () => { started.push("identity"); return { structuredContent: { artifact: "identity" } }; })],
    ["shopping_safety_assess", definition("safety", z.object({}), async () => { started.push("safety"); return { structuredContent: { artifact: "safety" } }; })],
    ["shopping_merchant_trust", definition("merchant", z.object({ identity: z.object({ artifact: z.literal("identity") }) }), async (input) => { started.push("merchant"); observed.merchant = input; return { structuredContent: { artifact: "merchant" } }; })],
    ["shopping_counterfeit_assess", definition("counterfeit", z.object({ identity: z.object({ artifact: z.literal("identity") }) }), async (input) => { started.push("counterfeit"); observed.counterfeit = input; return { structuredContent: { artifact: "counterfeit" } }; })],
    ["shopping_offer_analyze", definition("offer", z.object({ merchant: z.object({ artifact: z.literal("merchant") }), counterfeit: z.object({ artifact: z.literal("counterfeit") }) }), async (input) => { started.push("offer"); observed.offer = input; return { structuredContent: { artifact: "offer" } }; })],
  ]);
  const subject = { product_id: "camera-x", offer_id: "offer-a" };
  const result = await runShoppingEvaluatorBatch({
    decision_context: subject,
    required_stages: ["identity", "safety", "merchant", "counterfeit", "offer"],
    max_concurrency: 4,
    jobs: [
      { job_id: "identity", tool: "shopping_identity_resolve", subject, arguments: {} },
      { job_id: "safety", tool: "shopping_safety_assess", subject, arguments: {} },
      { job_id: "merchant", tool: "shopping_merchant_trust", subject, arguments: {}, argument_bindings: [{ from_job_id: "identity", target_key: "identity" }] },
      { job_id: "counterfeit", tool: "shopping_counterfeit_assess", subject, arguments: {}, argument_bindings: [{ from_job_id: "identity", target_key: "identity" }] },
      { job_id: "offer", tool: "shopping_offer_analyze", subject, arguments: {}, argument_bindings: [{ from_job_id: "merchant", target_key: "merchant" }, { from_job_id: "counterfeit", target_key: "counterfeit" }] },
    ],
  }, registry);
  assert.deepEqual(started.slice(0, 2).sort(), ["identity", "safety"]);
  assert.ok(started.indexOf("merchant") > started.indexOf("identity"));
  assert.ok(started.indexOf("counterfeit") > started.indexOf("identity"));
  assert.ok(started.indexOf("offer") > started.indexOf("merchant"));
  assert.ok(started.indexOf("offer") > started.indexOf("counterfeit"));
  assert.deepEqual(observed.merchant, { identity: { artifact: "identity" } });
  assert.deepEqual(observed.offer, { merchant: { artifact: "merchant" }, counterfeit: { artifact: "counterfeit" } });
  assert.deepEqual(result.results.map((item) => item.status), Array(5).fill("complete"));
  assert.deepEqual(result.results[4].dependencies, ["merchant", "counterfeit"]);
  assert.equal(result.wave.dependency_edges, 4);
  assert.equal(result.wave.dependency_layers, 3);
  assert.ok(result.wave.dependency_input_chars_saved > 0);
});

test("dependency bindings use complete internal outputs even when returned results are compact", async () => {
  let observed;
  const registry = new Map([
    ["shopping_identity_resolve", definition("identity", z.object({}), async () => ({ structuredContent: { public: "keep", signed_artifact: { complete: true } } }))],
    ["shopping_merchant_trust", definition("merchant", z.object({ identity: z.object({ signed_artifact: z.object({ complete: z.literal(true) }) }) }), async (input) => { observed = input; return { structuredContent: { ok: true } }; })],
  ]);
  const result = await runShoppingEvaluatorBatch({
    result_mode: "compact",
    stage_adapter: ({ tool }) => ({ stage: SHOPPING_EVALUATOR_STAGES[tool] }),
    result_compactor: ({ result }) => ({ public: result.public }),
    jobs: [
      { job_id: "identity", tool: "shopping_identity_resolve", arguments: {} },
      { job_id: "merchant", tool: "shopping_merchant_trust", arguments: {}, argument_bindings: [{ from_job_id: "identity", target_key: "identity" }] },
    ],
  }, registry);
  assert.deepEqual(result.results[0].result, { public: "keep" });
  assert.deepEqual(observed, { identity: { signed_artifact: { complete: true } } });
  assert.equal(result.results[1].status, "complete");
  assert.ok(result.wave.dependency_input_chars_saved > JSON.stringify(result.results[0].result).length);
});

test("failed dependencies suppress downstream execution", async () => {
  let downstreamExecutions = 0;
  const registry = new Map([
    ["shopping_identity_resolve", definition("identity", z.object({}), async () => { throw Object.assign(new Error("identity failed"), { code: "identity_failed" }); })],
    ["shopping_merchant_trust", definition("merchant", z.object({ identity: z.object({}) }), async () => { downstreamExecutions++; return { structuredContent: {} }; })],
  ]);
  const result = await runShoppingEvaluatorBatch({ jobs: [
    { job_id: "identity", tool: "shopping_identity_resolve", arguments: {} },
    { job_id: "merchant", tool: "shopping_merchant_trust", arguments: {}, argument_bindings: [{ from_job_id: "identity", target_key: "identity" }] },
  ] }, registry);
  assert.equal(result.results[0].error.code, "identity_failed");
  assert.equal(result.results[1].error.code, "shopping_evaluator_dependency_failed");
  assert.equal(result.results[1].duration_ms, 0);
  assert.equal(result.wave.avoided_executions, 1);
  assert.equal(downstreamExecutions, 0);
});

test("dependency graph rejects unknown sources, cycles, duplicate targets, and caller overwrites", async () => {
  const registry = new Map([["shopping_value_assess", definition("value", z.object({}), async () => ({ structuredContent: {} }))]]);
  const job = (id, argument_bindings = [], args = {}) => ({ job_id: id, tool: "shopping_value_assess", arguments: args, argument_bindings });
  await assert.rejects(() => runShoppingEvaluatorBatch({ jobs: [job("a", [{ from_job_id: "missing", target_key: "value" }])] }, registry), { code: "shopping_evaluator_dependency_invalid" });
  await assert.rejects(() => runShoppingEvaluatorBatch({ jobs: [job("a", [{ from_job_id: "b", target_key: "one" }]), job("b", [{ from_job_id: "a", target_key: "two" }])] }, registry), { code: "shopping_evaluator_dependency_cycle" });
  await assert.rejects(() => runShoppingEvaluatorBatch({ jobs: [job("a"), job("b", [{ from_job_id: "a", target_key: "same" }, { from_job_id: "a", target_key: "same" }])] }, registry), { code: "shopping_evaluator_dependency_invalid" });
  await assert.rejects(() => runShoppingEvaluatorBatch({ jobs: [job("a"), job("b", [{ from_job_id: "a", target_key: "value" }], { value: "caller" })] }, registry), { code: "shopping_evaluator_dependency_overwrite" });
  await assert.rejects(() => runShoppingEvaluatorBatch({ jobs: [job("a"), job("b", [{ from_job_id: "a", target_key: "constructor" }])] }, registry), { code: "shopping_evaluator_dependency_invalid" });
  await assert.rejects(() => runShoppingEvaluatorBatch({ jobs: [job("a"), { ...job("b"), argument_bindings: Array(25).fill({ from_job_id: "a", target_key: "value" }) }] }, registry), { code: "shopping_evaluator_dependency_invalid" });
});

test("evaluator batch can suppress a repeated full context while retaining its compact reference", async () => {
  const decision_context = { context_id: `shopping_context_${"a".repeat(32)}` };
  const registry = new Map([["shopping_value_assess", definition("value", z.object({}), async () => ({ structuredContent: { action: "comparable" } }))]]);
  const result = await runShoppingEvaluatorBatch({ include_decision_context: false, decision_context, jobs: [{ job_id: "value", tool: "shopping_value_assess", arguments: {} }] }, registry);
  assert.equal("decision_context" in result, false);
  assert.deepEqual(result.decision_context_ref, { context_id: decision_context.context_id });
});

test("evaluator batch never starts more jobs than its concurrency bound", async () => {
  const started = [];
  const releases = [];
  const registry = new Map([["shopping_value_assess", definition("value", z.object({ value: z.number().int() }), async (input) => {
    started.push(input.value);
    await new Promise((resolve) => releases.push(resolve));
    return { structuredContent: input };
  })]]);
  const running = runShoppingEvaluatorBatch({ max_concurrency: 2, jobs: [1, 2, 3].map((value) => ({ job_id: `job-${value}`, tool: "shopping_value_assess", arguments: { value } })) }, registry);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3]);
  releases.splice(0).forEach((release) => release());
  const result = await running;
  assert.equal(result.wave.completed_jobs, 3);
  assert.equal(result.wave.max_concurrency, 2);
});

test("evaluator batch isolates validation, execution, and allowlist failures", async () => {
  const registry = new Map([
    ["shopping_compatibility_assess", definition("compatibility", z.object({ value: z.number().int() }), async (input) => ({ structuredContent: input }))],
    ["shopping_value_assess", definition("value", z.object({ value: z.number().int() }), async () => { throw Object.assign(new Error("private failure detail"), { code: "value_failed" }); })],
  ]);
  const result = await runShoppingEvaluatorBatch({
    required_stages: ["compatibility", "value"],
    jobs: [
      { job_id: "invalid-input", tool: "shopping_compatibility_assess", arguments: { value: "not-a-number" } },
      { job_id: "throws", tool: "shopping_value_assess", arguments: { value: 2 } },
      { job_id: "not-registered", tool: "shopping_safety_assess", arguments: { value: 3 } },
    ],
  }, registry);
  assert.deepEqual(result.results.map((item) => item.status), ["failed", "failed", "failed"]);
  assert.equal(result.results[1].error.code, "value_failed");
  assert.equal(result.results[2].error.code, "shopping_evaluator_not_allowed");
  assert.deepEqual(result.dossier_requirements.failed_in_this_wave, ["compatibility", "value"]);
  assert.equal(result.wave.evaluation_wave_complete, false);
  assert.equal(result.readiness.purchase_allowed, false);
});

test("evaluator batch rejects duplicate job IDs and invalid bounds", async () => {
  await assert.rejects(() => runShoppingEvaluatorBatch({ jobs: [
    { job_id: "same", tool: "shopping_value_assess", arguments: {} },
    { job_id: "same", tool: "shopping_value_assess", arguments: {} },
  ] }, new Map()), { code: "shopping_evaluator_batch_invalid" });
  await assert.rejects(() => runShoppingEvaluatorBatch({ jobs: [{ job_id: "one", tool: "shopping_value_assess", arguments: {} }], max_concurrency: 9 }, new Map()), { code: "shopping_evaluator_batch_invalid" });
});

test("evaluator allowlist excludes state mutation, evidence capture, and final authority", () => {
  for (const name of [
    "shopping_decision_dossier", "shopping_profile_remember", "shopping_watch_create",
    "shopping_case_create", "shopping_page_evidence", "shopping_checkout_evidence", "shopping_request_intake",
  ]) assert.equal(name in SHOPPING_EVALUATOR_STAGES, false);
  assert.equal(SHOPPING_EVALUATOR_STAGES.shopping_safety_assess, "safety");
  assert.equal(SHOPPING_EVALUATOR_STAGES.shopping_offer_analyze, "offer");
});

test("evaluator batch fails oversized output closed without returning a partial artifact", async () => {
  const registry = new Map([["shopping_value_assess", definition("value", z.object({}), async () => ({ structuredContent: { payload: "x".repeat(2_000), gate: "eligible" } }))]]);
  const result = await runShoppingEvaluatorBatch({
    max_result_chars: 1_000,
    required_stages: ["value"],
    stage_adapter: () => ({ stage: "value", should_not_escape: true }),
    jobs: [{ job_id: "large", tool: "shopping_value_assess", arguments: {} }],
  }, registry);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].error.code, "shopping_evaluator_result_too_large");
  assert.equal("result" in result.results[0], false);
  assert.equal("dossier_stage" in result.results[0], false);
  assert.equal(result.wave.output_chars, 0);
  assert.equal(result.wave.evaluation_wave_complete, false);
});

test("evaluator batch rejects a claimed domain constraint when the actual evaluator requirement was substituted", async () => {
  const context = {
    constraints: [{ id: "material", kind: "composition", hard_gate: true, source_clause_ids: ["clause_a"], literal_bindings: [{ kind: "negation", operator: "not_allowed", value: false }], evaluator_bindings: [{ stage: "composition", rule: "excluded_material", value: "leather", source_clause_id: "clause_a", source_quote: "No leather" }] }],
    constraint_routes: [{ constraint_id: "material", kind: "composition", status: "active", stages: ["composition"], deferred_until: null }],
  };
  let executions = 0;
  const registry = new Map([["shopping_composition_assess", definition("composition", z.object({ requirements: z.object({ excluded_materials: z.array(z.object({ name: z.string() })) }) }), async () => { executions++; return { structuredContent: { assessments: [] } }; })]]);
  const stage_adapter = ({ constraint_ids }) => ({ stage: "composition", consumed_constraint_ids: constraint_ids });
  const run = (name) => runShoppingEvaluatorBatch({ decision_context: context, constraint_validator: validateShoppingConstraintJob, stage_adapter, jobs: [{ job_id: name, tool: "shopping_composition_assess", subject: { product_id: "camera-x" }, constraint_ids: ["material"], arguments: { requirements: { excluded_materials: [{ name }] } } }] }, registry);
  const valid = await run("leather");
  assert.equal(valid.results[0].status, "complete");
  assert.deepEqual(valid.results[0].dossier_stage.consumed_constraint_ids, ["material"]);
  const substituted = await run("wool");
  assert.equal(substituted.results[0].status, "failed");
  assert.equal(substituted.results[0].error.code, "shopping_constraint_input_mismatch");
  assert.equal(executions, 1);
});

test("decision waves reject irrelevant, duplicate, and wrong-subject jobs before execution", async () => {
  let executions = 0;
  const registry = new Map([
    ["shopping_safety_assess", definition("safety", z.object({}), async () => { executions++; return { structuredContent: {} }; })],
    ["shopping_compatibility_assess", definition("compatibility", z.object({}), async () => { executions++; return { structuredContent: {} }; })],
    ["shopping_counterfeit_assess", definition("counterfeit", z.object({}), async () => { executions++; return { structuredContent: {} }; })],
  ]);
  const result = await runShoppingEvaluatorBatch({
    decision_context: { product_id: "camera-x", offer_id: null },
    required_stages: ["safety"],
    jobs: [
      { job_id: "safety-a", tool: "shopping_safety_assess", subject: { product_id: "camera-x" }, arguments: {} },
      { job_id: "safety-b", tool: "shopping_safety_assess", subject: { product_id: "camera-x" }, arguments: {} },
      { job_id: "skipped", tool: "shopping_compatibility_assess", subject: { product_id: "camera-x" }, arguments: {} },
      { job_id: "wrong", tool: "shopping_counterfeit_assess", subject: { product_id: "camera-y", offer_id: "offer-y" }, arguments: {} },
    ],
  }, registry);
  assert.equal(executions, 0);
  assert.deepEqual(result.results.map((item) => item.error.code), [
    "shopping_evaluator_stage_duplicate",
    "shopping_evaluator_stage_duplicate",
    "shopping_evaluator_stage_not_applicable",
    "shopping_evaluator_stage_not_applicable",
  ]);
  assert.equal(result.wave.avoided_executions, 4);
  assert.equal(Number.isFinite(result.wave.wall_time_ms), true);
  assert.ok(result.results.every((item) => item.duration_ms === 0));
});

test("offer-scoped wave jobs must bind the exact context offer before execution", async () => {
  let executions = 0;
  const registry = new Map([["shopping_counterfeit_assess", definition("counterfeit", z.object({}), async () => { executions++; return { structuredContent: {} }; })]]);
  const result = await runShoppingEvaluatorBatch({
    decision_context: { product_id: "camera-x", offer_id: "offer-a" },
    required_stages: ["counterfeit"],
    jobs: [{ job_id: "wrong-offer", tool: "shopping_counterfeit_assess", subject: { product_id: "camera-x", offer_id: "offer-b" }, arguments: {} }],
  }, registry);
  assert.equal(executions, 0);
  assert.equal(result.results[0].error.code, "shopping_evaluator_subject_mismatch");
  assert.equal(result.wave.avoided_executions, 1);
});

test("evaluator batch validates signed exact-offer bindings before executing a handler", async () => {
  let executions = 0;
  const registry = new Map([["shopping_counterfeit_assess", definition("counterfeit", z.object({ offers: z.array(z.object({ id: z.string(), listing_evidence: z.object({ marker: z.string() }) })) }), async () => { executions++; return { structuredContent: {} }; })]]);
  const result = await runShoppingEvaluatorBatch({
    jobs: [{ job_id: "counterfeit", tool: "shopping_counterfeit_assess", arguments: { offers: [{ id: "offer-a", listing_evidence: { marker: "wrong" } }] } }],
    offer_binding_validator: () => { throw Object.assign(new Error("substituted evidence"), { code: "shopping_candidate_offer_evidence_mismatch" }); },
  }, registry);
  assert.equal(executions, 0);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].error.code, "shopping_candidate_offer_evidence_mismatch");
});

test("evaluator batch projects process-owned offer evidence before production schema parsing", async () => {
  let observed;
  const registry = new Map([["shopping_counterfeit_assess", definition("counterfeit", z.object({ offers: z.array(z.object({ id: z.string(), listing_evidence: z.object({ signed: z.literal(true) }) })) }), async (input) => { observed = input; return { structuredContent: {} }; })]]);
  const result = await runShoppingEvaluatorBatch({
    jobs: [{ job_id: "compact", tool: "shopping_counterfeit_assess", arguments: { offers: [{ id: "offer-a" }] } }],
    offer_input_projector: ({ input }) => ({ ...input, offers: input.offers.map((offer) => ({ ...offer, listing_evidence: { signed: true } })) }),
  }, registry);
  assert.equal(result.results[0].status, "complete");
  assert.deepEqual(observed, { offers: [{ id: "offer-a", listing_evidence: { signed: true } }] });
});

test("evaluator batch compacts exact-subject results by default and preserves explicit full diagnostics", async () => {
  const payload = { assessments: [{ id: "camera-x", detail: "selected" }, { id: "camera-y", detail: "other" }], warnings: ["keep me"] };
  const registry = new Map([["shopping_compatibility_assess", definition("compatibility", z.object({}), async () => ({ structuredContent: payload }))]]);
  const stage_adapter = () => ({ stage: "compatibility" });
  const result_compactor = ({ subject, result }) => ({ ...result, assessments: result.assessments.filter((item) => item.id === subject.product_id) });
  const job = { job_id: "compat", tool: "shopping_compatibility_assess", subject: { product_id: "camera-x" }, arguments: {} };
  const compact = await runShoppingEvaluatorBatch({ jobs: [job], stage_adapter, result_compactor }, registry);
  assert.equal(compact.results[0].result.assessments.length, 1);
  assert.deepEqual(compact.results[0].result.warnings, ["keep me"]);
  assert.ok(compact.results[0].result_compaction.saved_chars > 0);
  assert.equal(compact.wave.saved_result_chars, compact.results[0].result_compaction.saved_chars);
  const full = await runShoppingEvaluatorBatch({ jobs: [job], stage_adapter, result_compactor, result_mode: "full" }, registry);
  assert.equal(full.results[0].result.assessments.length, 2);
  assert.equal(full.results[0].result_compaction.saved_chars, 0);
  assert.equal(full.wave.result_mode, "full");
});
