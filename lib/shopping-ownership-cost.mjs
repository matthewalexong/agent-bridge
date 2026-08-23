const finite = (value) => typeof value === "number" && Number.isFinite(value);
const rounded = (value, digits = 2) => Number(value.toFixed(digits));
const clampMoney = (value) => Math.max(0, rounded(value));

function unknownRange() {
  return { low: 0, expected: null, high: null };
}

function normalizeRange(input, path, criticalUnknowns, warnings, required = true) {
  if (!input || input.evidence_status === "unknown") {
    if (required) criticalUnknowns.push(path);
    return unknownRange();
  }
  let low = input.low;
  let expected = input.expected;
  let high = input.high;
  if (input.evidence_status === "verified" && finite(expected)) {
    low ??= expected;
    high ??= expected;
  }
  if (!finite(low) || !finite(high) || low < 0 || high < low) {
    warnings.push(`${path}:invalid_range`);
    if (required) criticalUnknowns.push(path);
    return unknownRange();
  }
  if (!finite(expected) || expected < low || expected > high) expected = (low + high) / 2;
  return { low, expected, high };
}

function add(left, right) {
  return {
    low: left.low + right.low,
    expected: left.expected === null || right.expected === null ? null : left.expected + right.expected,
    high: left.high === null || right.high === null ? null : left.high + right.high,
  };
}

function scale(range, factor) {
  if (!finite(factor) || factor < 0) return unknownRange();
  return { low: range.low * factor, expected: range.expected === null ? null : range.expected * factor, high: range.high === null ? null : range.high * factor };
}

function multiply(left, right) {
  return { low: left.low * right.low, expected: left.expected === null || right.expected === null ? null : left.expected * right.expected, high: left.high === null || right.high === null ? null : left.high * right.high };
}

function subtractBenefit(cost, benefit) {
  return {
    low: Math.max(0, cost.low - (benefit.high ?? 0)),
    expected: cost.expected === null ? null : Math.max(0, cost.expected - (benefit.expected ?? 0)),
    high: cost.high === null ? null : Math.max(0, cost.high - benefit.low),
  };
}

function presentFactor(month, annualRatePercent) {
  if (!annualRatePercent) return 1;
  return 1 / ((1 + annualRatePercent / 100 / 12) ** month);
}

function sumOccurrences(amount, component, horizon, discountRate) {
  const start = Math.max(0, component.start_month ?? (component.kind === "one_time" ? 0 : 1));
  const end = Math.min(horizon, component.end_month ?? horizon);
  const interval = component.kind === "one_time" ? horizon + 1 : Math.max(1, component.interval_months ?? 1);
  let nominal = { low: 0, expected: 0, high: 0 };
  let present = { low: 0, expected: 0, high: 0 };
  let occurrences = 0;
  for (let month = start; month <= end; month += interval) {
    const escalation = Math.max(0, 1 + (component.annual_increase_percent || 0) / 100) ** Math.floor(Math.max(0, month - start) / 12);
    const flow = scale(amount, escalation * (component.quantity ?? 1));
    nominal = add(nominal, flow);
    present = add(present, scale(flow, presentFactor(month, discountRate)));
    occurrences += 1;
    if (component.kind === "one_time") break;
  }
  return { nominal, present, occurrences };
}

function finalized(range) {
  return { low_usd: clampMoney(range.low), expected_usd: range.expected === null ? null : clampMoney(range.expected), high_usd: range.high === null ? null : clampMoney(range.high) };
}

