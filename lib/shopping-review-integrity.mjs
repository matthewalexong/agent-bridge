const DAY = 86_400_000;
const REPRESENTATIVE_METHODS = new Set(["complete", "random", "systematic"]);
const HARD_AUTHORITIES = new Set(["platform", "regulator", "court"]);
const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const unique = (items) => [...new Set(items)];
const rounded = (value) => Number(value.toFixed(4));

function fresh(value, evaluatedAt, maxAgeDays) {
  const at = Date.parse(value || "");
  return Number.isFinite(at) && at <= evaluatedAt + 300_000 && evaluatedAt - at <= maxAgeDays * DAY;
}

function exactScope(scope, variantRequired) {
  return variantRequired ? scope === "exact_variant" : ["exact_product", "exact_variant"].includes(scope);
}

function assessCollections(input, policy, evaluatedAt) {
  const usable = new Set();
  const byId = new Map((input.collections || []).map((item) => [item.id, item]));
  const reasons = [];
  const suppliedCounts = new Map();
  for (const review of input.reviews || []) suppliedCounts.set(review.collection_id, (suppliedCounts.get(review.collection_id) || 0) + 1);
  for (const collection of input.collections || []) {
    const prefix = `collection:${collection.id}`;
    if (collection.evidence_status !== "verified" || !clean(collection.source_id) || !clean(collection.independence_key)) reasons.push(`${prefix}:unverified`);
    else if (collection.product_id !== input.product_id || (input.variant_id && collection.variant_id !== input.variant_id)) reasons.push(`${prefix}:subject_mismatch`);
    else if (!exactScope(collection.scope_status, Boolean(input.variant_id))) reasons.push(`${prefix}:scope_unresolved`);
    else if (!fresh(collection.captured_at, evaluatedAt, policy.max_age_days)) reasons.push(`${prefix}:stale_or_invalid_time`);
    else if (policy.require_representative_sample && !REPRESENTATIVE_METHODS.has(collection.sampling_method)) reasons.push(`${prefix}:nonrepresentative_sample`);
    else if (!Number.isInteger(collection.sampled_count) || collection.sampled_count < 1 || collection.population_size < collection.sampled_count) reasons.push(`${prefix}:invalid_coverage`);
    else if (collection.sampling_method === "complete" && collection.population_size !== collection.sampled_count) reasons.push(`${prefix}:incomplete_population_export`);
    else if ((suppliedCounts.get(collection.id) || 0) !== collection.sampled_count) reasons.push(`${prefix}:sample_records_incomplete`);
    else usable.add(collection.id);
  }
  return { usable, reasons, byId };
}

function officialCompromise(input) {
  return (input.findings || []).filter((finding) =>
    finding.product_id === input.product_id
    && (input.variant_id ? (!finding.variant_id || finding.variant_id === input.variant_id) : !finding.variant_id)
    && finding.status === "active"
    && finding.applies_to_exact_product === true
    && finding.evidence_status === "verified"
    && clean(finding.source_id)
    && HARD_AUTHORITIES.has(finding.authority_type)
    && ["fake_review_enforcement", "review_suppression", "incentive_violation"].includes(finding.type));
}

function rollingBurstShare(entries, windowDays) {
  const times = entries.map((item) => Date.parse(item.published_at || "")).filter(Number.isFinite).sort((a, b) => a - b);
  if (!times.length) return null;
  let left = 0;
  let maximum = 0;
  for (let right = 0; right < times.length; right += 1) {
    while (times[right] - times[left] > windowDays * DAY) left += 1;
    maximum = Math.max(maximum, right - left + 1);
  }
  return rounded(maximum / times.length);
}

