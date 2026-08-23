import test from "node:test";
import assert from "node:assert/strict";
import { assessShoppingCondition } from "../lib/shopping-condition.mjs";

const NOW = "2026-08-22T20:00:30.000Z";
const fact = (value, source_id = "inspection") => ({ value, evidence_status: "verified", source_id });
const base = {
  evaluated_at: NOW,
  requirements: { allowed_conditions: ["open_box"], required_function_tests: ["display", "camera"], battery_health_required: true, min_battery_health_percent: 85, max_battery_cycles: 100, device_lock_checks_required: true, required_accessories: ["charger"] },
  offer: {
    id: "offer-a", product_id: "phone-x", exact_identity: true, represented_condition: "open_box", condition_version: "inspection-v1", inspected_at: "2026-08-22T20:00:00.000Z",
    condition_claim: fact("open_box", "listing"), condition_inventory_complete: true, condition_inventory_evidence_status: "verified", condition_inventory_source_id: "inspection",
    grade: { label: "excellent", scheme_id: "seller-grade-v2", criteria_complete: true, evidence_status: "verified", source_id: "grade-policy" },
    exact_item: { unique_item: true, photo_scope: "exact_item", photo_item_match: true, evidence_status: "verified", source_id: "photo-set" },
    defects: { inventory_complete: true, evidence_status: "verified", source_id: "inspection", items: [] },
    functional_tests: { inventory_complete: true, evidence_status: "verified", source_id: "diagnostic", items: [{ id: "display", status: "pass", ...fact(true, "diagnostic") }, { id: "camera", status: "pass", ...fact(true, "diagnostic") }] },
    battery: { status: "original", health_percent: fact(94, "diagnostic"), cycle_count: fact(20, "diagnostic") },
    locks: { activation_lock: fact("clear", "device-check"), mdm_lock: fact("clear", "device-check"), carrier_lock: fact("clear", "device-check"), finance_balance: fact("clear", "device-check"), lost_or_stolen_status: fact("clear", "registry-check") },
    accessories: { inventory_complete: true, evidence_status: "verified", source_id: "inspection", items: [{ id: "charger", present: true, functional: true, ...fact(true) }] },
  },
};

test("a fully inspected exact open-box unit clears condition only", () => {
  const result = assessShoppingCondition(base);
  assert.equal(result.action, "eligible");
  assert.equal(result.condition_cleared_for_offer_comparison, true);
  assert.ok(result.warnings.includes("seller_condition_grades_are_not_cross_merchant_equivalent"));
  assert.equal(result.selected_offer, null);
  assert.equal(result.purchase_allowed, false);
});

test("seller grade and stock photos cannot prove an exact used unit", () => {
  const input = structuredClone(base);
  input.offer.exact_item.photo_scope = "stock";
  input.offer.exact_item.photo_item_match = false;
  delete input.offer.functional_tests.source_id;
  const result = assessShoppingCondition(input);
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("exact_item_photos_unverified"));
  assert.ok(result.research.includes("photos_not_bound_to_exact_item"));
  assert.ok(result.research.includes("functional_test_inventory_unverified"));
});

test("failed functional tests override an attractive non-new offer", () => {
  const input = structuredClone(base);
  input.offer.functional_tests.items[0].status = "fail";
  const result = assessShoppingCondition(input);
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("functional_test:display:failed"));
});

test("present locks block while unknown lock status remains research", () => {
  const present = structuredClone(base);
  present.offer.locks.activation_lock = fact("present");
  let result = assessShoppingCondition(present);
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("device_lock:activation_lock:present"));

  const unknown = structuredClone(base);
  unknown.offer.locks.finance_balance = { value: "clear", evidence_status: "unknown" };
  result = assessShoppingCondition(unknown);
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("device_lock:finance_balance:unverified"));

  const allowedCarrier = structuredClone(base);
  allowedCarrier.requirements.carrier_lock_allowed = true;
  allowedCarrier.offer.locks.carrier_lock = fact("present");
  result = assessShoppingCondition(allowedCarrier);
  assert.equal(result.action, "eligible");
  assert.ok(result.warnings.includes("carrier_lock_explicitly_allowed"));
});

test("battery thresholds and required accessories are hard gates", () => {
  const input = structuredClone(base);
  input.offer.battery.health_percent.value = 80;
  input.offer.battery.cycle_count.value = 150;
  input.offer.accessories.items[0].present = false;
  const result = assessShoppingCondition(input);
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("battery_health_below_minimum"));
  assert.ok(result.blockers.includes("battery_cycles_above_maximum"));
  assert.ok(result.blockers.includes("accessory:charger:missing"));
});

