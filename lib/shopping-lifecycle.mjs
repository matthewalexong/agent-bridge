const finite = (value) => typeof value === "number" && Number.isFinite(value);
const rounded = (value) => Number(value.toFixed(2));

function unique(items) { return [...new Set(items)]; }

function addMonths(value, months) {
  if (!value || !Number.isInteger(months)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}

function dateEvidence(input) {
  if (!input || input.evidence_status === "unknown" || !input.date || !Number.isFinite(Date.parse(input.date))) return { date: null, evidence_status: "unknown" };
  return { date: new Date(input.date).toISOString(), evidence_status: input.evidence_status };
}

function coverage(input, evaluatedAt, requiredUntil) {
  const fact = dateEvidence(input);
  if (!fact.date) return { ...fact, coverage_months: null, covers_horizon: null, expired: null };
  const days = (Date.parse(fact.date) - Date.parse(evaluatedAt)) / 86_400_000;
  return { ...fact, coverage_months: rounded(Math.max(0, days / 30.4375)), covers_horizon: Date.parse(fact.date) >= Date.parse(requiredUntil), expired: Date.parse(fact.date) < Date.parse(evaluatedAt) };
}

function moneyRange(input) {
  if (!input || input.evidence_status === "unknown") return { low_usd: 0, expected_usd: null, high_usd: null };
  let low = input.low_usd;
  let expected = input.expected_usd;
  let high = input.high_usd;
  if (input.evidence_status === "verified" && finite(expected)) { low ??= expected; high ??= expected; }
  if (!finite(low) || !finite(high) || low < 0 || high < low) return { low_usd: 0, expected_usd: null, high_usd: null };
  if (!finite(expected) || expected < low || expected > high) expected = (low + high) / 2;
  return { low_usd: rounded(low), expected_usd: rounded(expected), high_usd: rounded(high) };
}

function assessContinuity(items, evaluatedAt, horizonEnd, failures, unknowns, exposures, strengths) {
  return (items || []).map((item) => {
    const key = `dependency:${item.name}`;
    const commitment = coverage(item.supply_commitment_until, evaluatedAt, horizonEnd);
    let status = "available";
    if (item.required !== true) status = "optional";
    else if (item.evidence_status !== "verified" || !item.availability || item.availability === "unknown") { status = "unknown"; unknowns.push(`${key}:availability`); }
    else if (item.availability === "discontinued" && item.compatible_alternatives_verified !== true) { status = "blocked"; failures.push(`${key}:discontinued`); }
    else if (["scarce", "vendor_only"].includes(item.availability) && item.compatible_alternatives_verified !== true) { status = "exposed"; exposures.push(`${key}:${item.availability}`); }
    else if (item.compatible_alternatives_verified === true || item.availability === "multiple_sources") strengths.push(`${key}:alternatives`);
    if (item.required === true && commitment.date && !commitment.covers_horizon) { status = status === "blocked" ? status : "exposed"; exposures.push(`${key}:commitment_ends_before_horizon`); }
    return { name: item.name, kind: item.kind, required: item.required === true, availability: item.availability || "unknown", compatible_alternatives_verified: item.compatible_alternatives_verified ?? null, supply_commitment: commitment, status };
  });
}

function assess(candidate, requirements, evaluatedAt, horizonEnd) {
  const failures = [];
  const criticalUnknowns = [];
  const exposures = [];
  const strengths = [];
  if (candidate.identity_verified !== true) criticalUnknowns.push("identity");

  const support = candidate.support || {};
  const security = coverage(support.security_updates_until, evaluatedAt, horizonEnd);
  const functional = coverage(support.functional_updates_until, evaluatedAt, horizonEnd);
  const cloud = coverage(support.cloud_service_commitment_until, evaluatedAt, horizonEnd);
  const repair = coverage(support.repair_support_until, evaluatedAt, horizonEnd);
  const endOfSupport = dateEvidence(support.end_of_support);

  if (requirements.security_updates_required === true) {
    if (!security.date || security.evidence_status !== "verified") criticalUnknowns.push("support:security_updates_until");
    else if (!security.covers_horizon) failures.push("security_support_shorter_than_required_horizon");
    else strengths.push("security_support_covers_horizon");
  } else if (security.date && !security.covers_horizon) exposures.push("security_support_ends_before_horizon");
  if (requirements.functional_updates_required === true) {
    if (!functional.date || functional.evidence_status !== "verified") criticalUnknowns.push("support:functional_updates_until");
    else if (!functional.covers_horizon) failures.push("functional_support_shorter_than_required_horizon");
    else strengths.push("functional_support_covers_horizon");
  }
  if (endOfSupport.date && Date.parse(endOfSupport.date) < Date.parse(horizonEnd)) exposures.push("end_of_support_before_horizon");

  const ecosystem = candidate.ecosystem || {};
  if (ecosystem.cloud_required == null) criticalUnknowns.push("ecosystem:cloud_required");
  if (ecosystem.cloud_required === true) {
    if (ecosystem.vendor_shutdown_effect === "unknown" || !ecosystem.vendor_shutdown_effect) criticalUnknowns.push("ecosystem:vendor_shutdown_effect");
    if (!cloud.date || cloud.evidence_status !== "verified") criticalUnknowns.push("support:cloud_service_commitment_until");
    else if (!cloud.covers_horizon) exposures.push("cloud_commitment_ends_before_horizon");
    if (ecosystem.vendor_shutdown_effect === "core_function_loss") exposures.push("vendor_shutdown_causes_core_function_loss");
  } else if (ecosystem.cloud_required === false) strengths.push("core_function_offline_capable");
  if (requirements.offline_operation_required === true && ecosystem.cloud_required !== false) {
    if (ecosystem.cloud_required == null) criticalUnknowns.push("ecosystem:offline_operation");
    else failures.push("offline_operation_unavailable");
  }

  if (requirements.open_standard_required === true) {
    if (ecosystem.interoperability?.evidence_status !== "verified") criticalUnknowns.push("ecosystem:interoperability_standard");
    else if (ecosystem.interoperability.open_standard !== true) failures.push("open_standard_unavailable");
    else strengths.push("verified_open_standard");
  } else if (ecosystem.interoperability?.evidence_status === "verified" && ecosystem.interoperability.open_standard === true) strengths.push("verified_open_standard");

  if (requirements.data_export_required === true) {
    if (ecosystem.data_export?.evidence_status !== "verified") criticalUnknowns.push("ecosystem:data_export");
    else if (ecosystem.data_export.available !== true) failures.push("data_export_unavailable");
    else strengths.push("verified_data_export");
  }
  if (ecosystem.proprietary_consumables === true) exposures.push("proprietary_consumables");
  if (ecosystem.proprietary_connector === true) exposures.push("proprietary_connector");
  if (ecosystem.proprietary_file_format === true && ecosystem.data_export?.available !== true) exposures.push("proprietary_format_without_verified_export");
  if (ecosystem.account_transferable === false) exposures.push("account_or_device_not_transferable");

  const migrationCost = moneyRange(candidate.migration?.cost_usd);
  if (finite(requirements.max_migration_cost_usd)) {
    if (migrationCost.high_usd === null) criticalUnknowns.push("migration:cost");
    else if (migrationCost.high_usd > requirements.max_migration_cost_usd) failures.push("migration_cost_exceeds_limit");
  } else if (migrationCost.high_usd === null && exposures.some((item) => item.includes("vendor") || item.includes("proprietary") || item.includes("cloud"))) criticalUnknowns.push("migration:cost");
  if (candidate.migration?.path_verified === true) strengths.push("migration_path_verified");
  else if (candidate.migration?.path_verified === false) exposures.push("migration_path_unverified");

  const continuity = assessContinuity(candidate.continuity, evaluatedAt, horizonEnd, failures, criticalUnknowns, exposures, strengths);
  if (requirements.replacement_parts_required === true && !continuity.some((item) => item.kind === "replacement_part" && item.required)) criticalUnknowns.push("dependency:replacement_parts");
  if (requirements.consumables_required === true && !continuity.some((item) => item.kind === "consumable" && item.required)) criticalUnknowns.push("dependency:consumables");

  const normalizedFailures = unique(failures);
  const normalizedUnknowns = unique(criticalUnknowns);
  const normalizedExposures = unique(exposures);
  let status;
  if (normalizedFailures.length) status = "rejected";
  else if (normalizedUnknowns.length) status = "unknown";
  else if (normalizedExposures.length) status = "exposed";
  else status = "resilient";
  const purchaseGate = status === "rejected" ? "avoid_product" : status === "unknown" ? "research_more" : status === "exposed" ? "clarify_tradeoff" : "eligible_for_ranking";

  return {
    id: candidate.id,
    status,
    purchase_gate: purchaseGate,
    horizon_end: horizonEnd,
    failures: normalizedFailures,
    critical_unknowns: normalizedUnknowns,
    exposures: normalizedExposures,
    resilience_signals: unique(strengths),
    support: { security_updates: security, functional_updates: functional, cloud_service_commitment: cloud, repair_support: repair, end_of_support: endOfSupport },
    ecosystem: { cloud_required: ecosystem.cloud_required ?? null, vendor_shutdown_effect: ecosystem.vendor_shutdown_effect || "unknown", interoperability: ecosystem.interoperability || null, data_export: ecosystem.data_export || null },
    continuity,
    migration: { cost: migrationCost, path_verified: candidate.migration?.path_verified ?? null },
  };
}

export function assessShoppingLifecycle({ evaluated_at, horizon_months = 36, requirements = {}, candidates = [] }) {
  const evaluatedAt = new Date(evaluated_at || Date.now()).toISOString();
  const horizon = Math.max(1, Math.min(240, Math.trunc(horizon_months)));
  const requirementMonths = Math.max(horizon, Math.min(240, Math.trunc(requirements.minimum_support_months || 0)));
  const horizonEnd = addMonths(evaluatedAt, requirementMonths);
  const assessments = candidates.map((candidate) => assess(candidate, requirements, evaluatedAt, horizonEnd));
  return {
    evaluated_at: evaluatedAt,
    horizon_months: requirementMonths,
    horizon_end: horizonEnd,
    assessments,
    decision: {
      eligible_product_ids: assessments.filter((item) => item.purchase_gate === "eligible_for_ranking").map((item) => item.id),
      tradeoff_product_ids: assessments.filter((item) => item.purchase_gate === "clarify_tradeoff").map((item) => item.id),
      research_product_ids: assessments.filter((item) => item.purchase_gate === "research_more").map((item) => item.id),
      avoid_product_ids: assessments.filter((item) => item.purchase_gate === "avoid_product").map((item) => item.id),
      selects_product: false,
    },
  };
}
