const DAY = 86_400_000;
const QUALIFYING_PLACEMENTS = new Set(["organic", "direct_catalog"]);
const NONINDEPENDENT_RELATIONSHIPS = new Set(["sponsored", "affiliate", "unknown"]);
const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const unique = (items) => [...new Set(items)];
const rounded = (value) => Number(value.toFixed(4));

function fresh(value, evaluatedAt, maxAgeDays) {
  const at = Date.parse(value || "");
  return Number.isFinite(at) && at <= evaluatedAt + 300_000 && evaluatedAt - at <= maxAgeDays * DAY;
}

function sameScope(item, input) {
  return clean(item.category) === clean(input.category) && clean(item.market_country) === clean(input.market_country);
}

export function assessCandidateCoverage(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Candidate-coverage timestamp is invalid"), { code: "shopping_candidate_coverage_invalid" });
  const policy = {
    max_age_days: input.policy?.max_age_days ?? 7,
    min_eligible_candidates: input.policy?.min_eligible_candidates ?? 3,
    min_independent_sources: input.policy?.min_independent_sources ?? 3,
    min_query_families: input.policy?.min_query_families ?? 2,
    require_noncommercial_source: input.policy?.require_noncommercial_source ?? true,
    max_single_owner_share: input.policy?.max_single_owner_share ?? 0.67,
    max_paid_placement_share: input.policy?.max_paid_placement_share ?? 0.5,
  };
  const research = [];
  const warnings = [];
  const invalidPlan = [];
  const laneIds = (input.lanes || []).map((lane) => lane.id);
  if (new Set(laneIds).size !== laneIds.length) invalidPlan.push("duplicate_lane_id");
  const lanes = new Map((input.lanes || []).map((lane) => [lane.id, lane]));
  for (const lane of lanes.values()) if (lane.required === false && !clean(lane.reason)) invalidPlan.push(`lane:${lane.id}:skip_reason_missing`);
  if (![...lanes.values()].some((lane) => lane.required === true)) invalidPlan.push("required_lane_missing");

  const qualifyingSearches = new Map();
  const searchIds = (input.searches || []).map((search) => search.id);
  if (new Set(searchIds).size !== searchIds.length) invalidPlan.push("duplicate_search_id");
  for (const search of input.searches || []) {
    if (!lanes.has(search.lane_id)) { research.push(`search:${search.id}:unknown_lane`); continue; }
    if (search.status !== "complete" || search.evidence_status !== "verified" || !clean(search.source_id)) { research.push(`search:${search.id}:incomplete_or_unverified`); continue; }
    if (!sameScope(search, input)) { research.push(`search:${search.id}:scope_mismatch`); continue; }
    if (!fresh(search.searched_at, evaluatedAt, policy.max_age_days)) { research.push(`search:${search.id}:stale_or_invalid_time`); continue; }
    if (!clean(search.query_family)) { research.push(`search:${search.id}:query_family_missing`); continue; }
    qualifyingSearches.set(search.id, search);
  }

  for (const lane of lanes.values()) {
    if (lane.required !== true) continue;
    const covered = [...qualifyingSearches.values()].some((search) => search.lane_id === lane.id);
    if (!covered) research.push(`required_lane_uncovered:${lane.id}`);
  }

  const qualifying = [];
  const unresolved = new Set();
  const excluded = new Set();
  const candidateAppearances = new Map();
  const appearanceSeen = new Set();
  for (const result of input.results || []) {
    const search = qualifyingSearches.get(result.search_id);
    if (!search) { unresolved.add(result.candidate_id); continue; }
    if (!sameScope(result, input)) { unresolved.add(result.candidate_id); research.push(`candidate:${result.candidate_id}:scope_mismatch`); continue; }
    if (result.direct_source_verified !== true || result.evidence_status !== "verified" || !clean(result.source_id) || !clean(result.independence_key) || !clean(result.ownership_key)) {
      unresolved.add(result.candidate_id); research.push(`candidate:${result.candidate_id}:source_unverified`); continue;
    }
    if (result.identity_status === "different_category" || result.market_status === "unavailable" || result.hard_constraint_status === "rejected") { excluded.add(result.candidate_id); continue; }
    if (result.identity_status !== "exact_candidate" || result.market_status !== "available" || result.hard_constraint_status !== "eligible") {
      unresolved.add(result.candidate_id); research.push(`candidate:${result.candidate_id}:eligibility_unresolved`); continue;
    }
    const appearanceKey = `${clean(result.candidate_id)}\u0000${clean(result.source_id)}`;
    if (appearanceSeen.has(appearanceKey)) continue;
    appearanceSeen.add(appearanceKey);
    qualifying.push(result);
    if (!candidateAppearances.has(result.candidate_id)) candidateAppearances.set(result.candidate_id, []);
    candidateAppearances.get(result.candidate_id).push(result);
  }

  const eligibleCandidates = [...candidateAppearances.keys()];
  const independentAppearances = qualifying.filter((result) => QUALIFYING_PLACEMENTS.has(result.placement) && !NONINDEPENDENT_RELATIONSHIPS.has(result.commercial_relationship));
  const independentSources = new Set(independentAppearances.map((result) => clean(result.independence_key)));
  const queryFamilies = new Set([...qualifyingSearches.values()].map((search) => clean(search.query_family)));
  const queryTexts = new Set([...qualifyingSearches.values()].map((search) => clean(search.query_text)).filter(Boolean));
  const hasNoncommercial = independentAppearances.some((result) => result.commercial_relationship === "none");
  const paidCount = qualifying.filter((result) => ["sponsored", "affiliate"].includes(result.commercial_relationship) || ["sponsored", "affiliate"].includes(result.placement)).length;
  const paidShare = qualifying.length ? rounded(paidCount / qualifying.length) : 0;
  const ownerCounts = new Map();
  const candidateOwnerPairs = new Set();
  for (const result of independentAppearances) {
    const owner = clean(result.ownership_key);
    const pair = `${clean(result.candidate_id)}\u0000${owner}`;
    if (candidateOwnerPairs.has(pair)) continue;
    candidateOwnerPairs.add(pair);
    ownerCounts.set(owner, (ownerCounts.get(owner) || 0) + 1);
  }
  const maximumOwnerCount = Math.max(0, ...ownerCounts.values());
  const singleOwnerShare = candidateOwnerPairs.size ? rounded(maximumOwnerCount / candidateOwnerPairs.size) : 0;

  if (eligibleCandidates.length < policy.min_eligible_candidates) research.push("eligible_candidate_count_below_minimum");
  if (independentSources.size < policy.min_independent_sources) research.push("independent_source_count_below_minimum");
  if (queryFamilies.size < policy.min_query_families) research.push("query_family_count_below_minimum");
  if (queryTexts.size < policy.min_query_families) research.push("query_text_diversity_below_minimum");
  if (policy.require_noncommercial_source && !hasNoncommercial) research.push("noncommercial_source_missing");
  if (singleOwnerShare > policy.max_single_owner_share) research.push("single_owner_concentration_exceeds_policy");
  if (paidShare > policy.max_paid_placement_share) research.push("paid_placement_share_exceeds_policy");
  if (paidCount) warnings.push("sponsored_or_affiliate_results_present");
  if (!(input.lanes || []).length) invalidPlan.push("discovery_plan_missing");

  const normalizedResearch = unique([...invalidPlan, ...research]);
  const action = normalizedResearch.length ? "research_more" : "coverage_sufficient";
  return {
    category: input.category,
    market_country: input.market_country,
    evaluated_at: new Date(evaluatedAt).toISOString(),
    action,
    candidate_set_cleared_for_ranking: action === "coverage_sufficient",
    eligible_candidate_ids: eligibleCandidates,
    unresolved_candidate_ids: [...unresolved].filter((id) => !candidateAppearances.has(id)),
    excluded_candidate_ids: [...excluded].filter((id) => !candidateAppearances.has(id)),
    coverage: {
      required_lanes: [...lanes.values()].filter((lane) => lane.required).map((lane) => lane.id),
      qualifying_searches: qualifyingSearches.size,
      query_families: queryFamilies.size,
      distinct_query_texts: queryTexts.size,
      independent_sources: independentSources.size,
      eligible_candidates: eligibleCandidates.length,
      noncommercial_source_present: hasNoncommercial,
    },
    bias_indicators: { paid_placement_share: paidShare, single_owner_share: singleOwnerShare },
    research: normalizedResearch,
    warnings: unique(warnings),
    world_market_exhaustive: false,
    completeness_language: action === "coverage_sufficient" ? "bounded_declared_plan_sufficient_not_exhaustive" : "candidate_set_coverage_incomplete",
    selected_candidate: null,
    purchase_allowed: false,
  };
}
