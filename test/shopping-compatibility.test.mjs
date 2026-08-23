import assert from "node:assert/strict";
import test from "node:test";
import { assessShoppingCompatibility } from "../lib/shopping-compatibility.mjs";

const assess = (requirements, claims, category = "other") => assessShoppingCompatibility({ category, requirements, candidates: [{ id: "A", claims }] }).assessments[0];
const claim = (requirement_id, kind, fields = {}) => ({ requirement_id, kind, evidence_status: "verified", source_id: `${requirement_id}-source`, ...fields });

test("exact connector and regional requirements normalize punctuation but not meaning", () => {
  const result = assess([{ id: "connector", kind: "exact", value: "USB-C" }, { id: "region", kind: "exact", value: "US" }], [claim("connector", "exact", { value: "USB C" }), claim("region", "exact", { value: "EU" })]);
  assert.equal(result.action, "incompatible");
  assert.deepEqual(result.blockers, ["region:exact_value_mismatch"]);
});

test("all required protocols or bands must be explicitly supported", () => {
  const result = assess([{ id: "bands", kind: "all_supported", values: ["n77", "n78"] }], [claim("bands", "all_supported", { values: ["n77"] })]);
  assert.equal(result.action, "incompatible");
  assert.deepEqual(result.checks[0].details.missing, ["n78"]);
});

test("voltage range and frequency are independent hard checks", () => {
  const requirements = [{ id: "voltage", kind: "numeric_contained", low: 110, high: 120, unit: "V" }, { id: "frequency", kind: "numeric_contained", value: 60, unit: "Hz" }];
  const claims = [claim("voltage", "numeric_contained", { low: 220, high: 240, unit: "V" }), claim("frequency", "numeric_contained", { low: 50, high: 60, unit: "Hz" })];
  const result = assess(requirements, claims, "electrical");
  assert.equal(result.action, "incompatible");
  assert.ok(result.blockers.includes("voltage:required_range_not_supported"));
});

test("length units convert for installation geometry and include clearance on both sides", () => {
  const requirements = [{ id: "space", kind: "dimensions_fit", unit: "in", available: { width: 30, height: 40, depth: 25 } }];
  const fits = claim("space", "dimensions_fit", { unit: "cm", product: { width: 70, height: 95, depth: 55 }, clearance_each_side: { width: 2, height: 1, depth: 2 } });
  assert.equal(assess(requirements, [fits], "installation").action, "compatible");
  const tooLarge = { ...fits, product: { ...fits.product, width: 80 } };
  assert.equal(assess(requirements, [tooLarge], "installation").action, "incompatible");
});

test("width-depth rotation is used only when explicitly allowed", () => {
  const base = { id: "space", kind: "dimensions_fit", unit: "cm", available: { width: 60, height: 50, depth: 80 } };
  const product = claim("space", "dimensions_fit", { unit: "cm", product: { width: 75, height: 40, depth: 55 } });
  assert.equal(assess([base], [product]).action, "incompatible");
  assert.equal(assess([{ ...base, allow_width_depth_rotation: true }], [product]).action, "compatible");
});

test("vehicle fitment requires every user-declared field", () => {
  const requirement = { id: "vehicle", kind: "fitment_exact", fitment: { year: 2020, make: "Honda", model: "Civic", trim: "Sport", engine: "1.5T" }, required_fields: ["year", "make", "model", "trim", "engine"] };
  const incomplete = claim("vehicle", "fitment_exact", { coverage_complete: true, records: [{ year: 2020, make: "Honda", model: "Civic", trim: "Sport" }] });
  assert.equal(assess([requirement], [incomplete], "vehicle").action, "research_more");
  const exact = { ...incomplete, records: [{ ...incomplete.records[0], engine: "1.5T" }] };
  assert.equal(assess([requirement], [exact], "vehicle").action, "compatible");
});

