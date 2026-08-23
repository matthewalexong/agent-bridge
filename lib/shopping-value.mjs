const DAY = 86_400_000;
const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const rounded = (value, digits = 6) => Number(value.toFixed(digits));
const unique = (items) => [...new Set(items)];

const UNITS = new Map(Object.entries({
  each: ["count", 1], count: ["count", 1], dozen: ["count", 12],
  mg: ["mass", 0.001], g: ["mass", 1], kg: ["mass", 1_000], oz: ["mass", 28.349523125], lb: ["mass", 453.59237],
  ml: ["volume", 1], l: ["volume", 1_000], "fl_oz_us": ["volume", 29.5735295625], gal_us: ["volume", 3_785.411784],
  mm: ["length", 1], cm: ["length", 10], m: ["length", 1_000], in: ["length", 25.4], ft: ["length", 304.8], yd: ["length", 914.4],
  mm2: ["area", 1], cm2: ["area", 100], m2: ["area", 1_000_000], in2: ["area", 645.16], ft2: ["area", 92_903.04],
  day: ["duration", 1], week: ["duration", 7], month: ["duration", 30.436875], year: ["duration", 365.2425],
  serving: ["servings", 1], use: ["uses", 1], load: ["loads", 1], dose: ["doses", 1],
}));

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return typeof value === "string" ? clean(value) : value;
}

function sameObject(a, b) {
  return JSON.stringify(stable(a || {})) === JSON.stringify(stable(b || {}));
}

function verified(fact) {
  return fact?.evidence_status === "verified" && clean(fact?.source_id);
}

function convert(value, fromUnit, toUnit, expectedDimension) {
  if (!finite(value) || value <= 0) return null;
  const from = UNITS.get(clean(fromUnit));
  const to = UNITS.get(clean(toUnit));
  if (!from || !to || from[0] !== to[0] || from[0] !== expectedDimension) return null;
  return value * from[1] / to[1];
}

function fresh(at, evaluatedAt, maxAgeDays) {
  const timestamp = Date.parse(at || "");
  return Number.isFinite(timestamp) && timestamp <= evaluatedAt + 300_000 && evaluatedAt - timestamp <= maxAgeDays * DAY;
}

function normalizedQuantity(offer, basis, reasons) {
  const packCount = offer.package?.pack_count;
  if (!verified(packCount) || !Number.isInteger(packCount?.value) || packCount.value <= 0) {
    reasons.push("pack_count_unverified");
    return null;
  }
  const fact = basis.source === "usable_yield" ? offer.usable_yield : offer.package?.net_quantity;
  if (!verified(fact)) reasons.push(`${basis.source}_unverified`);
  if (basis.source === "usable_yield") {
    if (!clean(fact?.protocol_id) || fact?.protocol_evidence_status !== "verified" || !clean(fact?.protocol_source_id)) reasons.push("yield_protocol_unverified");
    if (fact?.conditions_complete !== true || !sameObject(fact?.conditions, basis.conditions)) reasons.push("yield_conditions_incomparable");
  }
  const converted = convert(fact?.value, fact?.unit, basis.unit, basis.dimension);
  if (converted == null) reasons.push("quantity_unit_incompatible");
  return converted == null ? null : converted * packCount.value;
}

function shrinkflation(offer, basis, currentQuantity, currentUnitCost, reasons, evaluatedAt, maxAgeDays) {
  const prior = offer.prior_version;
  if (!prior) return null;
  if (prior.product_id !== offer.product_id || clean(prior.variant_id) !== clean(offer.variant_id)) {
    reasons.push("prior_version_scope_mismatch");
    return null;
  }
  if (!fresh(prior.observed_at, evaluatedAt, maxAgeDays) || prior.evidence_status !== "verified" || !clean(prior.source_id)) {
    reasons.push("prior_version_unverified_or_stale");
    return null;
  }
  const priorReasons = [];
  const priorOffer = { ...offer, package: prior.package, usable_yield: prior.usable_yield, prior_version: null };
  const priorQuantity = normalizedQuantity(priorOffer, basis, priorReasons);
  if (priorReasons.length || priorQuantity == null || !verified(prior.landed_total) || !finite(prior.landed_total.value)) {
    reasons.push("prior_value_basis_unresolved");
    return null;
  }
  const priorUnitCost = prior.landed_total.value / priorQuantity;
  const quantityChange = (currentQuantity - priorQuantity) / priorQuantity * 100;
  const unitCostChange = (currentUnitCost - priorUnitCost) / priorUnitCost * 100;
  return {
    prior_normalized_quantity: rounded(priorQuantity),
    quantity_change_percent: rounded(quantityChange, 2),
    unit_cost_change_percent: rounded(unitCostChange, 2),
    package_reduced: quantityChange < -0.01,
    unit_cost_increased: unitCostChange > 0.01,
    shrinkflation_signal: quantityChange < -0.01 && unitCostChange > 0.01,
  };
}

