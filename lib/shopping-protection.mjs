import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const rounded = (value) => Number(value.toFixed(2));
const REPAIR_RANK = new Map([["unknown", null], ["weak", 0], ["moderate", 1], ["strong", 2]]);
const DIRECTIONS = { return_window: "max", return_cost: "min", warranty_duration: "max", warranty_claim_cost: "min", repairability: "max", downtime: "min", buyer_protection: "max" };

function unknownRange() { return { low_usd: 0, expected_usd: null, high_usd: null }; }

function moneyRange(input) {
  if (!input || input.evidence_status === "unknown") return unknownRange();
  let low = input.low_usd;
  let expected = input.expected_usd;
  let high = input.high_usd;
  if (input.evidence_status === "verified" && finite(expected)) { low ??= expected; high ??= expected; }
  if (!finite(low) || !finite(high) || low < 0 || high < low) return unknownRange();
  if (!finite(expected) || expected < low || expected > high) expected = (low + high) / 2;
  return { low_usd: rounded(low), expected_usd: rounded(expected), high_usd: rounded(high) };
}

function addRanges(...ranges) {
  return ranges.reduce((total, range) => ({
    low_usd: rounded(total.low_usd + range.low_usd),
    expected_usd: total.expected_usd === null || range.expected_usd === null ? null : rounded(total.expected_usd + range.expected_usd),
    high_usd: total.high_usd === null || range.high_usd === null ? null : rounded(total.high_usd + range.high_usd),
  }), { low_usd: 0, expected_usd: 0, high_usd: 0 });
}

function scaleRange(range, factor) {
  if (!finite(factor) || factor < 0) return unknownRange();
  return { low_usd: rounded(range.low_usd * factor), expected_usd: range.expected_usd === null ? null : rounded(range.expected_usd * factor), high_usd: range.high_usd === null ? null : rounded(range.high_usd * factor) };
}

function itemPriceRange(candidate) {
  if (candidate.price_verified !== true || !finite(candidate.item_price_usd)) return unknownRange();
  return { low_usd: candidate.item_price_usd, expected_usd: candidate.item_price_usd, high_usd: candidate.item_price_usd };
}

function returnExposure(candidate) {
  const policy = candidate.returns || {};
  if (policy.policy_verified !== true || policy.final_sale == null) return { kind: "unknown", cost: unknownRange(), unknowns: ["returns:policy"] };
  if (policy.final_sale === true) {
    const landed = candidate.landed_price_verified === true && finite(candidate.landed_total_usd)
      ? { low_usd: candidate.landed_total_usd, expected_usd: candidate.landed_total_usd, high_usd: candidate.landed_total_usd }
      : unknownRange();
    return { kind: "nonreturnable_purchase_exposure", cost: landed, unknowns: landed.high_usd === null ? ["returns:landed_total"] : [] };
  }
  const unknowns = [];
  let restocking = unknownRange();
  if (finite(policy.restocking_fee_percent)) restocking = scaleRange(itemPriceRange(candidate), policy.restocking_fee_percent / 100);
  else unknowns.push("returns:restocking_fee");

  let returnShipping = { low_usd: 0, expected_usd: 0, high_usd: 0 };
  if (policy.return_shipping_paid_by === "buyer") {
    returnShipping = moneyRange(policy.return_shipping_cost_usd);
    if (returnShipping.high_usd === null) unknowns.push("returns:return_shipping_cost");
  } else if (policy.return_shipping_paid_by !== "seller") {
    returnShipping = unknownRange();
    unknowns.push("returns:return_shipping_responsibility");
  }

  let originalShipping = { low_usd: 0, expected_usd: 0, high_usd: 0 };
  if (policy.original_shipping_refundable === false) {
    if (candidate.shipping_verified === true && finite(candidate.shipping_usd)) originalShipping = { low_usd: candidate.shipping_usd, expected_usd: candidate.shipping_usd, high_usd: candidate.shipping_usd };
    else { originalShipping = unknownRange(); unknowns.push("returns:original_shipping"); }
  } else if (policy.original_shipping_refundable !== true) {
    originalShipping = unknownRange();
    unknowns.push("returns:original_shipping_refundability");
  }
  return { kind: "return_transaction_cost", cost: addRanges(restocking, returnShipping, originalShipping), unknowns };
}

function warrantyValidity(candidate) {
  const warranty = candidate.warranty || {};
  if (warranty.policy_verified !== true || !warranty.provider) return { status: "unknown", reason: "warranty_policy_unverified" };
  if (warranty.provider === "none") return { status: "none", reason: "no_warranty" };
  if (warranty.authorized_seller_required === true) {
    if (candidate.seller_authorized === false) return { status: "invalid", reason: "seller_not_authorized_for_warranty" };
    if (candidate.seller_authorized !== true) return { status: "unknown", reason: "seller_authorization_unknown" };
  }
  if (warranty.registration_required === true && warranty.registration_deadline_days == null) return { status: "unknown", reason: "registration_deadline_unknown" };
  return { status: "valid", reason: "verified_policy_and_eligibility" };
}