test("renewed is refurbished and requires refurbishment provenance", () => {
  const input = structuredClone(base);
  input.requirements.allowed_conditions = ["refurbished"];
  input.offer.represented_condition = "renewed";
  let result = assessShoppingCondition(input);
  assert.equal(result.represented_condition, "refurbished");
  assert.ok(result.research.includes("refurbishment_provenance_unverified"));
  input.offer.refurbishment = { performer: "manufacturer_authorized", standard_id: "refurb-v3", work_inventory_complete: true, data_wipe_status: "verified_complete", replaced_parts: [], evidence_status: "verified", source_id: "refurb-record" };
  result = assessShoppingCondition(input);
  assert.equal(result.action, "eligible");
});

test("third-party replacement parts require fresh exact-offer acceptance", () => {
  const input = structuredClone(base);
  input.requirements.allowed_conditions = ["refurbished"];
  input.offer.represented_condition = "refurbished";
  input.offer.refurbishment = { performer: "retailer", standard_id: "refurb-v1", work_inventory_complete: true, data_wipe_status: "verified_complete", evidence_status: "verified", source_id: "refurb-record", replaced_parts: [{ id: "screen", provenance: "third_party", evidence_status: "verified", source_id: "repair-record" }] };
  let result = assessShoppingCondition(input);
  assert.equal(result.action, "clarify_tradeoff");
  assert.ok(result.clarifications.includes("replacement_part:screen:third_party_tradeoff"));
  input.tradeoff_acceptances = [{ id: "replacement_part:screen", offer_id: "offer-a", condition_version: "inspection-v1", source: "current_user_action", accepted_at: "2026-08-22T20:00:20.000Z" }];
  result = assessShoppingCondition(input);
  assert.equal(result.action, "clarify_tradeoff");
  input.tradeoff_acceptances[0].source = "current_user_message";
  result = assessShoppingCondition(input);
  assert.equal(result.action, "eligible");
});

test("undisclosed moderate damage needs acceptance and severe functional damage blocks", () => {
  const input = structuredClone(base);
  input.offer.defects.items = [{ id: "dent", severity: "moderate", functional: false, disclosed: true, evidence_status: "verified", source_id: "photo-set" }];
  let result = assessShoppingCondition(input);
  assert.equal(result.action, "clarify_tradeoff");
  input.offer.defects.items[0] = { id: "port", severity: "critical", functional: true, disclosed: true, evidence_status: "verified", source_id: "diagnostic" };
  result = assessShoppingCondition(input);
  assert.equal(result.action, "avoid_offer");
});

test("new label cannot override verified opened, activated, or prior-use evidence", () => {
  const input = structuredClone(base);
  input.requirements = { allowed_conditions: ["new"] };
  input.offer.represented_condition = "new";
  input.offer.newness = { seal_status: fact("broken"), activation_status: fact("activated"), prior_use: fact(true) };
  const result = assessShoppingCondition(input);
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("new_condition_conflict:seal"));
  assert.ok(result.blockers.includes("new_condition_conflict:activation"));
  assert.ok(result.blockers.includes("new_condition_conflict:prior_use"));
});

test("display models never silently clear without fresh acceptance", () => {
  const input = structuredClone(base);
  input.requirements.allowed_conditions = ["display_model"];
  input.offer.represented_condition = "display_model";
  const result = assessShoppingCondition(input);
  assert.equal(result.action, "clarify_tradeoff");
  assert.ok(result.clarifications.includes("display_model_exposure_requires_acceptance"));
});

test("required data wiping and sanitation are separate non-new gates", () => {
  const input = structuredClone(base);
  input.requirements.data_wipe_required = true;
  input.requirements.sanitation_required = true;
  let result = assessShoppingCondition(input);
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("data_wipe_unverified"));
  assert.ok(result.research.includes("sanitation_unverified"));
  input.offer.data_handling = { data_wipe_status: "verified_complete", evidence_status: "verified", source_id: "wipe-record" };
  input.offer.sanitation = { status: "failed", evidence_status: "verified", source_id: "inspection" };
  result = assessShoppingCondition(input);
  assert.equal(result.action, "avoid_offer");
  assert.ok(result.blockers.includes("sanitation_failed"));
});
