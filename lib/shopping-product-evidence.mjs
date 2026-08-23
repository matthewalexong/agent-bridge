const AUTHORITATIVE = new Set(["manufacturer", "official_manual", "regulatory"]);
const OBJECTIVE_ALLOWED = new Set(["manufacturer", "official_manual", "regulatory", "retailer", "professional_review", "marketplace_listing"]);
const REVIEW_ALLOWED = new Set(["customer_review", "professional_review"]);

const unitAliases = new Map([
  ["g", ["g", 1]], ["gram", ["g", 1]], ["grams", ["g", 1]],
  ["kg", ["g", 1000]], ["kilogram", ["g", 1000]], ["kilograms", ["g", 1000]],
  ["oz", ["g", 28.349523]], ["ounce", ["g", 28.349523]], ["ounces", ["g", 28.349523]],
  ["lb", ["g", 453.59237]], ["lbs", ["g", 453.59237]], ["pound", ["g", 453.59237]], ["pounds", ["g", 453.59237]],
  ["ml", ["ml", 1]], ["milliliter", ["ml", 1]], ["milliliters", ["ml", 1]],
  ["l", ["ml", 1000]], ["liter", ["ml", 1000]], ["liters", ["ml", 1000]],
  ["fl oz", ["ml", 29.573529]], ["fl_oz", ["ml", 29.573529]], ["fluid ounce", ["ml", 29.573529]],
  ["mm", ["mm", 1]], ["millimeter", ["mm", 1]], ["millimeters", ["mm", 1]],
  ["cm", ["mm", 10]], ["centimeter", ["mm", 10]], ["centimeters", ["mm", 10]],
  ["m", ["mm", 1000]], ["meter", ["mm", 1000]], ["meters", ["mm", 1000]],
  ["in", ["mm", 25.4]], ["inch", ["mm", 25.4]], ["inches", ["mm", 25.4]],
  ["min", ["min", 1]], ["minute", ["min", 1]], ["minutes", ["min", 1]],
  ["h", ["min", 60]], ["hr", ["min", 60]], ["hour", ["min", 60]], ["hours", ["min", 60]],
  ["gb", ["gb", 1]], ["tb", ["gb", 1000]],
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const normalizedText = (value) => clean(value).normalize("NFKC").toLowerCase();
const rounded = (value, digits = 6) => Number(value.toFixed(digits));

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

function independenceKey(source) {
  return clean(source.independence_key) || hostname(source.url) || normalizedText(source.publisher) || clean(source.id);
}

function channelKey(source) {
  return clean(source.channel) || hostname(source.url) || normalizedText(source.publisher) || clean(source.id);
}

function freshness(source, evaluatedAt, maxAgeDays) {
  const captured = Date.parse(source.captured_at || "");
  if (!Number.isFinite(captured)) return { fresh: false, age_days: null, reason: "capture_time_unknown" };
  const age = Math.max(0, (evaluatedAt - captured) / 86_400_000);
  return { fresh: age <= maxAgeDays, age_days: rounded(age, 2), reason: age <= maxAgeDays ? null : "source_stale" };
}

function normalizedValue(value, unit) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const conversion = unitAliases.get(normalizedText(unit));
    if (conversion) return { key: `n:${conversion[0]}:${rounded(value * conversion[1])}`, value: rounded(value * conversion[1]), unit: conversion[0] };
    return { key: `n:${normalizedText(unit)}:${rounded(value)}`, value: rounded(value), unit: clean(unit) || null };
  }
  if (typeof value === "boolean") return { key: `b:${value}`, value, unit: null };
  if (Array.isArray(value)) {
    const items = value.map(normalizedText).filter(Boolean).sort();
    return { key: `a:${JSON.stringify(items)}`, value: items, unit: null };
  }
  const text = normalizedText(value);
  return { key: `s:${text}`, value: clean(value), unit: clean(unit) || null };
}

function sourceSummary(claim, fresh) {
  return {
    id: claim.source.id,
    source_type: claim.source.source_type,
    publisher: claim.source.publisher || null,
    url: claim.source.url || null,
    captured_at: claim.source.captured_at || null,
    independence_key: independenceKey(claim.source),
    fresh: fresh.fresh,
    age_days: fresh.age_days,
    excerpt: clean(claim.excerpt).slice(0, 500) || null,
  };
}

