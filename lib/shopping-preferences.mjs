const EPSILON = 1e-9;

const present = (value) => value !== undefined && value !== null && value !== "";
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const normalized = (value) => typeof value === "string" ? value.trim().toLowerCase() : value;
const same = (a, b) => normalized(a) === normalized(b);
const clamp = (value) => Math.max(0, Math.min(1, value));
const rounded = (value, digits = 4) => Number(value.toFixed(digits));

function rawAttributeValue(candidate, attribute) {
  if (attribute === "price_usd" && present(candidate.price_usd)) return candidate.price_usd;
  return candidate.attributes?.[attribute];
}

function attributeValue(candidate, attribute, requireVerifiedEvidence, requiredEvidenceRole = null) {
  const value = rawAttributeValue(candidate, attribute);
  if (!requireVerifiedEvidence || !present(value)) return value;
  const status = attribute === "price_usd" ? candidate.price_evidence_status : candidate.attribute_evidence?.[attribute];
  if (status !== "verified") return undefined;
  if (requiredEvidenceRole && candidate.attribute_roles?.[attribute] !== requiredEvidenceRole) return undefined;
  return value;
}

function constraintPasses(actual, constraint) {
  const expected = constraint.value;
  switch (constraint.operator) {
    case "eq": return same(actual, expected);
    case "neq": return !same(actual, expected);
    case "gte": return finite(actual) && finite(expected) && actual >= expected;
    case "gt": return finite(actual) && finite(expected) && actual > expected;
    case "lt": return finite(actual) && finite(expected) && actual < expected;
    case "lte": return finite(actual) && finite(expected) && actual <= expected;
    case "in": return Array.isArray(expected) && expected.some((value) => same(actual, value));
    case "not_in": return Array.isArray(expected) && !expected.some((value) => same(actual, value));
    case "contains": return Array.isArray(actual)
      ? actual.some((value) => same(value, expected))
      : typeof actual === "string" && actual.toLowerCase().includes(String(expected).toLowerCase());
    default: return false;
  }
}

function numericScore(value, preference) {
  if (!finite(value)) return null;
  if (preference.direction === "target") {
    if (!finite(preference.target) || !finite(preference.tolerance) || preference.tolerance <= 0) return null;
    return clamp(1 - Math.abs(value - preference.target) / preference.tolerance);
  }
  if (!finite(preference.low) || !finite(preference.high) || preference.high <= preference.low) return null;
  const position = clamp((value - preference.low) / (preference.high - preference.low));
  return preference.direction === "minimize" ? 1 - position : position;
}

function preferenceScore(value, preference) {
  if (!present(value)) return null;
  if (preference.kind === "numeric") return numericScore(value, preference);
  if (preference.kind === "boolean") return typeof value === "boolean" ? (value === preference.desired ? 1 : 0) : null;
  if (preference.kind === "categorical") {
    const values = preference.preferred_values || [];
    const index = values.findIndex((candidate) => same(candidate, value));
    if (index < 0) return 0;
    if (values.length === 1) return 1;
    return 1 - index / values.length;
  }
  return null;
}

function assessCandidate(candidate, constraints, preferences, requireVerifiedEvidence) {
  const violations = [];
  const unknown_constraints = [];
  for (const constraint of constraints) {
    const actual = attributeValue(candidate, constraint.attribute, requireVerifiedEvidence, constraint.required_evidence_role);
    if (!present(actual)) {
      unknown_constraints.push(constraint.attribute);
    } else if (!constraintPasses(actual, constraint)) {
      violations.push({ attribute: constraint.attribute, operator: constraint.operator, expected: constraint.value, actual });
    }
  }

  const preference_scores = [];
  let knownPoints = 0;
  let knownWeight = 0;
  let totalWeight = 0;
  const unknown_preferences = [];
  for (const preference of preferences) {
    const weight = preference.weight ?? 1;
    totalWeight += weight;
    const actual = attributeValue(candidate, preference.attribute, requireVerifiedEvidence, preference.required_evidence_role);
    const score = preferenceScore(actual, preference);
    if (score === null) {
      unknown_preferences.push(preference.attribute);
      preference_scores.push({ attribute: preference.attribute, weight, value: present(actual) ? actual : null, score: null });
      continue;
    }
    knownWeight += weight;
    knownPoints += score * weight;
    preference_scores.push({ attribute: preference.attribute, weight, value: actual, score: rounded(score) });
  }

  const rejected = violations.length > 0;
  const lower = totalWeight > 0 ? knownPoints / totalWeight : 0;
  const upper = totalWeight > 0 ? (knownPoints + totalWeight - knownWeight) / totalWeight : 0;
  return {
    id: candidate.id,
    status: rejected ? "rejected" : unknown_constraints.length ? "needs_research" : "eligible",
    constraint_violations: violations,
    unknown_constraints: [...new Set(unknown_constraints)],
    preference_scores,
    unknown_preferences: [...new Set(unknown_preferences)],
    evidence_coverage: totalWeight > 0 ? rounded(knownWeight / totalWeight) : 1,
    score_lower: rounded(lower * 100, 2),
    score_upper: rounded(upper * 100, 2),
  };
}