function warrantyClaimExposure(candidate, validity) {
  if (validity.status === "none" || validity.status === "invalid") {
    const uncovered = moneyRange(candidate.warranty?.uncovered_repair_cost_usd);
    return { cost: uncovered, unknowns: uncovered.high_usd === null ? ["warranty:uncovered_repair_cost"] : [] };
  }
  if (validity.status !== "valid") return { cost: unknownRange(), unknowns: ["warranty:validity"] };
  const warranty = candidate.warranty || {};
  const unknowns = [];
  const deductible = moneyRange(warranty.deductible_usd);
  if (deductible.high_usd === null) unknowns.push("warranty:deductible");
  const shipping = warranty.claim_shipping_paid_by === "provider"
    ? { low_usd: 0, expected_usd: 0, high_usd: 0 }
    : moneyRange(warranty.claim_shipping_cost_usd);
  if (shipping.high_usd === null) unknowns.push("warranty:claim_shipping_cost");
  let uncovered = { low_usd: 0, expected_usd: 0, high_usd: 0 };
  if (warranty.parts_covered !== true || warranty.labor_covered !== true) {
    uncovered = moneyRange(warranty.uncovered_repair_cost_usd);
    if (uncovered.high_usd === null) unknowns.push("warranty:uncovered_repair_cost");
  }
  return { cost: addRanges(deductible, shipping, uncovered), unknowns };
}

function repairability(candidate) {
  const repair = candidate.repairability || {};
  if (repair.evidence_verified !== true) return "unknown";
  const known = repair.parts_availability && repair.parts_availability !== "unknown" && repair.manual_availability && repair.manual_availability !== "unknown" && repair.critical_components_replaceable != null;
  if (!known) return "unknown";
  if (repair.parts_availability === "unavailable" || repair.manual_availability === "none" || repair.critical_components_replaceable === false) return "weak";
  if (repair.parts_availability === "widely_available" && ["official", "third_party"].includes(repair.manual_availability) && repair.critical_components_replaceable === true) return "strong";
  return "moderate";
}

function addDays(iso, days) {
  const time = Date.parse(iso || "");
  return Number.isFinite(time) && Number.isInteger(days) ? new Date(time + days * 86_400_000).toISOString() : null;
}

function addMonths(iso, months) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time) || !Number.isInteger(months)) return null;
  const date = new Date(time);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

