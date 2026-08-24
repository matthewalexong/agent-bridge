export const SHOPPING_EVALUATOR_STAGES = Object.freeze({
  shopping_candidate_coverage: "candidate_coverage",
  shopping_performance_assess: "performance",
  shopping_value_assess: "value",
  shopping_condition_assess: "condition",
  shopping_promotion_assess: "promotion",
  shopping_review_integrity: "review_integrity",
  shopping_safety_assess: "safety",
  shopping_composition_assess: "composition",
  shopping_privacy_assess: "privacy",
  shopping_compatibility_assess: "compatibility",
  shopping_lifecycle_assess: "lifecycle",
  shopping_preference_rank: "preferences",
  shopping_ownership_cost: "ownership",
  shopping_identity_resolve: "identity",
  shopping_merchant_trust: "merchant",
  shopping_counterfeit_assess: "counterfeit",
  shopping_protection_assess: "protection",
  shopping_fulfillment_assess: "fulfillment",
  shopping_offer_analyze: "offer",
  shopping_deal_quality: "deal",
  shopping_checkout_preflight: "checkout",
  shopping_checkout_consent_assess: "checkout_consent",
  shopping_product_evidence: "product_evidence",
});

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function safeError(error) {
  return {
    code: String(error?.code || "shopping_evaluator_failed").slice(0, 160),
    message: String(error?.message || "Evaluator failed").slice(0, 1_000),
  };
}

const unique = (items) => [...new Set(items)];
const OFFER_SCOPED_STAGES = new Set(["condition", "promotion", "identity", "merchant", "counterfeit", "protection", "fulfillment", "offer", "deal", "checkout", "checkout_consent"]);
const same = (left, right) => String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
const STANDARD_DEPENDENCIES = Object.freeze({
  safety: Object.freeze({ identity: "identity" }),
  merchant: Object.freeze({ identity: "identity" }),
  counterfeit: Object.freeze({ identity: "identity" }),
  protection: Object.freeze({ identity: "identity" }),
  fulfillment: Object.freeze({ identity: "identity" }),
  offer: Object.freeze({ identity: "identity", safety: "safety", merchant: "merchant", counterfeit: "counterfeit", protection: "protection", fulfillment: "fulfillment" }),
});

function preflightWaveJobs(jobs, registry, decisionContext, requiredStages) {
  const errors = new Array(jobs.length).fill(null);
  if (!decisionContext || !requiredStages.length) return errors;
  const required = new Set(requiredStages);
  const stages = jobs.map((job) => registry.get(job.tool)?.stage || SHOPPING_EVALUATOR_STAGES[job.tool] || null);
  const counts = new Map();
  for (const stage of stages) if (stage) counts.set(stage, (counts.get(stage) || 0) + 1);
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    const stage = stages[index];
    if (!stage || !required.has(stage)) {
      errors[index] = { code: "shopping_evaluator_stage_not_applicable", message: `Evaluator stage ${stage || "unknown"} is not required by this decision context` };
    } else if (counts.get(stage) > 1) {
      errors[index] = { code: "shopping_evaluator_stage_duplicate", message: `Decision wave must contain at most one ${stage} evaluator` };
    } else if (!same(job.subject?.product_id, decisionContext.product_id)) {
      errors[index] = { code: "shopping_evaluator_subject_mismatch", message: "Evaluator product subject does not match the decision context" };
    } else if (OFFER_SCOPED_STAGES.has(stage) && (!decisionContext.offer_id || !same(job.subject?.offer_id, decisionContext.offer_id))) {
      errors[index] = { code: "shopping_evaluator_subject_mismatch", message: `Evaluator stage ${stage} requires the exact offer subject from the decision context` };
    }
  }
  return errors;
}

