const clean = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const unique = (items) => [...new Set(items)];
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const LENGTH_TO_MM = { mm: 1, cm: 10, in: 25.4, inch: 25.4, inches: 25.4, m: 1_000 };

function normalizedScalar(value) {
  return typeof value === "string" ? clean(value) : value;
}

function toBase(value, unit) {
  if (!finite(value)) return null;
  const normalizedUnit = clean(unit);
  if (LENGTH_TO_MM[normalizedUnit]) return value * LENGTH_TO_MM[normalizedUnit];
  return { value, unit: normalizedUnit };
}

function comparableRange(low, high, unit, expectedUnit) {
  const a = toBase(low, unit);
  const b = toBase(high, unit);
  if (a == null || b == null) return null;
  if (typeof a === "number" && typeof b === "number") return { low: a, high: b, dimension: "length" };
  if (a.unit !== clean(expectedUnit) || b.unit !== clean(expectedUnit)) return null;
  return { low: a.value, high: b.value, dimension: a.unit };
}

function exact(requirement, claim) {
  return normalizedScalar(requirement.value) === normalizedScalar(claim.value)
    ? { status: "compatible", details: { required: requirement.value, actual: claim.value } }
    : { status: "incompatible", reason: "exact_value_mismatch", details: { required: requirement.value, actual: claim.value } };
}

function allSupported(requirement, claim) {
  const supported = new Set((claim.values || []).map(normalizedScalar));
  const missing = (requirement.values || []).filter((value) => !supported.has(normalizedScalar(value)));
  return missing.length
    ? { status: "incompatible", reason: "required_values_not_supported", details: { missing } }
    : { status: "compatible", details: { matched: requirement.values || [] } };
}

function numericContained(requirement, claim) {
  const requiredLow = requirement.low ?? requirement.value;
  const requiredHigh = requirement.high ?? requirement.value;
  const wanted = comparableRange(requiredLow, requiredHigh, requirement.unit, requirement.unit);
  const offered = comparableRange(claim.low, claim.high, claim.unit, requirement.unit);
  if (!wanted || !offered || wanted.dimension !== offered.dimension) return { status: "research_more", reason: "unit_or_range_unresolved" };
  return offered.low <= wanted.low && offered.high >= wanted.high
    ? { status: "compatible", details: { required_range: [requiredLow, requiredHigh], supported_range: [claim.low, claim.high], unit: requirement.unit } }
    : { status: "incompatible", reason: "required_range_not_supported", details: { required_range: [requiredLow, requiredHigh], supported_range: [claim.low, claim.high], unit: requirement.unit } };
}

function dimensionsFit(requirement, claim) {
  const axes = ["width", "height", "depth"];
  const available = {};
  const needed = {};
  for (const axis of axes) {
    const availableValue = toBase(requirement.available?.[axis], requirement.unit);
    const productValue = toBase(claim.product?.[axis], claim.unit);
    const clearanceValue = toBase(claim.clearance_each_side?.[axis] ?? 0, claim.unit);
    if (![availableValue, productValue, clearanceValue].every((value) => typeof value === "number")) return { status: "research_more", reason: "installation_dimensions_unresolved" };
    available[axis] = availableValue;
    needed[axis] = productValue + 2 * clearanceValue;
  }
  const direct = axes.every((axis) => needed[axis] <= available[axis]);
  const rotated = requirement.allow_width_depth_rotation === true
    && needed.width <= available.depth && needed.depth <= available.width && needed.height <= available.height;
  return direct || rotated
    ? { status: "compatible", details: { orientation: direct ? "direct" : "width_depth_rotated", needed_mm: needed, available_mm: available } }
    : { status: "incompatible", reason: "installation_space_insufficient", details: { needed_mm: needed, available_mm: available } };
}

function fitmentExact(requirement, claim) {
  const requiredFields = requirement.required_fields || Object.keys(requirement.fitment || {});
  const target = requirement.fitment || {};
  let incompleteCouldMatch = false;
  for (const record of claim.records || []) {
    let mismatch = false;
    let missing = false;
    for (const field of requiredFields) {
      if (record[field] == null || target[field] == null) missing = true;
      else if (normalizedScalar(record[field]) !== normalizedScalar(target[field])) mismatch = true;
    }
    if (!mismatch && !missing) return { status: "compatible", details: { matched_record: record, required_fields: requiredFields } };
    if (!mismatch && missing) incompleteCouldMatch = true;
  }
  if (incompleteCouldMatch || claim.coverage_complete !== true) return { status: "research_more", reason: "fitment_coverage_incomplete" };
  return { status: "incompatible", reason: "no_exact_fitment_record" };
}

