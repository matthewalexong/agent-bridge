import assert from "node:assert/strict";
import test from "node:test";
import { assessShoppingPerformance } from "../lib/shopping-performance.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const metric = { id: "battery_runtime", unit: "min", direction: "higher_better", protocol: { id: "video-loop", version: "2" }, conditions: { brightness_nits: 200, wifi: true, codec: "h264" }, firmware_sensitive: true };
const target = (id) => ({ id, variant_id: "us", configuration_id: "16gb", firmware_version: "1.2" });
const measurement = (id, product_id, lab, value, overrides = {}) => ({ id, product_id, variant_id: "us", configuration_id: "16gb", firmware_version: "1.2", metric_id: "battery_runtime", value, unit: "min", protocol: { id: "video-loop", version: "2", evidence_status: "verified", source_id: "protocol-v2" }, conditions: { brightness_nits: 200, wifi: true, codec: "h264" }, condition_inventory_complete: true, sample_size: 3, run_coverage_complete: true, uncertainty: { low: value - 5, high: value + 5, evidence_status: "verified", source_id: `uncertainty-${id}` }, instrument_calibration: { status: "current", evidence_status: "verified", source_id: `calibration-${id}` }, evidence_status: "verified", measured_at: NOW, source: { id: `source-${id}`, source_type: "independent_lab", independence_key: lab, funding_relationship: "none", funding_evidence_status: "verified", editorial_independence_verified: true, editorial_independence_evidence_status: "verified" }, ...overrides });
const input = (overrides = {}) => ({ evaluated_at: NOW, metric, policy: { min_independent_labs: 2, max_interlab_relative_spread: 0.2 }, targets: [target("a"), target("b")], measurements: [measurement("a1", "a", "lab1", 600), measurement("a2", "a", "lab2", 620), measurement("b1", "b", "lab1", 500), measurement("b2", "b", "lab2", 510)], ...overrides });

test("same-protocol exact-scope independent measurements produce comparable bounded metrics", () => {
  const got = assessShoppingPerformance(input());
  assert.equal(got.action, "comparable");
  assert.equal(got.comparison_cleared_for_ranking, true);
  assert.equal(got.assessments[0].metric.attribute, "performance:battery_runtime");
  assert.equal(got.assessments[0].metric.value, 610);
  assert.equal(got.assessments[0].metric.lower, 595);
  assert.equal(got.selected_product, null);
  assert.equal(got.purchase_allowed, false);
});

test("variant, configuration, and firmware scope cannot be spliced", () => {
  for (const change of [{ variant_id: "eu" }, { configuration_id: "8gb" }, { firmware_version: "old" }]) {
    const data = input();
    Object.assign(data.measurements[0], change);
    const got = assessShoppingPerformance(data);
    assert.equal(got.action, "research_more");
    assert.ok(got.assessments[0].excluded_measurements[0].reasons.includes("scope_mismatch"));
  }
});

test("protocol id, version, and source must match exactly", () => {
  for (const change of [{ id: "other" }, { version: "1" }, { evidence_status: "unknown" }, { source_id: "" }]) {
    const data = input();
    data.measurements[0].protocol = { ...data.measurements[0].protocol, ...change };
    assert.equal(assessShoppingPerformance(data).action, "research_more");
  }
});

test("material test conditions require a complete exact inventory", () => {
  const changed = input();
  changed.measurements[0].conditions.brightness_nits = 100;
  assert.equal(assessShoppingPerformance(changed).action, "research_more");
  const incomplete = input();
  incomplete.measurements[0].condition_inventory_complete = false;
  assert.equal(assessShoppingPerformance(incomplete).action, "research_more");
});

test("manufacturer, funded, and editorially unverified tests remain controlled claims", () => {
  for (const source of [{ source_type: "manufacturer" }, { funding_relationship: "manufacturer" }, { funding_evidence_status: "unknown" }, { editorial_independence_verified: false }, { editorial_independence_evidence_status: "unknown" }]) {
    const data = input();
    data.measurements[0].source = { ...data.measurements[0].source, ...source };
    const got = assessShoppingPerformance(data);
    assert.equal(got.action, "research_more");
    assert.ok(got.assessments[0].controlled_or_funded_claim_ids.includes("a1"));
  }
});

test("duplicate pages from one lab count once", () => {
  const data = input();
  data.measurements[1].source.independence_key = "lab1";
  const got = assessShoppingPerformance(data);
  assert.equal(got.action, "research_more");
  assert.equal(got.assessments[0].eligible_measurement_ids.length, 0);
  assert.ok(got.assessments[0].excluded_measurements.some((item) => item.reasons.includes("duplicate_independent_source")));
});

test("sample size, complete run coverage, freshness, and verified source are mandatory", () => {
  for (const change of [{ sample_size: 0 }, { run_coverage_complete: false }, { measured_at: "2020-01-01T00:00:00.000Z" }, { evidence_status: "unknown" }]) {
    const data = input();
    Object.assign(data.measurements[0], change);
    assert.equal(assessShoppingPerformance(data).action, "research_more");
  }
});

test("uncertainty must be verified, contain the point, and remain within policy", () => {
  for (const uncertainty of [{ low: 590, high: 610, evidence_status: "unknown", source_id: "u" }, { low: 610, high: 620, evidence_status: "verified", source_id: "u" }, { low: 100, high: 1000, evidence_status: "verified", source_id: "u" }, { low: 590, high: 610, evidence_status: "verified", source_id: "" }]) {
    const data = input();
    data.measurements[0].uncertainty = uncertainty;
    assert.equal(assessShoppingPerformance(data).action, "research_more");
  }
});

test("large inter-lab disagreement is a conflict rather than an average", () => {
  const data = input();
  data.measurements[1].value = 900;
  data.measurements[1].uncertainty = { low: 895, high: 905, evidence_status: "verified", source_id: "u" };
  const got = assessShoppingPerformance(data);
  assert.equal(got.action, "conflict");
  assert.equal(got.assessments[0].metric, null);
});

test("unit mismatch never undergoes an unstated benchmark conversion", () => {
  const data = input();
  data.measurements[0].unit = "hours";
  assert.equal(assessShoppingPerformance(data).action, "research_more");
});

test("an empty target set cannot claim a cleared comparison", () => {
  const got = assessShoppingPerformance(input({ targets: [], measurements: [] }));
  assert.equal(got.comparison_cleared_for_ranking, false);
  assert.equal(got.selected_product, null);
  assert.equal(got.purchase_allowed, false);
});

test("exact target variant, configuration, and sensitive firmware are mandatory", () => {
  for (const field of ["variant_id", "configuration_id", "firmware_version"]) {
    const data = input();
    data.targets[0][field] = "";
    const got = assessShoppingPerformance(data);
    assert.equal(got.action, "research_more");
    assert.ok(got.assessments[0].research.includes("a:exact_test_scope_missing"));
  }
});

test("instrument-dependent metrics can require current verified calibration", () => {
  const data = input({ metric: { ...metric, calibration_required: true } });
  data.measurements[0].instrument_calibration = { status: "expired", evidence_status: "verified", source_id: "old" };
  const got = assessShoppingPerformance(data);
  assert.equal(got.action, "research_more");
  assert.ok(got.assessments[0].excluded_measurements[0].reasons.includes("instrument_calibration_unverified"));
});
