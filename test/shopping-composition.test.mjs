import assert from "node:assert/strict";
import test from "node:test";
import { assessShoppingComposition } from "../lib/shopping-composition.mjs";

const label = (overrides = {}) => ({ formulation_id: "US-2026-A", region: "US", version: "2026.1", ingredient_inventory_complete: true, material_inventory_complete: true, hazard_inventory_complete: true, evidence_status: "verified", source_id: "exact-package-label", ...overrides });
const component = (name, overrides = {}) => ({ name, evidence_status: "verified", source_id: "exact-package-label", ...overrides });
const candidate = (overrides = {}) => ({ id: "A", identity_verified: true, offer_formulation: { formulation_id: "US-2026-A", region: "US", version: "2026.1" }, label: label(), ingredients: [component("water"), component("glycerin")], materials: [], allergen_statements: [], claims: [], hazards: [], ...overrides });
const assess = (requirements = {}, item = candidate()) => assessShoppingComposition({ requirements, candidates: [item] }).assessments[0];

test("an exact complete formulation without conflicts clears ranking only", () => {
  const result = assess();
  assert.equal(result.action, "eligible");
  assert.equal(result.composition_cleared_for_ranking, true);
  assert.equal(result.medical_diagnosis_provided, false);
  assert.equal(result.purchase_allowed, false);
});

test("excluded ingredients match only explicit names or aliases", () => {
  let result = assess({ excluded_ingredients: [{ name: "tocopherol", aliases: ["vitamin e"] }] }, candidate({ ingredients: [component("vitamin E")] }));
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.includes("A:excluded_ingredient:tocopherol"));
  result = assess({ excluded_ingredients: [{ name: "nut", aliases: [] }] }, candidate({ ingredients: [component("coconut oil")] }));
  assert.equal(result.action, "eligible");
});

test("declared subcomponents can establish an explicit exclusion", () => {
  const result = assess({ excluded_ingredients: [{ name: "milk", aliases: ["casein"] }] }, candidate({ ingredients: [component("flavor blend", { declared_components: ["casein"] })] }));
  assert.equal(result.action, "reject");
  assert.equal(result.matched_exclusions[0].declared_as, "flavor blend");
});

test("unverified matching ingredient evidence remains research rather than a finding", () => {
  const result = assess({ excluded_ingredients: [{ name: "retinol" }] }, candidate({ ingredients: [component("retinol", { evidence_status: "unknown" })] }));
  assert.equal(result.action, "research_more");
});

test("materials are evaluated separately from ingredients", () => {
  const result = assess({ excluded_materials: [{ name: "latex", aliases: ["natural rubber latex"] }] }, candidate({ materials: [component("natural rubber latex")] }));
  assert.equal(result.action, "reject");
  assert.ok(result.blockers.includes("A:excluded_material:latex"));
});

test("concentration limits require verified comparable units", () => {
  const req = { max_concentrations: [{ name: "salicylic acid", max: 2, unit: "%" }] };
  let result = assess(req, candidate({ ingredients: [component("salicylic acid", { concentration: { value: 3, unit: "%", evidence_status: "verified", source_id: "label" } })] }));
  assert.equal(result.action, "reject");
  result = assess(req, candidate({ ingredients: [component("salicylic acid", { concentration: { value: 20, unit: "mg/g", evidence_status: "verified", source_id: "label" } })] }));
  assert.equal(result.action, "research_more");
});

test("contains allergen is a hard conflict independent of cross-contact policy", () => {
  const req = { allergens: [{ name: "peanut", cross_contact_policy: "allow_disclosed" }] };
  const result = assess(req, candidate({ allergen_statements: [{ allergen: "peanut", status: "contains", evidence_status: "verified", source_id: "label" }] }));
  assert.equal(result.action, "reject");
});

test("cross-contact wording follows explicit avoid, clarify, or disclosed policy", () => {
  const item = candidate({ allergen_statements: [{ allergen: "peanut", status: "may_contain", evidence_status: "verified", source_id: "label" }] });
  assert.equal(assess({ allergens: [{ name: "peanut", cross_contact_policy: "avoid" }] }, item).action, "reject");
  assert.equal(assess({ allergens: [{ name: "peanut", cross_contact_policy: "clarify" }] }, item).action, "clarify");
  const allowed = assess({ allergens: [{ name: "peanut", cross_contact_policy: "allow_disclosed" }] }, item);
  assert.equal(allowed.action, "eligible");
  assert.deepEqual(allowed.warnings, ["A:allergen_cross_contact_disclosed:peanut"]);
});

test("missing allergen statement never becomes free-from by ingredient omission", () => {
  const result = assess({ allergens: [{ name: "peanut", cross_contact_policy: "avoid" }] });
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("A:allergen_statement_unresolved:peanut"));
});

test("required claims distinguish certified, verified, marketing, and absent", () => {
  const req = { required_claims: [{ name: "vegan", minimum_evidence: "certified" }] };
  assert.equal(assess(req, candidate({ claims: [{ name: "vegan", status: "certified", evidence_status: "verified", source_id: "certifier" }] })).action, "eligible");
  assert.equal(assess(req, candidate({ claims: [{ name: "vegan", status: "marketing", evidence_status: "verified", source_id: "brand-page" }] })).action, "research_more");
  assert.equal(assess(req, candidate({ claims: [{ name: "vegan", status: "absent", evidence_status: "verified", source_id: "certifier" }] })).action, "reject");
});

test("prohibited hazard classes require a complete sourced hazard inventory", () => {
  const req = { prohibited_hazards: ["flammable aerosol"] };
  assert.equal(assess(req, candidate({ hazards: [{ classification: "flammable aerosol", present: true, evidence_status: "verified", source_id: "sds" }] })).action, "reject");
  assert.equal(assess(req, candidate({ label: label({ hazard_inventory_complete: false }) })).action, "research_more");
});

test("region, formulation, or version mismatch cannot be spliced into the offer", () => {
  for (const field of ["region", "formulation_id", "version"]) {
    const item = candidate({ label: label({ [field]: "different" }) });
    const result = assess({}, item);
    assert.equal(result.action, "research_more");
    assert.ok(result.research.includes(`A:formulation_${field}_mismatch`));
  }
});

test("incomplete and unsourced labels cannot clear composition", () => {
  assert.equal(assess({}, candidate({ label: label({ ingredient_inventory_complete: false }) })).action, "research_more");
  assert.equal(assess({}, candidate({ label: label({ source_id: undefined }) })).action, "research_more");
});

test("composition assessment partitions candidates without diagnosing, selecting, or buying", () => {
  const req = { excluded_ingredients: [{ name: "retinol" }] };
  const result = assessShoppingComposition({ requirements: req, candidates: [candidate({ id: "yes" }), candidate({ id: "unknown", label: label({ ingredient_inventory_complete: false }) }), candidate({ id: "no", ingredients: [component("retinol")] })] });
  assert.deepEqual(result.decision.eligible_candidates, ["yes"]);
  assert.deepEqual(result.decision.research_candidates, ["unknown"]);
  assert.deepEqual(result.decision.rejected_candidates, ["no"]);
  assert.equal(result.decision.selected_candidate, null);
  assert.equal(result.decision.purchase_allowed, false);
});