function apparelChart(requirement, claim) {
  if (!claim.size_label || !Array.isArray(claim.measurements)) return { status: "research_more", reason: "size_chart_missing" };
  const matched = [];
  for (const wanted of requirement.measurements || []) {
    const chart = claim.measurements.find((item) => clean(item.name) === clean(wanted.name));
    if (!chart) return { status: "research_more", reason: `size_chart_measurement_missing:${clean(wanted.name).replaceAll(" ", "_")}` };
    const target = comparableRange(wanted.value, wanted.value, wanted.unit, wanted.unit);
    const range = comparableRange(chart.low, chart.high, chart.unit, wanted.unit);
    if (!target || !range || target.dimension !== range.dimension) return { status: "research_more", reason: `size_chart_unit_unresolved:${clean(wanted.name).replaceAll(" ", "_")}` };
    if (target.low < range.low || target.high > range.high) return { status: "incompatible", reason: `measurement_outside_size_chart:${clean(wanted.name).replaceAll(" ", "_")}`, details: { size_label: claim.size_label, measurement: wanted.name } };
    matched.push(wanted.name);
  }
  return { status: "compatible", details: { size_label: claim.size_label, size_system: claim.size_system || null, matched_measurements: matched } };
}

function evaluate(requirement, claim) {
  if (!claim) return { status: "research_more", reason: "compatibility_claim_missing" };
  if (claim.kind !== requirement.kind) return { status: "research_more", reason: "compatibility_claim_kind_mismatch" };
  if (["unknown", "conflict", "estimated"].includes(claim.evidence_status)) return { status: "research_more", reason: `compatibility_evidence_${claim.evidence_status}` };
  if (claim.evidence_status !== "verified") return { status: "research_more", reason: "compatibility_evidence_unknown" };
  if (!clean(claim.source_id)) return { status: "research_more", reason: "compatibility_source_missing" };
  if (requirement.kind === "exact") return exact(requirement, claim);
  if (requirement.kind === "all_supported") return allSupported(requirement, claim);
  if (requirement.kind === "numeric_contained") return numericContained(requirement, claim);
  if (requirement.kind === "dimensions_fit") return dimensionsFit(requirement, claim);
  if (requirement.kind === "fitment_exact") return fitmentExact(requirement, claim);
  if (requirement.kind === "apparel_chart") return apparelChart(requirement, claim);
  return { status: "research_more", reason: "unsupported_compatibility_check" };
}

function assessCandidate(candidate, requirements) {
  const results = requirements.map((requirement) => {
    const claim = (candidate.claims || []).find((item) => item.requirement_id === requirement.id);
    return { requirement_id: requirement.id, kind: requirement.kind, required: requirement.required !== false, source_id: claim?.source_id || null, ...evaluate(requirement, claim) };
  });
  const hard = results.filter((item) => item.required);
  const blockers = hard.filter((item) => item.status === "incompatible").map((item) => `${item.requirement_id}:${item.reason}`);
  const research = hard.filter((item) => item.status === "research_more").map((item) => `${item.requirement_id}:${item.reason}`);
  const optionalMismatches = results.filter((item) => !item.required && item.status !== "compatible").map((item) => `${item.requirement_id}:${item.reason}`);
  const action = blockers.length ? "incompatible" : research.length ? "research_more" : "compatible";
  return { id: candidate.id, action, checks: results, blockers: unique(blockers), research: unique(research), optional_mismatches: unique(optionalMismatches), safe_for_ranking: action === "compatible" };
}

export function assessShoppingCompatibility(input) {
  const requirements = input.requirements || [];
  const duplicateIds = requirements.filter((item, index) => requirements.findIndex((other) => other.id === item.id) !== index).map((item) => item.id);
  if (duplicateIds.length) throw Object.assign(new Error(`Duplicate compatibility requirement: ${duplicateIds[0]}`), { code: "shopping_compatibility_invalid" });
  const assessments = (input.candidates || []).map((candidate) => assessCandidate(candidate, requirements));
  return {
    category: input.category || "other",
    assessments,
    decision: {
      compatible_candidates: assessments.filter((item) => item.action === "compatible").map((item) => item.id),
      research_candidates: assessments.filter((item) => item.action === "research_more").map((item) => item.id),
      incompatible_candidates: assessments.filter((item) => item.action === "incompatible").map((item) => item.id),
      selected_candidate: null,
      purchase_allowed: false,
    },
  };
}