function assessCandidate(candidate, requirements) {
  const failures = [];
  const unknowns = [];
  const returns = candidate.returns || {};
  const return_exposure = returnExposure(candidate);
  const warranty_validity = warrantyValidity(candidate);
  const warranty_claim_exposure = warrantyClaimExposure(candidate, warranty_validity);
  const repairability_level = repairability(candidate);

  if (requirements.policy_inventory_required === true) {
    if (returns.policy_verified !== true || returns.final_sale == null) unknowns.push("returns:policy");
    else if (returns.final_sale === false && !finite(returns.window_days)) unknowns.push("returns:window");
    if (candidate.warranty?.policy_verified !== true || !candidate.warranty?.provider) unknowns.push("warranty:policy");
    else if (candidate.warranty.provider !== "none" && !finite(candidate.warranty.duration_months)) unknowns.push("warranty:duration");
  }

  if (requirements.returns_required === true) {
    if (returns.policy_verified !== true || returns.final_sale == null) unknowns.push("returns:policy");
    else if (returns.final_sale) failures.push("final_sale");
    if (returns.window_days == null) unknowns.push("returns:window");
    else if (finite(requirements.min_return_window_days) && returns.window_days < requirements.min_return_window_days) failures.push("return_window_too_short");
  }
  if (requirements.opened_returns_required === true) {
    if (!returns.opened_items || returns.opened_items === "unknown") unknowns.push("returns:opened_items");
    else if (returns.opened_items !== "accepted") failures.push("opened_returns_not_allowed");
  }
  if (finite(requirements.max_return_cost_usd)) {
    if (return_exposure.cost.high_usd === null) unknowns.push(...return_exposure.unknowns);
    else if (return_exposure.cost.high_usd > requirements.max_return_cost_usd) failures.push("return_cost_too_high");
  }

  const warranty = candidate.warranty || {};
  if (requirements.warranty_required === true) {
    if (warranty_validity.status === "unknown") unknowns.push(`warranty:${warranty_validity.reason}`);
    else if (warranty_validity.status !== "valid") failures.push(warranty_validity.reason);
  }
  if (requirements.manufacturer_warranty_required === true) {
    if (!warranty.provider) unknowns.push("warranty:provider");
    else if (warranty.provider !== "manufacturer") failures.push("manufacturer_warranty_required");
  }
  if (finite(requirements.min_warranty_months)) {
    if (!finite(warranty.duration_months)) unknowns.push("warranty:duration");
    else if (warranty.duration_months < requirements.min_warranty_months) failures.push("warranty_too_short");
  }
  if (requirements.parts_and_labor_required === true) {
    if (warranty.parts_covered == null || warranty.labor_covered == null) unknowns.push("warranty:parts_and_labor");
    else if (!warranty.parts_covered || !warranty.labor_covered) failures.push("parts_and_labor_not_covered");
  }
  if (finite(requirements.max_warranty_claim_cost_usd)) {
    if (warranty_claim_exposure.cost.high_usd === null) unknowns.push(...warranty_claim_exposure.unknowns);
    else if (warranty_claim_exposure.cost.high_usd > requirements.max_warranty_claim_cost_usd) failures.push("warranty_claim_cost_too_high");
  }
  if (requirements.repair_parts_required === true) {
    if (candidate.repairability?.evidence_verified !== true || !candidate.repairability?.parts_availability || candidate.repairability.parts_availability === "unknown") unknowns.push("repairability:parts");
    else if (["limited", "unavailable"].includes(candidate.repairability.parts_availability)) failures.push("repair_parts_unavailable");
  }
  if (requirements.repair_manual_required === true) {
    if (candidate.repairability?.evidence_verified !== true || !candidate.repairability?.manual_availability || candidate.repairability.manual_availability === "unknown") unknowns.push("repairability:manual");
    else if (candidate.repairability.manual_availability === "none") failures.push("repair_manual_unavailable");
  }
  if (finite(requirements.max_downtime_days)) {
    if (!finite(warranty.estimated_downtime_days_high)) unknowns.push("warranty:downtime");
    else if (warranty.estimated_downtime_days_high > requirements.max_downtime_days) failures.push("warranty_downtime_too_long");
  }
  if (finite(requirements.min_buyer_protection_days)) {
    if (!finite(candidate.buyer_protection?.window_days)) unknowns.push("buyer_protection:window");
    else if (candidate.buyer_protection.window_days < requirements.min_buyer_protection_days) failures.push("buyer_protection_too_short");
  }

  const returnStart = returns.window_starts_on === "purchase" ? candidate.purchase_date : candidate.delivered_at;
  return {
    id: candidate.id,
    product_id: candidate.product_id ?? null,
    variant: candidate.variant ?? null,
    condition: candidate.condition || "new",
    seller: candidate.seller ?? null,
    policy_snapshot: {
      item_price_usd: candidate.item_price_usd ?? null,
      price_verified: candidate.price_verified === true,
      shipping_usd: candidate.shipping_usd ?? null,
      shipping_verified: candidate.shipping_verified === true,
      landed_total_usd: candidate.landed_total_usd ?? null,
      landed_price_verified: candidate.landed_price_verified === true,
      seller_authorized: candidate.seller_authorized ?? null,
      returns: structuredClone(candidate.returns || {}),
      warranty: structuredClone(candidate.warranty || {}),
      repairability: structuredClone(candidate.repairability || {}),
      buyer_protection: structuredClone(candidate.buyer_protection || {}),
    },
    status: failures.length ? "rejected" : unknowns.length ? "needs_research" : "eligible",
    purchase_gate: failures.length ? "avoid_offer" : unknowns.length ? "research_more" : "eligible_for_offer_analysis",
    failures: [...new Set(failures)],
    critical_unknowns: [...new Set(unknowns)],
    return_exposure,
    warranty_validity,
    warranty_claim_exposure,
    repairability: repairability_level,
    deadlines: {
      return_deadline: addDays(returnStart, returns.window_days),
      warranty_expiration: addMonths(candidate.purchase_date, warranty.duration_months),
      warranty_registration_deadline: warranty.registration_required ? addDays(candidate.purchase_date, warranty.registration_deadline_days) : null,
      buyer_protection_deadline: addDays(candidate.purchase_date, candidate.buyer_protection?.window_days),
    },
    metrics: {
      return_window: finite(returns.window_days) ? returns.window_days : null,
      return_cost: return_exposure.cost.high_usd,
      warranty_duration: warranty_validity.status === "valid" && finite(warranty.duration_months) ? warranty.duration_months : null,
      warranty_claim_cost: warranty_claim_exposure.cost.high_usd,
      repairability: REPAIR_RANK.get(repairability_level),
      downtime: finite(warranty.estimated_downtime_days_high) ? warranty.estimated_downtime_days_high : null,
      buyer_protection: finite(candidate.buyer_protection?.window_days) ? candidate.buyer_protection.window_days : null,
    },
  };
}

