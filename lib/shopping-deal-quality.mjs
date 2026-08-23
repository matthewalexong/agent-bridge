const finiteMoney = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const clean = (value) => String(value ?? "").trim().toLowerCase();
const same = (a, b) => clean(a) === clean(b);
const money = (value) => Math.round(value * 100) / 100;
const rounded = (value, digits = 2) => Number(value.toFixed(digits));

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function sourceKey(observation) {
  if (observation.source?.independence_key) return clean(observation.source.independence_key);
  try { return new URL(observation.source?.url).hostname.toLowerCase().replace(/^www\./, ""); } catch {}
  return clean(observation.source?.id) || "unknown";
}

function comparableObservation(current, observation, evaluatedAt, maxHistoryDays) {
  if (observation.verified !== true) return "unverified";
  if (!finiteMoney(observation.landed_total_usd) || observation.landed_total_usd === 0) return "invalid_price";
  if (!same(observation.currency || "USD", current.currency || "USD")) return "currency_mismatch";
  if (!same(observation.product_key, current.product_key)) return "product_mismatch";
  if (current.variant && !same(observation.variant, current.variant)) return "variant_mismatch";
  if (current.condition && !same(observation.condition, current.condition)) return "condition_mismatch";
  if (observation.source?.source_type === "search_snippet") return "search_snippet";
  const observedAt = Date.parse(observation.observed_at || "");
  if (!Number.isFinite(observedAt) || observedAt > evaluatedAt) return "invalid_time";
  if ((evaluatedAt - observedAt) / 86_400_000 > maxHistoryDays) return "outside_history_window";
  return null;
}

function exclusionsByReason(excluded) {
  const counts = {};
  for (const item of excluded) counts[item.reason] = (counts[item.reason] || 0) + 1;
  return counts;
}

function saleClaimAssessment(current, stats) {
  const list = current.reference_price_usd;
  const claimed = current.advertised_discount_percent;
  const computed = finiteMoney(list) && list > 0 && finiteMoney(current.landed_total_usd)
    ? rounded((1 - current.landed_total_usd / list) * 100)
    : null;
  const flags = [];
  if (typeof claimed === "number" && computed !== null && Math.abs(claimed - computed) > 1) flags.push("advertised_discount_math_mismatch");
  if (finiteMoney(list) && stats.p90_usd !== null && list > stats.p90_usd * 1.1) flags.push("inflated_reference_price_risk");
  if ((current.sale_claimed === true || typeof claimed === "number") && stats.median_usd !== null && current.landed_total_usd >= stats.median_usd * 0.98) flags.push("ordinary_price_marketed_as_sale");
  return {
    reference_price_usd: finiteMoney(list) ? money(list) : null,
    advertised_discount_percent: typeof claimed === "number" && Number.isFinite(claimed) ? rounded(claimed) : null,
    computed_reference_discount_percent: computed,
    reference_price_verified: current.reference_price_verified === true,
    flags,
    trustworthy_sale_claim: flags.length === 0 && current.reference_price_verified === true && computed !== null,
  };
}

function timingDecision(current, history, dealQuality, saleClaim, context) {
  if (current.exact_identity !== true) return { action: "research_more", reason: "exact_identity_unverified" };
  if (!finiteMoney(current.landed_total_usd) || current.landed_price_verified !== true) return { action: "research_more", reason: "landed_price_unverified" };
  if (current.stock !== "in_stock") return { action: "research_more", reason: "availability_unverified" };
  if (current.risk_status === "elevated") return { action: "avoid_offer", reason: "offer_risk_elevated" };
  if (!new Set(["low", "acceptable"]).has(current.risk_status)) return { action: "research_more", reason: "offer_risk_unresolved" };
  if (!history.sufficient) return { action: "research_more", reason: history.reason };
  if (finiteMoney(context.max_price_usd) && current.landed_total_usd > context.max_price_usd) return { action: "wait", reason: "over_user_budget" };
  if (finiteMoney(context.target_price_usd) && current.landed_total_usd <= context.target_price_usd && dealQuality !== "above_typical") return { action: "buy_now", reason: "user_target_reached" };

  if (dealQuality === "historical_low" || dealQuality === "well_below_typical" || dealQuality === "below_typical") {
    return { action: "buy_now", reason: "current_price_is_low_relative_to_verified_history" };
  }
  if (dealQuality === "above_typical") {
    return context.urgency === "immediate"
      ? { action: "buy_if_needed", reason: "urgent_need_but_price_above_typical" }
      : { action: "wait", reason: "price_above_verified_history_range" };
  }
  if (saleClaim.flags.includes("ordinary_price_marketed_as_sale")) {
    return context.urgency === "immediate"
      ? { action: "buy_if_needed", reason: "urgent_need_but_sale_is_not_historically_special" }
      : { action: "monitor", reason: "sale_is_not_historically_special" };
  }
  return context.urgency === "immediate"
    ? { action: "buy_if_needed", reason: "urgent_need_at_typical_price" }
    : { action: "monitor", reason: "price_is_typical_and_future_drop_is_unknown" };
}