function differingAttributes(candidates, preferred = [], requireVerifiedEvidence = true) {
  const keys = new Set(preferred);
  for (const candidate of candidates) {
    for (const key of Object.keys(candidate.attributes || {})) keys.add(key);
    if (present(candidate.price_usd)) keys.add("price_usd");
  }
  return [...keys].filter((key) => {
    const values = candidates.map((candidate) => attributeValue(candidate, key, requireVerifiedEvidence)).filter(present).map(normalized);
    return new Set(values.map((value) => JSON.stringify(value))).size > 1;
  }).slice(0, 12);
}

export function rankShoppingCandidates({ constraints = [], preferences = [], candidates = [], require_verified_evidence = true, candidate_coverage = null }) {
  if (candidate_coverage && (candidate_coverage.action !== "coverage_sufficient" || candidate_coverage.candidate_set_cleared_for_ranking !== true)) {
    return { assessments: [], excluded_by_candidate_coverage: candidates.map((candidate) => candidate.id), decision: { action: "research_more", selected_candidate: null, reason: "candidate_set_coverage_not_cleared", research: [] } };
  }
  const allowed = candidate_coverage ? new Set(candidate_coverage.eligible_candidate_ids || []) : null;
  const coveredCandidates = allowed ? candidates.filter((candidate) => allowed.has(candidate.id)) : candidates;
  const excluded_by_candidate_coverage = allowed ? candidates.filter((candidate) => !allowed.has(candidate.id)).map((candidate) => candidate.id) : [];
  const assessments = coveredCandidates.map((candidate) => assessCandidate(candidate, constraints, preferences, require_verified_evidence));
  const byId = new Map(coveredCandidates.map((candidate) => [candidate.id, candidate]));
  const contenders = assessments.filter((candidate) => candidate.status !== "rejected");
  const base = { assessments, excluded_by_candidate_coverage, decision: null };

  if (!contenders.length) {
    return { ...base, decision: { action: "research_more", selected_candidate: null, reason: "no_candidate_meets_hard_constraints", research: [] } };
  }

  if (!preferences.length) {
    if (contenders.length === 1 && contenders[0].status === "eligible") {
      return { ...base, decision: { action: "select", selected_candidate: contenders[0].id, reason: "only_viable_candidate", research: [] } };
    }
    const unknown = contenders.flatMap((candidate) => candidate.unknown_constraints.map((attribute) => ({ candidate_id: candidate.id, attribute, reason: "hard_constraint_unknown" })));
    if (unknown.length) {
      return { ...base, decision: { action: "research_more", selected_candidate: null, reason: "hard_constraints_unresolved", research: unknown } };
    }
    const viable = contenders.map((assessment) => byId.get(assessment.id));
    return { ...base, decision: { action: "clarify", selected_candidate: null, reason: "multiple_viable_candidates_without_preferences", clarify_attributes: differingAttributes(viable, [], require_verified_evidence), research: [] } };
  }

  const sorted = [...contenders].sort((a, b) => b.score_lower - a.score_lower || b.score_upper - a.score_upper || a.id.localeCompare(b.id));
  const leader = sorted[0];
  const alternatives = sorted.slice(1);
  const leaderDominates = leader.status === "eligible"
    && alternatives.every((candidate) => leader.score_lower > candidate.score_upper + EPSILON);

  if (leaderDominates) {
    return { ...base, decision: { action: "select", selected_candidate: leader.id, reason: "robust_preference_winner", score_lower: leader.score_lower, score_upper: leader.score_upper, research: [] } };
  }

  const bestKnownLower = Math.max(...contenders.filter((candidate) => candidate.status === "eligible").map((candidate) => candidate.score_lower), -Infinity);
  const couldAffectDecision = contenders.filter((candidate) => candidate.score_upper + EPSILON >= bestKnownLower);
  const research = [];
  for (const candidate of couldAffectDecision) {
    for (const attribute of candidate.unknown_constraints) research.push({ candidate_id: candidate.id, attribute, reason: "hard_constraint_unknown" });
    for (const attribute of candidate.unknown_preferences) research.push({ candidate_id: candidate.id, attribute, reason: "preference_evidence_unknown" });
  }
  if (research.length) {
    return { ...base, decision: { action: "research_more", selected_candidate: null, reason: "missing_evidence_could_change_winner", research } };
  }

  const tied = couldAffectDecision.map((assessment) => byId.get(assessment.id));
  return {
    ...base,
    decision: {
      action: "clarify",
      selected_candidate: null,
      reason: "preference_scores_tied",
      clarify_attributes: differingAttributes(tied, preferences.map((preference) => preference.attribute), require_verified_evidence),
      research: [],
    },
  };
}