export function assessReviewIntegrity(input) {
  const parsedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(parsedAt)) throw Object.assign(new Error("Review-integrity timestamp is invalid"), { code: "shopping_review_integrity_invalid" });
  const policy = {
    max_age_days: input.policy?.max_age_days ?? 365,
    min_eligible_reviews: input.policy?.min_eligible_reviews ?? 10,
    min_independent_reviewers: input.policy?.min_independent_reviewers ?? 10,
    min_channels: input.policy?.min_channels ?? 2,
    require_representative_sample: input.policy?.require_representative_sample ?? true,
    max_duplicate_share: input.policy?.max_duplicate_share ?? 0.2,
    max_incentivized_share: input.policy?.max_incentivized_share ?? 0.2,
    max_burst_share: input.policy?.max_burst_share ?? 0.6,
    burst_window_days: input.policy?.burst_window_days ?? 2,
  };
  const collections = assessCollections(input, policy, parsedAt);
  const excluded = {};
  const exclude = (reason) => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const candidates = [];
  for (const review of input.reviews || []) {
    if (review.product_id !== input.product_id) { exclude("wrong_product"); continue; }
    if (!exactScope(review.scope_status, Boolean(input.variant_id)) || (input.variant_id && review.variant_id !== input.variant_id)) { exclude("scope_unresolved"); continue; }
    const collection = (input.collections || []).find((item) => item.id === review.collection_id);
    if (!collections.usable.has(review.collection_id)) { exclude("collection_ineligible"); continue; }
    if (!collection || review.channel_id !== collection.channel_id) { exclude("collection_channel_mismatch"); continue; }
    if (review.evidence_status !== "verified" || !clean(review.source_id)) { exclude("provenance_unverified"); continue; }
    if (!fresh(review.captured_at, parsedAt, policy.max_age_days) || !fresh(review.published_at, parsedAt, policy.max_age_days)) { exclude("stale_or_invalid_time"); continue; }
    if (review.moderation_status !== "published") { exclude("not_published"); continue; }
    if (review.incentive_status !== "none") { exclude(review.incentive_status === "disclosed" ? "incentivized" : "incentive_unknown"); continue; }
    if (!clean(review.reviewer_key)) { exclude("reviewer_identity_missing"); continue; }
    if (!clean(review.text_fingerprint) && !clean(review.syndication_key)) { exclude("content_fingerprint_missing"); continue; }
    candidates.push(review);
  }

  const contentSeen = new Set();
  const reviewerSeen = new Set();
  const eligible = [];
  let contentDuplicates = 0;
  let reviewerDuplicates = 0;
  for (const review of candidates) {
    const contentKey = clean(review.syndication_key) || clean(review.text_fingerprint);
    const reviewerKey = clean(review.reviewer_key);
    if (contentSeen.has(contentKey)) { contentDuplicates += 1; continue; }
    contentSeen.add(contentKey);
    if (reviewerSeen.has(reviewerKey)) { reviewerDuplicates += 1; continue; }
    reviewerSeen.add(reviewerKey);
    eligible.push(review);
  }

  const channels = new Set(eligible.map((item) => clean(collections.byId.get(item.collection_id)?.independence_key)).filter(Boolean));
  const total = (input.reviews || []).length;
  const incentivized = excluded.incentivized || 0;
  const duplicateShare = candidates.length ? rounded((contentDuplicates + reviewerDuplicates) / candidates.length) : 0;
  const incentivizedShare = total ? rounded(incentivized / total) : 0;
  const burstShare = rollingBurstShare(eligible, policy.burst_window_days);
  const verifiedPurchaseShare = eligible.length ? rounded(eligible.filter((item) => item.verified_purchase === true).length / eligible.length) : null;
  const unknownPurchaseShare = eligible.length ? rounded(eligible.filter((item) => item.verified_purchase == null).length / eligible.length) : null;
  const ratingCounts = new Map();
  for (const review of eligible) ratingCounts.set(review.rating, (ratingCounts.get(review.rating) || 0) + 1);
  const ratingConcentration = eligible.length ? rounded(Math.max(0, ...ratingCounts.values()) / eligible.length) : null;
  const signals = [];
  if (duplicateShare > policy.max_duplicate_share) signals.push("duplicate_share_exceeds_policy");
  if (incentivizedShare > policy.max_incentivized_share) signals.push("incentivized_share_exceeds_policy");
  if (eligible.length >= policy.min_eligible_reviews && burstShare != null && burstShare > policy.max_burst_share) signals.push("review_burst_exceeds_policy");
  if (eligible.length >= 20 && ratingConcentration > 0.95) signals.push("rating_concentration_extreme");

  const research = [...collections.reasons];
  if (!collections.usable.size) research.push("no_eligible_review_collection");
  if (eligible.length < policy.min_eligible_reviews) research.push("eligible_review_count_below_minimum");
  if (reviewerSeen.size < policy.min_independent_reviewers) research.push("independent_reviewer_count_below_minimum");
  if (channels.size < policy.min_channels) research.push("independent_channel_count_below_minimum");
  const findings = officialCompromise(input);
  let integrityStatus;
  let action;
  if (findings.length) { integrityStatus = "compromised"; action = "exclude_reviews"; }
  else if (signals.length) { integrityStatus = "limited"; action = "exclude_reviews"; }
  else if (research.length) { integrityStatus = "insufficient_evidence"; action = "research_more"; }
  else { integrityStatus = "usable"; action = "eligible_for_review_ranking"; }

  return {
    product_id: input.product_id,
    variant_id: input.variant_id || null,
    evaluated_at: new Date(parsedAt).toISOString(),
    action,
    integrity_status: integrityStatus,
    review_evidence_cleared_for_ranking: action === "eligible_for_review_ranking",
    eligible_review_ids: action === "eligible_for_review_ranking" ? eligible.map((item) => item.id) : [],
    coverage: { supplied_reviews: total, eligible_reviews: eligible.length, independent_reviewers: reviewerSeen.size, channels: channels.size, eligible_collections: collections.usable.size },
    excluded_reviews: excluded,
    indicators: { duplicate_share: duplicateShare, incentivized_share: incentivizedShare, burst_share: burstShare, rating_concentration: ratingConcentration, verified_purchase_share: verifiedPurchaseShare, verified_purchase_unknown_share: unknownPurchaseShare },
    signals,
    research: unique(research),
    official_findings: findings.map((item) => ({ id: item.id, type: item.type, authority_type: item.authority_type, source_id: item.source_id })),
    fraud_claim_allowed: findings.some((item) => ["regulator", "court"].includes(item.authority_type)),
    language_guardrail: findings.some((item) => ["regulator", "court"].includes(item.authority_type)) ? "attribute_only_the_verified_official_finding" : "describe_integrity_limits_not_fake_reviews_or_fraud",
    selected_product: null,
    purchase_allowed: false,
  };
}