test("a no-fit result is definitive only when fitment coverage is complete", () => {
  const requirement = { id: "vehicle", kind: "fitment_exact", fitment: { year: 2020, make: "Honda", model: "Civic" }, required_fields: ["year", "make", "model"] };
  const record = { year: 2021, make: "Honda", model: "Civic" };
  assert.equal(assess([requirement], [claim("vehicle", "fitment_exact", { coverage_complete: false, records: [record] })]).action, "research_more");
  assert.equal(assess([requirement], [claim("vehicle", "fitment_exact", { coverage_complete: true, records: [record] })]).action, "incompatible");
});

test("apparel sizes require measurements in a verified chart, not label equivalence", () => {
  const requirement = { id: "body", kind: "apparel_chart", measurements: [{ name: "chest", value: 40, unit: "in" }, { name: "waist", value: 34, unit: "in" }] };
  const medium = claim("body", "apparel_chart", { size_label: "M", size_system: "US men's", measurements: [{ name: "chest", low: 38, high: 41, unit: "in" }, { name: "waist", low: 32, high: 35, unit: "in" }] });
  assert.equal(assess([requirement], [medium], "apparel").action, "compatible");
  const labelOnly = claim("body", "apparel_chart", { size_label: "M", size_system: "US men's" });
  assert.equal(assess([requirement], [labelOnly], "apparel").action, "research_more");
});

test("one out-of-chart body measurement rejects that exact size", () => {
  const requirement = { id: "body", kind: "apparel_chart", measurements: [{ name: "chest", value: 43, unit: "in" }] };
  const medium = claim("body", "apparel_chart", { size_label: "M", measurements: [{ name: "chest", low: 38, high: 41, unit: "in" }] });
  const result = assess([requirement], [medium], "apparel");
  assert.equal(result.action, "incompatible");
  assert.match(result.blockers[0], /measurement_outside_size_chart/);
});

test("unknown, conflicting, and estimated claims never satisfy hard compatibility", () => {
  for (const evidence_status of ["unknown", "conflict", "estimated"]) {
    const result = assess([{ id: "socket", kind: "exact", value: "AM5" }], [claim("socket", "exact", { value: "AM5", evidence_status })]);
    assert.equal(result.action, "research_more");
    assert.equal(result.safe_for_ranking, false);
  }
});

test("a verified label without source identity remains unusable", () => {
  const result = assess([{ id: "socket", kind: "exact", value: "AM5" }], [{ requirement_id: "socket", kind: "exact", value: "AM5", evidence_status: "verified" }]);
  assert.equal(result.action, "research_more");
  assert.deepEqual(result.research, ["socket:compatibility_source_missing"]);
});

test("optional mismatches are disclosed without excluding an otherwise compatible candidate", () => {
  const requirements = [{ id: "required", kind: "exact", value: "USB-C" }, { id: "preferred", kind: "exact", value: "Thunderbolt 5", required: false }];
  const claims = [claim("required", "exact", { value: "USB C" }), claim("preferred", "exact", { value: "Thunderbolt 4" })];
  const result = assess(requirements, claims);
  assert.equal(result.action, "compatible");
  assert.deepEqual(result.optional_mismatches, ["preferred:exact_value_mismatch"]);
});

test("the evaluator partitions candidates but never chooses or authorizes purchase", () => {
  const input = { category: "parts", requirements: [{ id: "socket", kind: "exact", value: "AM5" }], candidates: [
    { id: "yes", claims: [claim("socket", "exact", { value: "AM5" })] },
    { id: "unknown", claims: [] },
    { id: "no", claims: [claim("socket", "exact", { value: "LGA1700" })] },
  ] };
  const result = assessShoppingCompatibility(input);
  assert.deepEqual(result.decision.compatible_candidates, ["yes"]);
  assert.deepEqual(result.decision.research_candidates, ["unknown"]);
  assert.deepEqual(result.decision.incompatible_candidates, ["no"]);
  assert.equal(result.decision.selected_candidate, null);
  assert.equal(result.decision.purchase_allowed, false);
});