function deriveStandardDependencies(jobs, registry, dependencyMode) {
  if (!["auto", "explicit"].includes(dependencyMode)) {
    throw coded("Evaluator dependency mode must be auto or explicit", "shopping_evaluator_batch_invalid");
  }
  const planned = jobs.map((job) => {
    if (job.argument_bindings !== undefined && !Array.isArray(job.argument_bindings)) {
      throw coded("Evaluator dependency bindings must be a bounded array", "shopping_evaluator_dependency_invalid");
    }
    return { ...job, argument_bindings: [...(job.argument_bindings || [])] };
  });
  if (dependencyMode === "explicit") return { jobs: planned, auto_edge_count: 0 };
  const jobsByStage = new Map();
  for (const job of planned) {
    const stage = registry.get(job.tool)?.stage || SHOPPING_EVALUATOR_STAGES[job.tool] || null;
    if (!stage) continue;
    const matching = jobsByStage.get(stage) || [];
    matching.push(job);
    jobsByStage.set(stage, matching);
  }
  let autoEdgeCount = 0;
  for (const job of planned) {
    const stage = registry.get(job.tool)?.stage || SHOPPING_EVALUATOR_STAGES[job.tool] || null;
    const template = STANDARD_DEPENDENCIES[stage];
    if (!template) continue;
    const argumentsObject = job.arguments || {};
    const boundTargets = new Set(job.argument_bindings.map((binding) => String(binding?.target_key || "")));
    for (const [targetKey, sourceStage] of Object.entries(template)) {
      if (Object.prototype.hasOwnProperty.call(argumentsObject, targetKey) || boundTargets.has(targetKey)) continue;
      const sources = jobsByStage.get(sourceStage) || [];
      if (sources.length !== 1 || sources[0] === job) continue;
      job.argument_bindings.push({ from_job_id: sources[0].job_id, target_key: targetKey });
      boundTargets.add(targetKey);
      autoEdgeCount++;
    }
  }
  return { jobs: planned, auto_edge_count: autoEdgeCount };
}

