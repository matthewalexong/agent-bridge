const DAY = 86_400_000;
const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/g, "_");
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const unique = (items) => [...new Set(items)];
const NON_NEW = new Set(["open_box", "used", "refurbished", "display_model", "for_parts"]);

function normalizedCondition(value) {
  const condition = clean(value);
  return condition === "renewed" || condition === "remanufactured" ? "refurbished" : condition;
}

function verified(fact) {
  return fact?.evidence_status === "verified" && String(fact?.source_id || "").trim();
}

function fresh(value, evaluatedAt, maxAgeDays) {
  const at = Date.parse(value || "");
  return Number.isFinite(at) && at <= evaluatedAt + 300_000 && evaluatedAt - at <= maxAgeDays * DAY;
}

function exactStatus(control, presentValue = "present") {
  if (!verified(control)) return "unknown";
  return control.value === presentValue ? "present" : control.value === "clear" || control.value === "absent" ? "clear" : "unknown";
}

export function assessShoppingCondition(input) {
  const evaluatedAt = Date.parse(input.evaluated_at || new Date().toISOString());
  if (!Number.isFinite(evaluatedAt)) throw Object.assign(new Error("Condition timestamp is invalid"), { code: "shopping_condition_invalid" });
  const policy = { max_age_days: input.policy?.max_age_days ?? 7, max_acceptance_age_seconds: input.policy?.max_acceptance_age_seconds ?? 300 };
  const offer = input.offer || {};
  const requirements = input.requirements || {};
  const condition = normalizedCondition(offer.represented_condition);
  const blockers = [];
  const research = [];
  const clarifications = [];
  const warnings = [];
  const acceptedTradeoffs = new Set((input.tradeoff_acceptances || []).filter((acceptance) => {
    const at = Date.parse(acceptance.accepted_at || "");
    const inspectedAt = Date.parse(offer.inspected_at || "");
    return acceptance.source === "current_user_message"
      && acceptance.offer_id === offer.id
      && acceptance.condition_version === offer.condition_version
      && Number.isFinite(at) && Number.isFinite(inspectedAt)
      && at >= inspectedAt && at <= evaluatedAt + 5_000
      && evaluatedAt - at <= policy.max_acceptance_age_seconds * 1_000;
  }).map((acceptance) => acceptance.id));
  const requireTradeoff = (id, code) => { if (!acceptedTradeoffs.has(id)) clarifications.push(code); };

  if (!offer.id || !offer.product_id || offer.exact_identity !== true) blockers.push("exact_offer_identity_unverified");
  if (!fresh(offer.inspected_at, evaluatedAt, policy.max_age_days)) research.push("condition_evidence_stale_or_invalid");
  if (!verified(offer.condition_claim)) research.push("represented_condition_unverified");
  if (NON_NEW.has(condition) && !offer.condition_version) research.push("condition_version_unresolved");
  if (offer.condition_inventory_complete !== true || offer.condition_inventory_evidence_status !== "verified" || !offer.condition_inventory_source_id) research.push("condition_inventory_unverified");
  const allowed = (requirements.allowed_conditions || ["new"]).map(normalizedCondition);
  if (!allowed.includes(condition)) blockers.push(`condition_not_allowed:${condition || "unknown"}`);
  if (condition === "for_parts" && requirements.allow_for_parts !== true) blockers.push("for_parts_offer_not_allowed");

  if (NON_NEW.has(condition)) {
    const grade = offer.grade || {};
    if (!grade.label || !grade.scheme_id || grade.criteria_complete !== true || !verified(grade)) research.push("condition_grade_scheme_unverified");
    warnings.push("seller_condition_grades_are_not_cross_merchant_equivalent");
    const item = offer.exact_item || {};
    if (item.unique_item === true) {
      if (item.photo_scope !== "exact_item" || !verified(item)) research.push("exact_item_photos_unverified");
      if (item.photo_item_match !== true) research.push("photos_not_bound_to_exact_item");
    } else if (item.unique_item !== false) research.push("exact_item_scope_unknown");
  }

  if (condition === "new") {
    for (const [name, fact, bad] of [
      ["seal", offer.newness?.seal_status, ["opened", "missing", "broken"]],
      ["activation", offer.newness?.activation_status, ["activated", "previously_activated"]],
      ["prior_use", offer.newness?.prior_use, [true]],
    ]) {
      if (verified(fact) && bad.includes(fact.value)) blockers.push(`new_condition_conflict:${name}`);
    }
  }

  const defects = offer.defects || {};
  if (NON_NEW.has(condition) && (defects.inventory_complete !== true || defects.evidence_status !== "verified" || !defects.source_id)) research.push("defect_inventory_unverified");
  for (const defect of defects.items || []) {
    if (!verified(defect) || defect.disclosed !== true) research.push(`defect:${defect.id}:unverified_or_undisclosed`);
    if (defect.functional === true && ["major", "critical"].includes(defect.severity)) blockers.push(`defect:${defect.id}:functional_failure`);
    else if (["moderate", "major"].includes(defect.severity)) requireTradeoff(`defect:${defect.id}`, `defect:${defect.id}:user_tolerance_required`);
  }

  const tests = offer.functional_tests || {};
  const testMap = new Map((tests.items || []).map((item) => [clean(item.id), item]));
  if ((requirements.required_function_tests || []).length && (tests.inventory_complete !== true || tests.evidence_status !== "verified" || !tests.source_id)) research.push("functional_test_inventory_unverified");
  for (const required of requirements.required_function_tests || []) {
    const test = testMap.get(clean(required));
    if (!test || !verified(test) || test.status === "not_tested" || test.status === "unknown") research.push(`functional_test:${required}:unverified`);
    else if (test.status === "fail") blockers.push(`functional_test:${required}:failed`);
  }

  if (condition === "refurbished") {
    const refurbishment = offer.refurbishment || {};
    if (!verified(refurbishment) || !refurbishment.performer || refurbishment.performer === "unknown" || !refurbishment.standard_id || refurbishment.work_inventory_complete !== true) research.push("refurbishment_provenance_unverified");
    if (requirements.require_authorized_refurbisher === true && !["manufacturer", "manufacturer_authorized"].includes(refurbishment.performer)) blockers.push("authorized_refurbisher_required");
    if (refurbishment.data_wipe_status === "failed") blockers.push("refurbishment_data_wipe_failed");
    for (const part of refurbishment.replaced_parts || []) {
      if (!verified(part)) research.push(`replacement_part:${part.id}:provenance_unverified`);
      else if (part.provenance === "unknown") research.push(`replacement_part:${part.id}:provenance_unknown`);
      else if (part.provenance === "third_party") requireTradeoff(`replacement_part:${part.id}`, `replacement_part:${part.id}:third_party_tradeoff`);
    }
  }

  if (NON_NEW.has(condition) && requirements.data_wipe_required === true) {
    const handling = offer.data_handling || offer.refurbishment;
    if (handling?.data_wipe_status === "failed" && verified(handling)) blockers.push("data_wipe_failed");
    else if (handling?.data_wipe_status !== "verified_complete" || !verified(handling)) research.push("data_wipe_unverified");
  }
  if (NON_NEW.has(condition) && requirements.sanitation_required === true) {
    const sanitation = offer.sanitation;
    if (sanitation?.status === "failed" && verified(sanitation)) blockers.push("sanitation_failed");
    else if (sanitation?.status !== "verified_complete" || !verified(sanitation)) research.push("sanitation_unverified");
  }

  if (requirements.battery_health_required === true || finite(requirements.min_battery_health_percent) || finite(requirements.max_battery_cycles)) {
    const battery = offer.battery || {};
    if (!verified(battery.health_percent) || !finite(battery.health_percent?.value)) research.push("battery_health_unverified");
    else if (finite(requirements.min_battery_health_percent) && battery.health_percent.value < requirements.min_battery_health_percent) blockers.push("battery_health_below_minimum");
    if (finite(requirements.max_battery_cycles)) {
      if (!verified(battery.cycle_count) || !Number.isInteger(battery.cycle_count?.value)) research.push("battery_cycle_count_unverified");
      else if (battery.cycle_count.value > requirements.max_battery_cycles) blockers.push("battery_cycles_above_maximum");
    }
    if (battery.status === "replaced" && (!battery.replacement_provenance || battery.replacement_provenance === "unknown")) research.push("replacement_battery_provenance_unverified");
  }

  if (requirements.device_lock_checks_required === true) {
    for (const name of ["activation_lock", "mdm_lock", "carrier_lock", "finance_balance", "lost_or_stolen_status"]) {
      const status = exactStatus(offer.locks?.[name]);
      if (status === "unknown") research.push(`device_lock:${name}:unverified`);
      else if (status === "present" && name === "carrier_lock" && requirements.carrier_lock_allowed === true) warnings.push("carrier_lock_explicitly_allowed");
      else if (status === "present") blockers.push(`device_lock:${name}:present`);
    }
  }

  const accessories = offer.accessories || {};
  if ((requirements.required_accessories || []).length && (accessories.inventory_complete !== true || accessories.evidence_status !== "verified" || !accessories.source_id)) research.push("accessory_inventory_unverified");
  const accessoryMap = new Map((accessories.items || []).map((item) => [clean(item.id), item]));
  for (const required of requirements.required_accessories || []) {
    const item = accessoryMap.get(clean(required));
    if (!item || !verified(item)) research.push(`accessory:${required}:unverified`);
    else if (item.present !== true) blockers.push(`accessory:${required}:missing`);
    else if (item.functional === false) blockers.push(`accessory:${required}:nonfunctional`);
  }

  if (condition === "display_model") requireTradeoff("display_model_exposure", "display_model_exposure_requires_acceptance");
  const normalizedBlockers = unique(blockers);
  const normalizedResearch = unique(research);
  const normalizedClarifications = unique(clarifications);
  const action = normalizedBlockers.length ? "avoid_offer" : normalizedResearch.length ? "research_more" : normalizedClarifications.length ? "clarify_tradeoff" : "eligible";
  return {
    offer_id: offer.id || null,
    product_id: offer.product_id || null,
    represented_condition: condition || null,
    evaluated_at: new Date(evaluatedAt).toISOString(),
    action,
    condition_cleared_for_offer_comparison: action === "eligible",
    blockers: normalizedBlockers,
    research: normalizedResearch,
    clarifications: normalizedClarifications,
    warnings: unique(warnings),
    selected_offer: null,
    purchase_allowed: false,
  };
}