function assessOffer(offer, input, evaluatedAt, policy) {
  const reasons = [];
  if (offer.exact_identity !== true || !clean(offer.product_id)) reasons.push("exact_identity_unverified");
  if (!fresh(offer.captured_at, evaluatedAt, policy.max_age_days)) reasons.push("offer_value_evidence_stale_or_invalid");
  if (!verified(offer.landed_total) || !finite(offer.landed_total?.value)) reasons.push("landed_total_unverified");
  if (input.basis.quality_equivalence_required && (offer.quality_equivalent?.value !== true || !verified(offer.quality_equivalent))) reasons.push("quality_equivalence_unverified");
  const quantity = normalizedQuantity(offer, input.basis, reasons);
  const unitCost = quantity && finite(offer.landed_total?.value) ? offer.landed_total.value / quantity : null;
  const shrink = quantity && unitCost != null ? shrinkflation(offer, input.basis, quantity, unitCost, reasons, evaluatedAt, policy.max_history_age_days) : null;
  const status = reasons.length ? "research_more" : "comparable";
  return {
    offer_id: offer.id,
    product_id: offer.product_id || null,
    status,
    normalized_quantity: status === "comparable" ? rounded(quantity) : null,
    normalized_unit: input.basis.unit,
    landed_total_usd: verified(offer.landed_total) ? offer.landed_total.value : null,
    landed_unit_cost_usd: status === "comparable" ? rounded(unitCost) : null,
    shrinkflation: shrink,
    research: unique(reasons.map((reason) => `${offer.id}:${reason}`)),
    selected: false,
    purchase_allowed: false,
  };
}

export function assessShoppingValue(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Value assessment timestamp is invalid"), { code: "shopping_value_invalid" });
  const policy = { max_age_days: input.policy?.max_age_days ?? 30, max_history_age_days: input.policy?.max_history_age_days ?? 730 };
  const basisUnit = UNITS.get(clean(input.basis?.unit));
  const basisErrors = [];
  if (!basisUnit || basisUnit[0] !== input.basis?.dimension) basisErrors.push("comparison_basis_unit_invalid");
  if (input.basis?.source === "usable_yield" && input.basis.conditions_complete !== true) basisErrors.push("comparison_basis_conditions_incomplete");
  const assessments = basisErrors.length ? (input.offers || []).map((offer) => ({ offer_id: offer.id, product_id: offer.product_id || null, status: "research_more", normalized_quantity: null, normalized_unit: input.basis?.unit || null, landed_total_usd: null, landed_unit_cost_usd: null, shrinkflation: null, research: basisErrors.map((reason) => `${offer.id}:${reason}`), selected: false, purchase_allowed: false })) : (input.offers || []).map((offer) => assessOffer(offer, input, evaluatedAt, policy));
  const research = assessments.flatMap((item) => item.research);
  const action = research.length || !assessments.length ? "research_more" : "comparable";
  return {
    evaluated_at: new Date(evaluatedAt).toISOString(),
    basis: { ...input.basis, unit: clean(input.basis?.unit) },
    action,
    safe_for_value_ranking: action === "comparable",
    assessments,
    eligible_product_ids: unique(assessments.filter((item) => item.status === "comparable").map((item) => item.product_id)),
    eligible_offer_ids: assessments.filter((item) => item.status === "comparable").map((item) => item.offer_id),
    research: unique(research),
    selected_offer: null,
    purchase_allowed: false,
  };
}
