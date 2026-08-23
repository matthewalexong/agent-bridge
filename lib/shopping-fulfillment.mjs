import crypto from "node:crypto";
import { validateShoppingPromotionArtifact } from "./shopping-promotion.mjs";

const CHARGE_KINDS = ["shipping", "tax", "import_duty", "brokerage", "carrier_surcharge", "currency_conversion"];

const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const cents = (value) => Math.round(value * 100) / 100;
const unique = (items) => [...new Set(items)];
const country = (value) => typeof value === "string" && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function moneyRange(input, label, unknowns, failures) {
  if (!input || input.evidence_status === "unknown") {
    unknowns.push(`${label}:amount`);
    return null;
  }
  const exact = finite(input.amount_usd) ? input.amount_usd : null;
  const low = exact ?? input.low_usd;
  const expected = exact ?? input.expected_usd;
  const high = exact ?? input.high_usd;
  if (![low, expected, high].every(finite) || low > expected || expected > high) {
    failures.push(`${label}:invalid_range`);
    return null;
  }
  return { low_usd: cents(low), expected_usd: cents(expected), high_usd: cents(high), evidence_status: input.evidence_status };
}

function chargeRange(charge, kind, unknowns, failures) {
  if (!charge || charge.treatment === "unknown") {
    unknowns.push(`charges:${kind}`);
    return null;
  }
  if (["included", "not_applicable"].includes(charge.treatment)) {
    if (charge.evidence_status !== "verified") {
      unknowns.push(`charges:${kind}`);
      return null;
    }
    return { low_usd: 0, expected_usd: 0, high_usd: 0, evidence_status: "verified", treatment: charge.treatment };
  }
  const range = moneyRange(charge, `charges:${kind}`, unknowns, failures);
  return range ? { ...range, treatment: "amount" } : null;
}

function addRanges(ranges) {
  if (ranges.some((item) => item == null)) return null;
  return {
    low_usd: cents(ranges.reduce((sum, item) => sum + item.low_usd, 0)),
    expected_usd: cents(ranges.reduce((sum, item) => sum + item.expected_usd, 0)),
    high_usd: cents(ranges.reduce((sum, item) => sum + item.high_usd, 0)),
  };
}

function subtractRange(total, discount) {
  if (!total || !discount) return null;
  return {
    low_usd: cents(Math.max(0, total.low_usd - discount.high_usd)),
    expected_usd: cents(Math.max(0, total.expected_usd - discount.expected_usd)),
    high_usd: cents(Math.max(0, total.high_usd - discount.low_usd)),
  };
}

function exactRange(value) {
  return value && value.low_usd === value.expected_usd && value.expected_usd === value.high_usd ? value.expected_usd : null;
}

function positiveMoney(value) {
  return finite(value?.amount_usd) && value.amount_usd > 0
    || finite(value?.low_usd) && value.low_usd > 0
    || finite(value?.expected_usd) && value.expected_usd > 0
    || finite(value?.high_usd) && value.high_usd > 0;
}