function dependencyGraph(jobs) {
  const byId = new Map(jobs.map((job, index) => [String(job.job_id), index]));
  const dependencies = jobs.map(() => []);
  let edgeCount = 0;
  for (let index = 0; index < jobs.length; index++) {
    const targets = new Set();
    const bindings = jobs[index].argument_bindings || [];
    if (!Array.isArray(bindings) || bindings.length > 24) throw coded("Evaluator dependency bindings must be a bounded array", "shopping_evaluator_dependency_invalid");
    for (const binding of bindings) {
      const sourceId = String(binding?.from_job_id || "");
      const targetKey = String(binding?.target_key || "");
      if (!byId.has(sourceId) || sourceId === String(jobs[index].job_id) || !/^[a-z][a-z0-9_]{0,63}$/.test(targetKey)
        || ["constructor", "prototype"].includes(targetKey) || targets.has(targetKey)) {
        throw coded("Evaluator dependency bindings require an existing different source job and unique safe target keys", "shopping_evaluator_dependency_invalid");
      }
      if (Object.prototype.hasOwnProperty.call(jobs[index].arguments || {}, targetKey)) {
        throw coded(`Evaluator dependency cannot overwrite caller argument ${targetKey}`, "shopping_evaluator_dependency_overwrite");
      }
      targets.add(targetKey);
      dependencies[index].push(byId.get(sourceId));
      edgeCount++;
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const depth = new Array(jobs.length).fill(0);
  function visit(index) {
    if (visiting.has(index)) throw coded("Evaluator dependency graph contains a cycle", "shopping_evaluator_dependency_cycle");
    if (visited.has(index)) return depth[index];
    visiting.add(index);
    depth[index] = dependencies[index].length ? 1 + Math.max(...dependencies[index].map(visit)) : 0;
    visiting.delete(index);
    visited.add(index);
    return depth[index];
  }
  for (let index = 0; index < jobs.length; index++) visit(index);
  return { dependencies, edge_count: edgeCount, layer_count: jobs.length ? Math.max(...depth) + 1 : 0 };
}

function bindDependencyArguments(job, outputs) {
  const bound = structuredClone(job.arguments || {});
  let injectedChars = 0;
  for (const binding of job.argument_bindings || []) {
    const value = structuredClone(outputs.get(String(binding.from_job_id)));
    bound[binding.target_key] = value;
    injectedChars += JSON.stringify(value).length;
  }
  return { arguments: bound, injected_chars: injectedChars };
}

function semaphore(limit) {
  let active = 0;
  const waiting = [];
  async function acquire() {
    if (active < limit) { active++; return; }
    await new Promise((resolve) => waiting.push(resolve));
    active++;
  }
  function release() {
    active--;
    waiting.shift()?.();
  }
  return { acquire, release };
}

export async function runShoppingEvaluatorBatch({ jobs, required_stages = [], max_concurrency = 4, max_result_chars = 120_000, result_mode = "compact", dependency_mode = "auto", include_decision_context = true, evaluated_at = new Date().toISOString(), decision_context = null, candidate_offers = null, stage_adapter = null, constraint_validator = null, offer_input_projector = null, offer_binding_validator = null, result_compactor = null }, registry) {
  const waveStartedAt = Date.now();
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 24) {
    throw coded("Evaluator batch must contain between 1 and 24 jobs", "shopping_evaluator_batch_invalid");
  }
  if (!Number.isInteger(max_concurrency) || max_concurrency < 1 || max_concurrency > 8) {
    throw coded("Evaluator concurrency must be an integer between 1 and 8", "shopping_evaluator_batch_invalid");
  }
  if (!Number.isInteger(max_result_chars) || max_result_chars < 1_000 || max_result_chars > 500_000) {
    throw coded("Evaluator result budget must be an integer between 1,000 and 500,000 characters", "shopping_evaluator_batch_invalid");
  }
  if (!["compact", "full"].includes(result_mode)) throw coded("Evaluator result mode must be compact or full", "shopping_evaluator_batch_invalid");
  const ids = jobs.map((job) => String(job?.job_id || ""));
  if (ids.some((value) => !value) || new Set(ids).size !== ids.length) {
    throw coded("Evaluator job IDs must be nonempty and distinct", "shopping_evaluator_batch_invalid");
  }
  const dependencyPlan = deriveStandardDependencies(jobs, registry, dependency_mode);
  jobs = dependencyPlan.jobs;

  const results = new Array(jobs.length);
  const preflightErrors = preflightWaveJobs(jobs, registry, decision_context, required_stages);
  const graph = dependencyGraph(jobs);
  const rawOutputs = new Map();
  let avoidedExecutions = 0;
  let dependencyInputCharsSaved = 0;
  const executionSlots = semaphore(max_concurrency);
  const executions = new Map();
  function execute(index) {
    if (executions.has(index)) return executions.get(index);
    const pending = (async () => {
      const job = jobs[index];
      const definition = registry.get(job.tool);
      const stage = definition?.stage || SHOPPING_EVALUATOR_STAGES[job.tool] || null;
      if (preflightErrors[index]) {
        avoidedExecutions++;
        results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", duration_ms: 0, error: preflightErrors[index] };
        return;
      }
      if (!definition || definition.stage !== SHOPPING_EVALUATOR_STAGES[job.tool]) {
        results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", duration_ms: 0, error: { code: "shopping_evaluator_not_allowed", message: "Tool is not an allowlisted read-only shopping evaluator" } };
        return;
      }
      await Promise.all(graph.dependencies[index].map(execute));
      const failedDependencies = graph.dependencies[index].filter((sourceIndex) => results[sourceIndex]?.status !== "complete").map((sourceIndex) => jobs[sourceIndex].job_id);
      if (failedDependencies.length) {
        avoidedExecutions++;
        results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", duration_ms: 0, dependencies: graph.dependencies[index].map((sourceIndex) => jobs[sourceIndex].job_id), error: { code: "shopping_evaluator_dependency_failed", message: `Upstream evaluator failed: ${failedDependencies.join(", ")}` } };
        return;
      }
      await executionSlots.acquire();
      const jobStartedAt = Date.now();
      try {
        const dependencyBinding = bindDependencyArguments(job, rawOutputs);
        dependencyInputCharsSaved += dependencyBinding.injected_chars;
        const projectedArguments = offer_input_projector
          ? offer_input_projector({ candidate_offers, decision_context, stage, subject: job.subject, input: dependencyBinding.arguments })
          : dependencyBinding.arguments;
        const input = definition.schema.parse(projectedArguments);
        if (offer_binding_validator) offer_binding_validator({ candidate_offers, decision_context, stage, subject: job.subject, input });
        const constraintIds = constraint_validator
          ? constraint_validator({ decision_context, stage, constraint_ids: job.constraint_ids || [], input })
          : [...new Set(job.constraint_ids || [])].sort();
        const response = await definition.handler(input);
        if (response?.isError === true) throw coded(response.content?.[0]?.text || "Evaluator returned an error", "shopping_evaluator_failed");
        const output = structuredClone(response?.structuredContent);
        if (stage_adapter) {
          try {
            const dossierStage = stage_adapter({ tool: job.tool, subject: job.subject, input, result: output, decision_context, constraint_ids: constraintIds, evaluated_at });
            const compacted = result_mode === "compact" && result_compactor ? result_compactor({ stage, subject: job.subject, result: output }) : output;
            const originalChars = JSON.stringify(output).length;
            const compactedChars = JSON.stringify(compacted).length;
            results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "complete", ...(graph.dependencies[index].length ? { dependencies: graph.dependencies[index].map((sourceIndex) => jobs[sourceIndex].job_id) } : {}), result: compacted, dossier_stage: dossierStage, result_compaction: { mode: result_mode, original_chars: originalChars, returned_chars: compactedChars, saved_chars: originalChars - compactedChars } };
            rawOutputs.set(String(job.job_id), output);
          } catch (error) {
            results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", result: output, error: safeError(error) };
          }
        } else {
          results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "complete", ...(graph.dependencies[index].length ? { dependencies: graph.dependencies[index].map((sourceIndex) => jobs[sourceIndex].job_id) } : {}), result: output };
          rawOutputs.set(String(job.job_id), output);
        }
      } catch (error) {
        results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", error: safeError(error) };
      } finally {
        executionSlots.release();
      }
      results[index].duration_ms = Math.max(0, Date.now() - jobStartedAt);
    })();
    executions.set(index, pending);
    return pending;
  }
  await Promise.all(jobs.map((job, index) => execute(index)));

  let outputChars = 0;
  for (const result of results) {
    if (!("result" in result)) continue;
    const resultChars = JSON.stringify(result.result).length;
    if (outputChars + resultChars > max_result_chars) {
      delete result.result;
      delete result.dossier_stage;
      result.status = "failed";
      result.error = { code: "shopping_evaluator_result_too_large", message: "Evaluator result exceeded the bounded batch output budget; rerun it as a narrower targeted request" };
      continue;
    }
    result.result_chars = resultChars;
    outputChars += resultChars;
  }

  const required = unique(required_stages);
  const matrix = required.map((stage) => {
    const matching = results.filter((result) => result.stage === stage);
    return {
      stage,
      status: !matching.length ? "not_in_wave" : matching.some((result) => result.status === "failed") ? "failed" : "complete",
      job_ids: matching.map((result) => result.job_id),
    };
  });
  const completed = results.filter((result) => result.status === "complete");
  const failed = results.filter((result) => result.status === "failed");
  const savedResultChars = results.reduce((sum, result) => sum + (result.result_compaction?.saved_chars || 0), 0);
  return {
    ...(include_decision_context ? { decision_context } : {}),
    decision_context_ref: decision_context?.context_id ? { context_id: decision_context.context_id } : null,
    results,
    wave: { requested_jobs: results.length, completed_jobs: completed.length, failed_jobs: failed.length, avoided_executions: avoidedExecutions, max_concurrency, result_mode, dependency_mode, dependency_edges: graph.edge_count, auto_dependency_edges: dependencyPlan.auto_edge_count, dependency_layers: graph.layer_count, dependency_input_chars_saved: dependencyInputCharsSaved, saved_result_chars: savedResultChars, wall_time_ms: Math.max(0, Date.now() - waveStartedAt), output_chars: outputChars, max_result_chars, evaluation_wave_complete: failed.length === 0 },
    dossier_requirements: {
      required_stages: required,
      matrix,
      completed_in_this_wave: matrix.filter((item) => item.status === "complete").map((item) => item.stage),
      failed_in_this_wave: matrix.filter((item) => item.status === "failed").map((item) => item.stage),
      not_in_this_wave: matrix.filter((item) => item.status === "not_in_wave").map((item) => item.stage),
    },
    readiness: { dossier_composition_required: true, recommendation_ready: false, purchase_allowed: false, model_override_allowed: false },
  };
}