function compareMetric(left, right, priority) {
  const direction = DIRECTIONS[priority];
  if (left === right) return 0;
  return direction === "min" ? (left < right ? 1 : -1) : (left > right ? 1 : -1);
}

export function validateProtectionAssessment({ artifact, offer, evaluated_at = Date.now(), max_age_seconds = 3_600 }) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  if (!verifyShoppingArtifactAttestation("protection", artifact)) return null;
  if (!artifact?.evaluated_at || !Array.isArray(artifact.assessments) || !Number.isFinite(evaluatedAt)) return null;
  const artifactAt = Date.parse(artifact.evaluated_at);
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > max_age_seconds * 1_000) return null;
  const assessment = artifact.assessments.find((candidate) => same(candidate?.id, offer?.id));
  if (!assessment || !same(assessment.product_id, offer?.product_key) || !assessment.seller || !same(assessment.seller, offer?.seller)) return null;
  if (assessment.variant != null && !same(assessment.variant, offer?.variant)) return null;
  if (!same(assessment.condition, offer?.condition || "new")) return null;
  if (!["eligible", "needs_research", "rejected"].includes(assessment.status)) return null;
  const expectedGate = assessment.status === "eligible" ? "eligible_for_offer_analysis" : assessment.status === "needs_research" ? "research_more" : "avoid_offer";
  return assessment.purchase_gate === expectedGate ? assessment : null;
}

function assessShoppingProtectionUnsigned({ requirements = {}, priorities = [], decision_mode = "pareto", candidates = [], evaluated_at = null }) {
  const assessments = candidates.map((candidate) => assessCandidate(candidate, requirements));
  const contenders = assessments.filter((candidate) => candidate.status !== "rejected");
  const evaluated = new Date(evaluated_at || Date.now()).toISOString();
  if (!contenders.length) return { evaluated_at: evaluated, assessments, decision: { action: "research_more", selected_candidate: null, reason: "no_candidate_meets_protection_requirements", research: [] } };

  const priorityUnknowns = contenders.flatMap((candidate) => priorities.filter((priority) => candidate.metrics[priority] == null).map((priority) => ({ candidate_id: candidate.id, field: priority })));
  const hardUnknowns = contenders.flatMap((candidate) => candidate.critical_unknowns.map((field) => ({ candidate_id: candidate.id, field })));
  const research = [...hardUnknowns, ...priorityUnknowns].filter((item, index, all) => all.findIndex((other) => other.candidate_id === item.candidate_id && other.field === item.field) === index);
  if (research.length) return { evaluated_at: evaluated, assessments, decision: { action: "research_more", selected_candidate: null, reason: "protection_evidence_could_change_decision", research } };

  if (contenders.length === 1) return { evaluated_at: evaluated, assessments, decision: { action: "select", selected_candidate: contenders[0].id, reason: "only_protection_eligible_candidate" } };
  if (!priorities.length) return { evaluated_at: evaluated, assessments, decision: { action: "clarify", selected_candidate: null, reason: "protection_priorities_required" } };

  if (decision_mode === "lexicographic") {
    let tied = [...contenders];
    for (const priority of priorities) {
      const values = tied.map((candidate) => candidate.metrics[priority]);
      const best = DIRECTIONS[priority] === "min" ? Math.min(...values) : Math.max(...values);
      tied = tied.filter((candidate) => candidate.metrics[priority] === best);
      if (tied.length === 1) return { evaluated_at: evaluated, assessments, decision: { action: "select", selected_candidate: tied[0].id, reason: "lexicographic_protection_winner", decisive_priority: priority } };
    }
    return { evaluated_at: evaluated, assessments, decision: { action: "clarify", selected_candidate: null, reason: "protection_metrics_tied" } };
  }

  const winner = contenders.find((candidate) => contenders.every((other) => {
    if (other.id === candidate.id) return true;
    const comparisons = priorities.map((priority) => compareMetric(candidate.metrics[priority], other.metrics[priority], priority));
    return comparisons.every((result) => result >= 0) && comparisons.some((result) => result > 0);
  }));
  return winner
    ? { evaluated_at: evaluated, assessments, decision: { action: "select", selected_candidate: winner.id, reason: "pareto_dominant_protection" } }
    : { evaluated_at: evaluated, assessments, decision: { action: "clarify", selected_candidate: null, reason: "protection_tradeoffs_require_user_priority", tradeoff_priorities: priorities } };
}

export function assessShoppingProtection(input) {
  return attestShoppingArtifact("protection", assessShoppingProtectionUnsigned(input));
}