function assessOne(offer, destinationCountry, requirements, evaluatedAt, promotionArtifacts, maxPromotionAgeSeconds) {
  const failures = [];
  const unknowns = [];
  const clarifications = [];
  const warnings = [];
  const origin = country(offer.ships_from_country);
  const destination = country(destinationCountry);
  const crossBorder = origin && destination ? origin !== destination : null;

  if (offer.exact_identity !== true) failures.push("identity:not_exact");
  if (offer.destination_eligible === false) failures.push("destination:ineligible");
  else if (offer.destination_eligible !== true) unknowns.push("destination:eligibility");
  if (!origin) unknowns.push("fulfillment:ships_from_country");

  const seen = new Set();
  const chargeMap = new Map();
  for (const charge of offer.charges || []) {
    if (seen.has(charge.kind)) failures.push(`charges:${charge.kind}:duplicate`);
    seen.add(charge.kind);
    chargeMap.set(charge.kind, charge);
  }
  const item = moneyRange(offer.item_price, "item_price", unknowns, failures);
  const normalizedCharges = Object.fromEntries(CHARGE_KINDS.map((kind) => [kind, chargeRange(chargeMap.get(kind), kind, unknowns, failures)]));
  const promotionCandidate = (promotionArtifacts || []).find((artifact) => artifact?.offer_id === offer.id);
  const promotionClaimed = offer.promotion_claimed === true || positiveMoney(offer.discount) || Boolean(promotionCandidate);
  const exactItem = exactRange(item);
  const exactShipping = exactRange(normalizedCharges.shipping);
  const promotion = exactItem != null && exactShipping != null ? validateShoppingPromotionArtifact({
    artifact: promotionCandidate,
    offer_id: offer.id,
    product_id: offer.product_id,
    base_price_usd: exactItem,
    shipping_usd: exactShipping,
    evaluated_at: evaluatedAt,
    max_age_seconds: maxPromotionAgeSeconds,
  }) : null;
  if (promotionClaimed && !promotion) unknowns.push("promotion:artifact_required_or_invalid");
  const advertisedDiscount = offer.discount == null ? null : moneyRange(offer.discount, "advertised_discount", unknowns, failures);
  if (promotion && advertisedDiscount && exactRange(advertisedDiscount) !== promotion.immediate_checkout_discount_usd) failures.push("promotion:discount_conflict");
  const discount = promotion
    ? { low_usd: promotion.immediate_checkout_discount_usd, expected_usd: promotion.immediate_checkout_discount_usd, high_usd: promotion.immediate_checkout_discount_usd, evidence_status: "verified" }
    : { low_usd: 0, expected_usd: 0, high_usd: 0, evidence_status: "verified" };
  const promotionObligation = promotion
    ? { low_usd: promotion.required_incremental_cost_usd, expected_usd: promotion.required_incremental_cost_usd, high_usd: promotion.required_incremental_cost_usd, evidence_status: "verified" }
    : { low_usd: 0, expected_usd: 0, high_usd: 0, evidence_status: "verified" };
  const gross = addRanges([item, ...CHARGE_KINDS.map((kind) => normalizedCharges[kind]), promotionObligation]);
  const total = subtractRange(gross, discount);
  const evidenceStatuses = [offer.item_price?.evidence_status, offer.discount?.evidence_status, ...(offer.charges || []).map((entry) => entry.evidence_status)].filter(Boolean);
  const totalStatus = total == null ? "unknown" : evidenceStatuses.every((status) => status === "verified") ? "verified" : "estimated";

  if (crossBorder === true) {
    if (!offer.incoterm || offer.incoterm === "unknown" || offer.incoterm_evidence_status !== "verified") unknowns.push("customs:incoterm");
    if (offer.customs?.restricted_or_prohibited === true) failures.push("customs:restricted_or_prohibited");
    else if (offer.customs?.restricted_or_prohibited !== false) unknowns.push("customs:restriction_status");
    if (!offer.customs?.clearance_responsibility || offer.customs.clearance_responsibility === "unknown") unknowns.push("customs:clearance_responsibility");
    if (offer.customs?.documents_complete !== true) unknowns.push("customs:documents_complete");
  }

  const delivery = offer.delivery || {};
  const earliest = Date.parse(delivery.earliest_at);
  const latest = Date.parse(delivery.latest_at);
  if (delivery.evidence_status === "unknown" || !Number.isFinite(earliest) || !Number.isFinite(latest) || earliest > latest) unknowns.push("delivery:verified_window");
  if (Number.isFinite(latest) && latest < evaluatedAt) failures.push("delivery:window_in_past");
  if (requirements.require_tracking === true && delivery.tracking_available !== true) {
    if (delivery.tracking_available === false) failures.push("delivery:tracking_unavailable");
    else unknowns.push("delivery:tracking_availability");
  }
  const requiredBy = Date.parse(requirements.required_by);
  if (Number.isFinite(requiredBy) && Number.isFinite(earliest) && Number.isFinite(latest)) {
    if (earliest > requiredBy) failures.push("delivery:misses_required_date");
    else if (latest > requiredBy) clarifications.push("delivery:window_crosses_required_date");
  }

  const returns = offer.returns || {};
  if (requirements.require_verified_return_destination === true && (returns.policy_verified !== true || !country(returns.destination_country))) unknowns.push("returns:destination");
  if (requirements.allowed_return_countries?.length) {
    const returnCountry = country(returns.destination_country);
    if (!returnCountry) unknowns.push("returns:country");
    else if (!requirements.allowed_return_countries.map(country).includes(returnCountry)) failures.push("returns:country_not_allowed");
  }
  let returnShipping = null;
  if (returns.shipping_paid_by === "seller") returnShipping = { low_usd: 0, expected_usd: 0, high_usd: 0, evidence_status: returns.policy_verified === true ? "verified" : "unknown" };
  else if (returns.shipping_paid_by === "buyer") returnShipping = moneyRange(returns.shipping_cost, "returns:shipping_cost", unknowns, failures);
  else if (requirements.require_return_cost === true) unknowns.push("returns:shipping_responsibility");
  if (crossBorder === true && returns.refundable_import_charges == null) warnings.push("returns:import_charge_refundability_unknown");

  if (finite(requirements.max_fully_landed_usd) && total) {
    const strict = requirements.max_fully_landed_operator === "lt";
    if (strict ? total.low_usd >= requirements.max_fully_landed_usd : total.low_usd > requirements.max_fully_landed_usd) failures.push("cost:minimum_exceeds_budget");
    else if (strict ? total.high_usd >= requirements.max_fully_landed_usd : total.high_usd > requirements.max_fully_landed_usd) clarifications.push("cost:range_crosses_budget");
  }

  const normalizedFailures = unique(failures);
  const normalizedUnknowns = unique(unknowns);
  const normalizedClarifications = unique(clarifications);
  let action = "eligible";
  if (normalizedFailures.length) action = "avoid_offer";
  else if (normalizedUnknowns.length) action = "research_more";
  else if (normalizedClarifications.length) action = "clarify";

  return {
    id: offer.id,
    product_id: offer.product_id || null,
    action,
    cross_border: crossBorder,
    route: { ships_from_country: origin, destination_country: destination, incoterm: offer.incoterm || null },
    fully_landed_total_usd: total,
    fully_landed_status: totalStatus,
    components: { item_price: item, advertised_discount: advertisedDiscount, immediate_discount: discount, promotion_obligation: promotionObligation, charges: normalizedCharges },
    promotion: promotion ? { artifact_evaluated_at: promotion.evaluated_at, immediate_checkout_discount_usd: promotion.immediate_checkout_discount_usd, required_incremental_cost_usd: promotion.required_incremental_cost_usd } : null,
    delivery: { earliest_at: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null, latest_at: Number.isFinite(latest) ? new Date(latest).toISOString() : null, evidence_status: delivery.evidence_status || "unknown", tracking_available: delivery.tracking_available ?? null },
    return_exposure: { destination_country: country(returns.destination_country), shipping_cost_usd: returnShipping, refundable_import_charges: returns.refundable_import_charges ?? null },
    blockers: normalizedFailures,
    research: normalizedUnknowns,
    clarifications: normalizedClarifications,
    warnings: unique(warnings),
    safe_for_offer_comparison: action === "eligible" && totalStatus !== "unknown",
    purchase_allowed: false,
  };
}

export function assessShoppingFulfillment(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Fulfillment evaluation timestamp is invalid"), { code: "shopping_fulfillment_invalid" });
  const destination = country(input.destination_country);
  if (!destination) throw Object.assign(new Error("Destination country must be an ISO alpha-2 code"), { code: "shopping_fulfillment_invalid" });
  const canonical = JSON.stringify(stable(input));
  return { artifact_id: `fulfillment_${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`, evaluated_at: new Date(evaluatedAt).toISOString(), destination_country: destination, assessments: (input.offers || []).map((offer) => assessOne(offer, destination, input.requirements || {}, evaluatedAt, input.promotion_artifacts || [], input.max_promotion_age_seconds ?? 900)) };
}