function aggregateObjective(productId, attribute, claims, policy) {
  const prepared = claims.map((claim) => {
    const fresh = freshness(claim.source, policy.evaluatedAt, policy.maxAgeDays);
    return { claim, fresh, normalized: normalizedValue(claim.value, claim.unit), source: sourceSummary(claim, fresh) };
  });
  const credible = prepared.filter(({ claim }) => claim.evidence_role !== "measured_performance" && OBJECTIVE_ALLOWED.has(claim.source.source_type));
  const usable = credible.filter(({ fresh }) => fresh.fresh);
  const roles = new Set(usable.map(({ claim }) => claim.evidence_role || "declared_specification"));
  const groups = new Map();
  for (const item of usable) {
    if (!groups.has(item.normalized.key)) groups.set(item.normalized.key, { ...item.normalized, sources: new Map() });
    groups.get(item.normalized.key).sources.set(item.source.independence_key, item.source);
  }

  const values = [...groups.values()].map((group) => {
    const sources = [...group.sources.values()];
    return {
      value: group.value,
      unit: group.unit,
      independent_sources: sources.length,
      authoritative: sources.some((source) => AUTHORITATIVE.has(source.source_type)),
      sources,
    };
  });

  let status = "insufficient_evidence";
  let reason = "corroboration_required";
  if (!usable.length && credible.length) { status = "stale"; reason = "no_fresh_sources"; }
  else if (!usable.length) reason = "no_eligible_sources";
  else if (roles.size > 1) { status = "conflict"; reason = "evidence_roles_conflict"; }
  else if (values.length > 1) { status = "conflict"; reason = "fresh_sources_disagree"; }
  else if (values[0]?.authoritative || values[0]?.independent_sources >= policy.minIndependentSources) { status = "verified"; reason = values[0].authoritative ? "authoritative_source" : "independent_corroboration"; }

  const chosen = status === "verified" ? values[0] : null;
  return {
    product_id: productId,
    attribute,
    evidence_role: status === "verified" ? [...roles][0] : null,
    status,
    reason,
    value: chosen?.value ?? null,
    unit: chosen?.unit ?? null,
    independent_sources: chosen?.independent_sources ?? 0,
    values,
    excluded_claims: prepared.filter(({ claim }) => claim.evidence_role === "measured_performance" || !OBJECTIVE_ALLOWED.has(claim.source.source_type)).length,
  };
}

function reviewFingerprint(claim) {
  return clean(claim.source.independence_key) || normalizedText(claim.excerpt) || clean(claim.source.id);
}

function aggregateReviewTheme(productId, attribute, claims, policy, integrity) {
  const unique = new Map();
  const allowedReviewIds = new Set(integrity?.eligible_review_ids || []);
  for (const claim of claims) {
    const fresh = freshness(claim.source, policy.evaluatedAt, policy.maxAgeDays);
    if (integrity?.action !== "eligible_for_review_ranking" || !allowedReviewIds.has(claim.review_id) || !fresh.fresh || !REVIEW_ALLOWED.has(claim.source.source_type)) continue;
    const fingerprint = reviewFingerprint(claim);
    if (!fingerprint || unique.has(fingerprint)) continue;
    unique.set(fingerprint, { claim, source: sourceSummary(claim, fresh) });
  }
  const entries = [...unique.values()];
  const counts = { positive: 0, negative: 0, mixed: 0, neutral: 0 };
  for (const { claim } of entries) counts[claim.sentiment] += 1;
  const relevant = counts.positive + counts.negative + counts.mixed;
  const channels = new Set(entries.map(({ claim }) => channelKey(claim.source)).filter(Boolean));
  const enough = relevant >= policy.minRelevantReviews && channels.size >= policy.minReviewChannels;
  const score = relevant ? (counts.positive + counts.mixed * 0.5) / relevant : null;
  const direction = !enough ? "insufficient_evidence" : score >= 2 / 3 ? "positive" : score <= 1 / 3 ? "negative" : "mixed";
  return {
    product_id: productId,
    attribute,
    status: enough ? "supported" : "insufficient_evidence",
    reason: integrity?.action === "eligible_for_review_ranking" ? (enough ? "integrity_gated_support" : "theme_support_below_minimum") : "review_integrity_clearance_required",
    direction,
    sentiment_score: enough ? rounded(score) : null,
    usable_for_ranking: enough,
    relevant_reviews: relevant,
    independent_reviews: entries.length,
    review_channels: channels.size,
    counts,
    evidence: entries.slice(0, 20).map(({ claim, source }) => ({ sentiment: claim.sentiment, source, excerpt: clean(claim.excerpt).slice(0, 500) })),
  };
}