function analyzeCandidate(candidate, horizon, discountRate) {
  const critical_unknowns = [];
  const warnings = [];
  if (candidate.identity_verified !== true) critical_unknowns.push("identity");
  const acquisition = normalizeRange(candidate.acquisition_usd, "acquisition", critical_unknowns, warnings, true);
  let nominal = acquisition;
  let present = acquisition;
  const breakdown = [{ category: "acquisition", name: "Acquisition", included: true, occurrences: 1, nominal: finalized(acquisition), present_value: finalized(acquisition) }];
  const excluded_optional_components = [];

  for (const component of candidate.cost_components || []) {
    if (component.included === false) {
      excluded_optional_components.push(component.name);
      breakdown.push({ category: component.category, name: component.name, included: false, occurrences: 0, nominal: finalized({ low: 0, expected: 0, high: 0 }), present_value: finalized({ low: 0, expected: 0, high: 0 }) });
      continue;
    }
    const amount = normalizeRange(component.amount_usd, `component:${component.name}`, critical_unknowns, warnings, true);
    const flows = sumOccurrences(amount, component, horizon, discountRate);
    nominal = add(nominal, flows.nominal);
    present = add(present, flows.present);
    breakdown.push({ category: component.category, name: component.name, included: true, occurrences: flows.occurrences, nominal: finalized(flows.nominal), present_value: finalized(flows.present) });
  }

  for (const consumable of candidate.consumables || []) {
    if (consumable.included === false) { excluded_optional_components.push(consumable.name); continue; }
    const unit = normalizeRange(consumable.unit_cost_usd, `consumable:${consumable.name}:unit_cost`, critical_unknowns, warnings, true);
    const usage = normalizeRange(consumable.units_per_month, `consumable:${consumable.name}:usage`, critical_unknowns, warnings, true);
    const monthly = multiply(unit, usage);
    const flows = sumOccurrences(monthly, { kind: "recurring", start_month: consumable.start_month ?? 1, end_month: consumable.end_month, interval_months: 1, annual_increase_percent: consumable.annual_increase_percent }, horizon, discountRate);
    nominal = add(nominal, flows.nominal);
    present = add(present, flows.present);
    breakdown.push({ category: "consumable", name: consumable.name, included: true, occurrences: flows.occurrences, nominal: finalized(flows.nominal), present_value: finalized(flows.present) });
  }

  for (const energy of candidate.energy || []) {
    if (energy.included === false) { excluded_optional_components.push(energy.name); continue; }
    const power = normalizeRange(energy.power_watts, `energy:${energy.name}:power`, critical_unknowns, warnings, true);
    const hours = normalizeRange(energy.hours_per_day, `energy:${energy.name}:hours`, critical_unknowns, warnings, true);
    const days = normalizeRange(energy.days_per_year, `energy:${energy.name}:days`, critical_unknowns, warnings, true);
    const rate = normalizeRange(energy.electricity_rate_usd_per_kwh, `energy:${energy.name}:rate`, critical_unknowns, warnings, true);
    const monthly = scale(multiply(multiply(multiply(power, hours), days), rate), 1 / 12_000);
    const flows = sumOccurrences(monthly, { kind: "recurring", start_month: 1, interval_months: 1 }, horizon, discountRate);
    nominal = add(nominal, flows.nominal);
    present = add(present, flows.present);
    breakdown.push({ category: "energy", name: energy.name, included: true, occurrences: flows.occurrences, nominal: finalized(flows.nominal), present_value: finalized(flows.present) });
  }

  let residual = { low: 0, expected: 0, high: 0 };
  if (candidate.residual_value_usd) {
    const residualWarnings = [];
    residual = normalizeRange(candidate.residual_value_usd, "residual_value", [], residualWarnings, false);
    warnings.push(...residualWarnings);
    if (residual.high === null) {
      residual = { low: 0, expected: 0, high: 0 };
      warnings.push("residual_value:ignored_unverified_benefit");
    }
  }
  nominal = subtractBenefit(nominal, residual);
  present = subtractBenefit(present, scale(residual, presentFactor(horizon, discountRate)));
  breakdown.push({ category: "residual_value", name: "Residual value", benefit: true, included: residual.high !== 0, occurrences: residual.high ? 1 : 0, nominal: finalized(residual), present_value: finalized(scale(residual, presentFactor(horizon, discountRate))) });

  if (critical_unknowns.length) {
    nominal.high = null;
    nominal.expected = null;
    present.high = null;
    present.expected = null;
  }
  const nominalFinal = finalized(nominal);
  const presentFinal = finalized(present);
  return {
    id: candidate.id,
    horizon_months: horizon,
    nominal_total: nominalFinal,
    present_value_total: presentFinal,
    monthly_equivalent: { low_usd: rounded(nominalFinal.low_usd / horizon), expected_usd: nominalFinal.expected_usd === null ? null : rounded(nominalFinal.expected_usd / horizon), high_usd: nominalFinal.high_usd === null ? null : rounded(nominalFinal.high_usd / horizon) },
    critical_unknowns: [...new Set(critical_unknowns)],
    warnings: [...new Set(warnings)],
    excluded_optional_components,
    breakdown,
  };
}

function rangeFor(candidate, basis) {
  return basis === "present_value" ? candidate.present_value_total : candidate.nominal_total;
}

export function analyzeOwnershipCosts({ horizon_months = 36, annual_discount_rate_percent = 0, decision_basis = "nominal", allow_expected_value_selection = false, candidates = [] }) {
  const horizon = Math.max(1, Math.min(240, Math.trunc(horizon_months)));
  const discountRate = Math.max(0, Math.min(100, annual_discount_rate_percent || 0));
  const analyses = candidates.map((candidate) => analyzeCandidate(candidate, horizon, discountRate));
  if (!analyses.length) return { candidates: [], decision: { action: "research_more", selected_candidate: null, reason: "no_candidates" } };

  const finiteCandidates = analyses.filter((candidate) => rangeFor(candidate, decision_basis).high_usd !== null);
  const robust = finiteCandidates.find((candidate) => {
    const own = rangeFor(candidate, decision_basis);
    return analyses.every((other) => other.id === candidate.id || own.high_usd < rangeFor(other, decision_basis).low_usd);
  });
  if (robust) return { candidates: analyses, decision: { action: "select", selected_candidate: robust.id, reason: "robust_ownership_cost_winner", basis: decision_basis } };

  const bestFiniteHigh = finiteCandidates.length ? Math.min(...finiteCandidates.map((candidate) => rangeFor(candidate, decision_basis).high_usd)) : Infinity;
  const decisionRelevantUnknowns = analyses
    .filter((candidate) => candidate.critical_unknowns.length && rangeFor(candidate, decision_basis).low_usd <= bestFiniteHigh)
    .flatMap((candidate) => candidate.critical_unknowns.map((field) => ({ candidate_id: candidate.id, field })));
  if (decisionRelevantUnknowns.length) return { candidates: analyses, decision: { action: "research_more", selected_candidate: null, reason: "unknown_costs_could_change_winner", research: decisionRelevantUnknowns, basis: decision_basis } };

  const withExpected = analyses.filter((candidate) => rangeFor(candidate, decision_basis).expected_usd !== null).sort((a, b) => rangeFor(a, decision_basis).expected_usd - rangeFor(b, decision_basis).expected_usd || a.id.localeCompare(b.id));
  if (allow_expected_value_selection && withExpected.length && (withExpected.length === 1 || rangeFor(withExpected[0], decision_basis).expected_usd < rangeFor(withExpected[1], decision_basis).expected_usd)) {
    return { candidates: analyses, decision: { action: "select", selected_candidate: withExpected[0].id, reason: "user_allowed_expected_value_selection", basis: decision_basis, uncertainty_ranges_overlap: true } };
  }
  return { candidates: analyses, decision: { action: "clarify", selected_candidate: null, reason: "ownership_cost_ranges_overlap", basis: decision_basis, expected_leader: withExpected[0]?.id || null } };
}
