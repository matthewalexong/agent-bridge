import assert from "node:assert/strict";
import test from "node:test";
import { assessShoppingLifecycle } from "../lib/shopping-lifecycle.mjs";

const date = (value, evidence_status = "verified") => ({ date: value, evidence_status });
const money = (expected, evidence_status = "verified") => ({ expected_usd: expected, evidence_status });
const base = (id, overrides = {}) => ({
  id,
  identity_verified: true,
  support: {
    security_updates_until: date("2030-01-31T12:00:00.000Z"),
    functional_updates_until: date("2030-01-31T12:00:00.000Z"),
    cloud_service_commitment_until: date("2030-01-31T12:00:00.000Z"),
    repair_support_until: date("2030-01-31T12:00:00.000Z"),
    end_of_support: date("2030-01-31T12:00:00.000Z"),
  },
  ecosystem: {
    cloud_required: false,
    vendor_shutdown_effect: "none",
    interoperability: { standard: "Matter", open_standard: true, evidence_status: "verified" },
    data_export: { available: true, formats: ["json"], evidence_status: "verified" },
    proprietary_consumables: false,
    proprietary_connector: false,
    proprietary_file_format: false,
    account_transferable: true,
  },
  migration: { cost_usd: money(0), path_verified: true },
  continuity: [],
  ...overrides,
});

const run = (candidates, extra = {}) => assessShoppingLifecycle({ evaluated_at: "2026-01-31T12:00:00.000Z", horizon_months: 36, candidates, ...extra });

test("verified support and open interoperability produce a resilient gate", () => {
  const result = run([base("resilient")]);
  assert.equal(result.horizon_end, "2029-01-31T12:00:00.000Z");
  assert.equal(result.assessments[0].status, "resilient");
  assert.equal(result.assessments[0].purchase_gate, "eligible_for_ranking");
  assert.ok(result.assessments[0].resilience_signals.includes("core_function_offline_capable"));
  assert.equal(result.decision.selects_product, false);
});

test("required security support shorter than the horizon rejects a connected product", () => {
  const candidate = base("short", { support: { ...base("x").support, security_updates_until: date("2028-01-31T12:00:00.000Z") } });
  const result = run([candidate], { requirements: { security_updates_required: true } }).assessments[0];
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.failures, ["security_support_shorter_than_required_horizon"]);
});

test("unknown security commitment triggers research rather than assumed coverage", () => {
  const candidate = base("unknown", { support: { ...base("x").support, security_updates_until: { evidence_status: "unknown" } } });
  const result = run([candidate], { requirements: { security_updates_required: true } }).assessments[0];
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.critical_unknowns, ["support:security_updates_until"]);
});

test("an estimated support date cannot satisfy a hard support requirement", () => {
  const candidate = base("estimated", { support: { ...base("x").support, security_updates_until: date("2030-01-31T12:00:00.000Z", "estimated") } });
  const result = run([candidate], { requirements: { security_updates_required: true } }).assessments[0];
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.critical_unknowns, ["support:security_updates_until"]);
});

test("cloud shutdown core loss is an exposed tradeoff even with a current commitment", () => {
  const candidate = base("cloud", { ecosystem: { ...base("x").ecosystem, cloud_required: true, vendor_shutdown_effect: "core_function_loss" } });
  const result = run([candidate]).assessments[0];
  assert.equal(result.status, "exposed");
  assert.deepEqual(result.exposures, ["vendor_shutdown_causes_core_function_loss"]);
  assert.equal(result.purchase_gate, "clarify_tradeoff");
});

test("offline-operation requirement rejects a cloud-required core", () => {
  const candidate = base("cloud", { ecosystem: { ...base("x").ecosystem, cloud_required: true, vendor_shutdown_effect: "degraded" } });
  const result = run([candidate], { requirements: { offline_operation_required: true } }).assessments[0];
  assert.ok(result.failures.includes("offline_operation_unavailable"));
});

test("required discontinued consumable without alternatives blocks purchase", () => {
  const candidate = base("printer", { continuity: [{ name: "Ink 42", kind: "consumable", required: true, availability: "discontinued", compatible_alternatives_verified: false, evidence_status: "verified" }] });
  const result = run([candidate]).assessments[0];
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.failures, ["dependency:Ink 42:discontinued"]);
  assert.equal(result.continuity[0].status, "blocked");
});