export function aggregateProductEvidence({ claims = [], policy = {}, review_integrity = [], performance_evidence = [] }) {
  const evaluatedAtParsed = Date.parse(policy.evaluated_at || new Date().toISOString());
  const normalizedPolicy = {
    evaluatedAt: Number.isFinite(evaluatedAtParsed) ? evaluatedAtParsed : Date.now(),
    maxAgeDays: policy.max_age_days ?? 30,
    minIndependentSources: policy.min_independent_sources ?? 2,
    minRelevantReviews: policy.min_relevant_reviews ?? 3,
    minReviewChannels: policy.min_review_channels ?? 1,
  };
  const objectiveGroups = new Map();
  const reviewGroups = new Map();
  const integrityByProduct = new Map(review_integrity.map((artifact) => [artifact.product_id, artifact]));
  const performanceByProduct = new Map();
  for (const artifact of performance_evidence) {
    if (!performanceByProduct.has(artifact.product_id)) performanceByProduct.set(artifact.product_id, []);
    performanceByProduct.get(artifact.product_id).push(artifact);
  }
  for (const claim of claims) {
    const key = `${claim.product_id}\u0000${claim.attribute}`;
    const groups = claim.claim_type === "review" ? reviewGroups : objectiveGroups;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim);
  }

  const objective_claims = [...objectiveGroups.entries()].map(([key, grouped]) => {
    const [productId, attribute] = key.split("\u0000");
    return aggregateObjective(productId, attribute, grouped, normalizedPolicy);
  });
  const review_themes = [...reviewGroups.entries()].map(([key, grouped]) => {
    const [productId, attribute] = key.split("\u0000");
    return aggregateReviewTheme(productId, attribute, grouped, normalizedPolicy, integrityByProduct.get(productId));
  });

  const products = [];
  const productIds = new Set([...claims.map((claim) => claim.product_id), ...performance_evidence.map((artifact) => artifact.product_id)]);
  for (const id of productIds) {
    const verified_attributes = {};
    const attribute_evidence = {};
    const attribute_roles = {};
    for (const result of objective_claims.filter((claim) => claim.product_id === id)) {
      attribute_evidence[result.attribute] = result.status;
      if (result.status === "verified") { verified_attributes[result.attribute] = result.value; attribute_roles[result.attribute] = result.evidence_role; }
    }
    const review_metrics = {};
    for (const result of review_themes.filter((theme) => theme.product_id === id)) {
      if (result.usable_for_ranking) {
        review_metrics[`review:${result.attribute}`] = result.sentiment_score;
        attribute_evidence[`review:${result.attribute}`] = "verified";
        attribute_roles[`review:${result.attribute}`] = "review_theme";
      } else attribute_evidence[`review:${result.attribute}`] = "insufficient_evidence";
    }
    const performance_metrics = {};
    for (const artifact of performanceByProduct.get(id) || []) {
      attribute_evidence[artifact.attribute] = artifact.action === "comparable" && artifact.performance_cleared_for_ranking === true && artifact.metric?.attribute === artifact.attribute ? "verified" : "insufficient_evidence";
      if (attribute_evidence[artifact.attribute] === "verified") {
        verified_attributes[artifact.attribute] = artifact.metric.value;
        performance_metrics[artifact.attribute] = artifact.metric;
        attribute_roles[artifact.attribute] = "measured_performance";
      }
    }
    products.push({ id, verified_attributes, attribute_evidence, attribute_roles, review_metrics, performance_metrics });
  }
  return { policy: { evaluated_at: new Date(normalizedPolicy.evaluatedAt).toISOString(), max_age_days: normalizedPolicy.maxAgeDays, min_independent_sources: normalizedPolicy.minIndependentSources, min_relevant_reviews: normalizedPolicy.minRelevantReviews, min_review_channels: normalizedPolicy.minReviewChannels }, review_integrity_required: true, objective_claims, review_themes, products };
}
