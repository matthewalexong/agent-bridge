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

export async function runShoppingEvaluatorBatch({ jobs, required_stages = [], max_concurrency = 4, max_result_chars = 120_000, evaluated_at = new Date().toISOString(), decision_context = null, stage_adapter = null, constraint_validator = null }, registry) {
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
  const ids = jobs.map((job) => String(job?.job_id || ""));
  if (ids.some((value) => !value) || new Set(ids).size !== ids.length) {
    throw coded("Evaluator job IDs must be nonempty and distinct", "shopping_evaluator_batch_invalid");
  }

  const results = new Array(jobs.length);
  const preflightErrors = preflightWaveJobs(jobs, registry, decision_context, required_stages);
  let avoidedExecutions = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++;
      const job = jobs[index];
      const definition = registry.get(job.tool);
      const stage = definition?.stage || SHOPPING_EVALUATOR_STAGES[job.tool] || null;
      if (preflightErrors[index]) {
        avoidedExecutions++;
        results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", duration_ms: 0, error: preflightErrors[index] };
        continue;
      }
      if (!definition || definition.stage !== SHOPPING_EVALUATOR_STAGES[job.tool]) {
        results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", duration_ms: 0, error: { code: "shopping_evaluator_not_allowed", message: "Tool is not an allowlisted read-only shopping evaluator" } };
        continue;
      }
      const jobStartedAt = Date.now();
      try {
        const input = definition.schema.parse(job.arguments || {});
        const constraintIds = constraint_validator
          ? constraint_validator({ decision_context, stage, constraint_ids: job.constraint_ids || [], input })
          : [...new Set(job.constraint_ids || [])].sort();
        const response = await definition.handler(input);
        if (response?.isError === true) throw coded(response.content?.[0]?.text || "Evaluator returned an error", "shopping_evaluator_failed");
        const output = structuredClone(response?.structuredContent);
        if (stage_adapter) {
          try {
            const dossierStage = stage_adapter({ tool: job.tool, subject: job.subject, input, result: output, decision_context, constraint_ids: constraintIds, evaluated_at });
            results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "complete", result: output, dossier_stage: dossierStage };
          } catch (error) {
            results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", result: output, error: safeError(error) };
          }
        } else results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "complete", result: output };
      } catch (error) {
        results[index] = { job_id: job.job_id, tool: job.tool, stage, status: "failed", error: safeError(error) };
      }
      results[index].duration_ms = Math.max(0, Date.now() - jobStartedAt);
    }
  }
  await Promise.all(Array.from({ length: Math.min(max_concurrency, jobs.length) }, () => worker()));

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
  return {
    decision_context,
    results,
    wave: { requested_jobs: results.length, completed_jobs: completed.length, failed_jobs: failed.length, avoided_executions: avoidedExecutions, max_concurrency, wall_time_ms: Math.max(0, Date.now() - waveStartedAt), output_chars: outputChars, max_result_chars, evaluation_wave_complete: failed.length === 0 },
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