test("unknown required part availability remains a targeted unknown", () => {
  const candidate = base("repairable", { continuity: [{ name: "Pump", kind: "replacement_part", required: true, availability: "unknown", compatible_alternatives_verified: null, evidence_status: "unknown" }] });
  const result = run([candidate]).assessments[0];
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.critical_unknowns, ["dependency:Pump:availability"]);
});

test("vendor-only input is exposed while verified alternatives are resilient", () => {
  const locked = base("locked", { continuity: [{ name: "Filter", kind: "consumable", required: true, availability: "vendor_only", compatible_alternatives_verified: false, evidence_status: "verified" }] });
  const open = base("open", { continuity: [{ name: "Filter", kind: "consumable", required: true, availability: "multiple_sources", compatible_alternatives_verified: true, evidence_status: "verified" }] });
  const result = run([locked, open]);
  assert.equal(result.assessments[0].status, "exposed");
  assert.equal(result.assessments[1].status, "resilient");
  assert.ok(result.assessments[1].resilience_signals.includes("dependency:Filter:alternatives"));
});

test("supply commitment ending before the horizon is explicit exposure", () => {
  const candidate = base("short-supply", { continuity: [{ name: "Pods", kind: "consumable", required: true, availability: "multiple_sources", compatible_alternatives_verified: true, evidence_status: "verified", supply_commitment_until: date("2027-01-31T12:00:00.000Z") }] });
  const result = run([candidate]).assessments[0];
  assert.ok(result.exposures.includes("dependency:Pods:commitment_ends_before_horizon"));
  assert.equal(result.continuity[0].supply_commitment.covers_horizon, false);
});

test("open-standard and data-export requirements preserve unknown and failure states", () => {
  const unknown = base("unknown", { ecosystem: { ...base("x").ecosystem, interoperability: { evidence_status: "unknown" } } });
  const closed = base("closed", { ecosystem: { ...base("x").ecosystem, data_export: { available: false, evidence_status: "verified" } } });
  const a = run([unknown], { requirements: { open_standard_required: true } }).assessments[0];
  const b = run([closed], { requirements: { data_export_required: true } }).assessments[0];
  assert.ok(a.critical_unknowns.includes("ecosystem:interoperability_standard"));
  assert.ok(b.failures.includes("data_export_unavailable"));
});

test("proprietary format without export requires migration-cost evidence", () => {
  const candidate = base("locked", { ecosystem: { ...base("x").ecosystem, proprietary_file_format: true, data_export: { available: false, evidence_status: "verified" } }, migration: { cost_usd: { evidence_status: "unknown" }, path_verified: false } });
  const result = run([candidate]).assessments[0];
  assert.equal(result.status, "unknown");
  assert.ok(result.exposures.includes("proprietary_format_without_verified_export"));
  assert.ok(result.critical_unknowns.includes("migration:cost"));
});

test("migration cost limit uses conservative high cost", () => {
  const estimated = { low_usd: 100, expected_usd: 300, high_usd: 500, evidence_status: "estimated" };
  const candidate = base("migration", { migration: { cost_usd: estimated, path_verified: true } });
  const result = run([candidate], { requirements: { max_migration_cost_usd: 400 } }).assessments[0];
  assert.deepEqual(result.failures, ["migration_cost_exceeds_limit"]);
});

test("minimum support months extends the comparison horizon", () => {
  const result = run([base("long")], { horizon_months: 12, requirements: { minimum_support_months: 48 } });
  assert.equal(result.horizon_months, 48);
  assert.equal(result.horizon_end, "2030-01-31T12:00:00.000Z");
});

test("decision partitions products without choosing among them", () => {
  const result = run([
    base("eligible"),
    base("tradeoff", { ecosystem: { ...base("x").ecosystem, proprietary_connector: true } }),
    base("research", { identity_verified: false }),
    base("avoid", { continuity: [{ name: "Cartridge", kind: "consumable", required: true, availability: "discontinued", compatible_alternatives_verified: false, evidence_status: "verified" }] }),
  ]);
  assert.deepEqual(result.decision.eligible_product_ids, ["eligible"]);
  assert.deepEqual(result.decision.tradeoff_product_ids, ["tradeoff"]);
  assert.deepEqual(result.decision.research_product_ids, ["research"]);
  assert.deepEqual(result.decision.avoid_product_ids, ["avoid"]);
  assert.equal(result.decision.selects_product, false);
});