export function analyzeDealQuality({ current = {}, observations = [], policy = {}, user_context = {} }) {
  const evaluatedAt = Date.parse(policy.evaluated_at || new Date().toISOString());
  const now = Number.isFinite(evaluatedAt) ? evaluatedAt : Date.now();
  const maxHistoryDays = policy.max_history_days ?? 730;
  const minObservations = policy.min_observations ?? 5;
  const minDistinctDays = policy.min_distinct_days ?? 5;
  const minSpanDays = policy.min_span_days ?? 30;
  const deduped = new Map();
  const excluded = [];

  observations.forEach((observation, index) => {
    const reason = comparableObservation(current, observation, now, maxHistoryDays);
    if (reason) { excluded.push({ index, reason }); return; }
    const timestamp = Date.parse(observation.observed_at);
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const key = `${day}|${sourceKey(observation)}|${money(observation.landed_total_usd)}`;
    if (deduped.has(key)) { excluded.push({ index, reason: "duplicate_observation" }); return; }
    deduped.set(key, { index, day, timestamp, price: money(observation.landed_total_usd), source_key: sourceKey(observation) });
  });

  const valid = [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
  const prices = valid.map((item) => item.price).sort((a, b) => a - b);
  const distinctDays = new Set(valid.map((item) => item.day)).size;
  const spanDays = valid.length > 1 ? (valid.at(-1).timestamp - valid[0].timestamp) / 86_400_000 : 0;
  const enoughObservations = valid.length >= minObservations;
  const enoughDays = distinctDays >= minDistinctDays;
  const enoughSpan = spanDays >= minSpanDays;
  const sufficient = enoughObservations && enoughDays && enoughSpan;
  const reason = sufficient ? null : !enoughObservations ? "too_few_comparable_observations" : !enoughDays ? "too_few_distinct_observation_days" : "history_window_too_short";

  const stats = {
    observation_count: valid.length,
    distinct_days: distinctDays,
    span_days: rounded(spanDays),
    minimum_usd: prices.length ? money(prices[0]) : null,
    p10_usd: prices.length ? money(percentile(prices, 0.1)) : null,
    p25_usd: prices.length ? money(percentile(prices, 0.25)) : null,
    median_usd: prices.length ? money(percentile(prices, 0.5)) : null,
    p75_usd: prices.length ? money(percentile(prices, 0.75)) : null,
    p90_usd: prices.length ? money(percentile(prices, 0.9)) : null,
    maximum_usd: prices.length ? money(prices.at(-1)) : null,
  };

  let currentPercentile = null;
  let differenceFromMedian = null;
  let dealQuality = "insufficient_evidence";
  if (sufficient && finiteMoney(current.landed_total_usd)) {
    const less = prices.filter((price) => price < current.landed_total_usd).length;
    const equal = prices.filter((price) => price === current.landed_total_usd).length;
    currentPercentile = rounded(((less + equal * 0.5) / prices.length) * 100);
    differenceFromMedian = rounded(((current.landed_total_usd - stats.median_usd) / stats.median_usd) * 100);
    if (current.landed_total_usd <= stats.minimum_usd) dealQuality = "historical_low";
    else if (current.landed_total_usd <= stats.p25_usd && differenceFromMedian <= -15) dealQuality = "well_below_typical";
    else if (current.landed_total_usd <= stats.p25_usd) dealQuality = "below_typical";
    else if (current.landed_total_usd > stats.p75_usd) dealQuality = "above_typical";
    else dealQuality = "typical";
  }

  const history = {
    sufficient,
    reason,
    requirements: { min_observations: minObservations, min_distinct_days: minDistinctDays, min_span_days: minSpanDays, max_history_days: maxHistoryDays },
    stats,
    current_price_percentile: currentPercentile,
    current_vs_median_percent: differenceFromMedian,
    excluded_observations: exclusionsByReason(excluded),
  };
  const sale_claim = saleClaimAssessment(current, stats);
  const timing = timingDecision(current, history, dealQuality, sale_claim, { urgency: user_context.urgency || "flexible", target_price_usd: user_context.target_price_usd, max_price_usd: user_context.max_price_usd });
  return {
    deal_quality: dealQuality,
    history,
    sale_claim,
    timing: { ...timing, future_price_guaranteed: false },
  };
}
