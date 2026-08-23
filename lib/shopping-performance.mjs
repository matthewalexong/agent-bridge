const DAY = 86_400_000;
const INDEPENDENT_TYPES = new Set(["independent_lab", "accredited_lab", "professional_review"]);
const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const rounded = (value, digits = 6) => Number(value.toFixed(digits));
const unique = (items) => [...new Set(items)];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  if (typeof value === "string") return clean(value);
  return value;
}

function sameObject(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function fresh(value, evaluatedAt, maxAgeDays) {
  const at = Date.parse(value || "");
  return Number.isFinite(at) && at <= evaluatedAt + 300_000 && evaluatedAt - at <= maxAgeDays * DAY;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function exactTarget(measurement, target, metric) {
  if (measurement.product_id !== target.id) return false;
  if (clean(measurement.variant_id) !== clean(target.variant_id)) return false;
  if (clean(measurement.configuration_id) !== clean(target.configuration_id)) return false;
  if (metric.firmware_sensitive && clean(measurement.firmware_version) !== clean(target.firmware_version)) return false;
  return true;
}

function eligibleMeasurement(measurement, target, input, evaluatedAt, policy) {
  const reasons = [];
  if (!exactTarget(measurement, target, input.metric)) reasons.push("scope_mismatch");
  if (measurement.metric_id !== input.metric.id) reasons.push("metric_mismatch");
  if (clean(measurement.unit) !== clean(input.metric.unit)) reasons.push("unit_mismatch");
  if (measurement.protocol?.id !== input.metric.protocol.id || measurement.protocol?.version !== input.metric.protocol.version) reasons.push("protocol_mismatch");
  if (measurement.protocol?.evidence_status !== "verified" || !clean(measurement.protocol?.source_id)) reasons.push("protocol_unverified");
  if (measurement.condition_inventory_complete !== true || !sameObject(measurement.conditions, input.metric.conditions)) reasons.push("conditions_incomparable");
  if (measurement.evidence_status !== "verified" || !clean(measurement.source?.id) || !clean(measurement.source?.independence_key)) reasons.push("source_unverified");
  if (!fresh(measurement.measured_at, evaluatedAt, policy.max_age_days)) reasons.push("stale_or_invalid_time");
  if (!INDEPENDENT_TYPES.has(measurement.source?.source_type) || measurement.source?.funding_relationship !== "none" || measurement.source?.funding_evidence_status !== "verified" || measurement.source?.editorial_independence_verified !== true || measurement.source?.editorial_independence_evidence_status !== "verified") reasons.push("source_not_independent");
  if (input.metric.calibration_required && (measurement.instrument_calibration?.status !== "current" || measurement.instrument_calibration?.evidence_status !== "verified" || !clean(measurement.instrument_calibration?.source_id))) reasons.push("instrument_calibration_unverified");
  if (!Number.isInteger(measurement.sample_size) || measurement.sample_size < policy.min_sample_size) reasons.push("sample_size_below_minimum");
  if (measurement.run_coverage_complete !== true) reasons.push("run_coverage_incomplete");
  const low = measurement.uncertainty?.low;
  const high = measurement.uncertainty?.high;
  if (measurement.uncertainty?.evidence_status !== "verified" || !clean(measurement.uncertainty?.source_id) || !Number.isFinite(low) || !Number.isFinite(high) || low > measurement.value || high < measurement.value || low > high) reasons.push("uncertainty_unverified");
  else {
    const denominator = Math.max(Math.abs(measurement.value), 1e-12);
    if ((high - low) / denominator > policy.max_relative_uncertainty) reasons.push("uncertainty_exceeds_policy");
  }
  if (!Number.isFinite(measurement.value)) reasons.push("value_invalid");
  return unique(reasons);
}

function assessTarget(target, input, evaluatedAt, policy) {
  const relevant = (input.measurements || []).filter((item) => item.product_id === target.id);
  const controlled_claim_ids = relevant.filter((item) => !INDEPENDENT_TYPES.has(item.source?.source_type) || item.source?.funding_relationship !== "none" || item.source?.funding_evidence_status !== "verified" || item.source?.editorial_independence_verified !== true || item.source?.editorial_independence_evidence_status !== "verified").map((item) => item.id);
  const excluded = [];
  const byLab = new Map();
  for (const measurement of relevant) {
    const reasons = eligibleMeasurement(measurement, target, input, evaluatedAt, policy);
    if (reasons.length) { excluded.push({ id: measurement.id, reasons }); continue; }
    const key = clean(measurement.source.independence_key);
    if (byLab.has(key)) { excluded.push({ id: measurement.id, reasons: ["duplicate_independent_source"] }); continue; }
    byLab.set(key, measurement);
  }
  const usable = [...byLab.values()];
  const research = [];
  const conflicts = [];
  if (!clean(target.variant_id) || !clean(target.configuration_id) || (input.metric.firmware_sensitive && !clean(target.firmware_version))) research.push(`${target.id}:exact_test_scope_missing`);
  if (usable.length < policy.min_independent_labs) research.push(`${target.id}:independent_lab_count_below_minimum`);
  const values = usable.map((item) => item.value);
  const point = values.length ? median(values) : null;
  if (values.length >= policy.min_independent_labs && point != null) {
    const spread = (Math.max(...values) - Math.min(...values)) / Math.max(Math.abs(point), 1e-12);
    if (spread > policy.max_interlab_relative_spread) conflicts.push(`${target.id}:interlab_spread_exceeds_policy`);
  }
  const action = conflicts.length ? "conflict" : research.length ? "research_more" : "comparable";
  return {
    product_id: target.id,
    attribute: `performance:${input.metric.id}`,
    variant_id: target.variant_id || null,
    configuration_id: target.configuration_id || null,
    firmware_version: target.firmware_version || null,
    action,
    performance_cleared_for_ranking: action === "comparable",
    metric: action === "comparable" ? { attribute: `performance:${input.metric.id}`, value: rounded(point), unit: input.metric.unit, direction: input.metric.direction, lower: Math.min(...usable.map((item) => item.uncertainty.low)), upper: Math.max(...usable.map((item) => item.uncertainty.high)), independent_labs: usable.length, measurement_ids: usable.map((item) => item.id) } : null,
    eligible_measurement_ids: action === "comparable" ? usable.map((item) => item.id) : [],
    excluded_measurements: excluded,
    controlled_or_funded_claim_ids: controlled_claim_ids,
    research,
    conflicts,
    selected_product: null,
    purchase_allowed: false,
  };
}

export function assessShoppingPerformance(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Performance timestamp is invalid"), { code: "shopping_performance_invalid" });
  const policy = {
    max_age_days: input.policy?.max_age_days ?? 365,
    min_independent_labs: input.policy?.min_independent_labs ?? 2,
    min_sample_size: input.policy?.min_sample_size ?? 1,
    max_relative_uncertainty: input.policy?.max_relative_uncertainty ?? 0.25,
    max_interlab_relative_spread: input.policy?.max_interlab_relative_spread ?? 0.2,
  };
  const assessments = (input.targets || []).map((target) => assessTarget(target, input, evaluatedAt, policy));
  const action = assessments.some((item) => item.action === "conflict") ? "conflict" : assessments.some((item) => item.action === "research_more") ? "research_more" : "comparable";
  return {
    metric: { ...input.metric, attribute: `performance:${input.metric.id}` },
    evaluated_at: new Date(evaluatedAt).toISOString(),
    action,
    comparison_cleared_for_ranking: action === "comparable" && assessments.length > 0,
    assessments,
    comparable_product_ids: assessments.filter((item) => item.action === "comparable").map((item) => item.product_id),
    selected_product: null,
    purchase_allowed: false,
  };
}
