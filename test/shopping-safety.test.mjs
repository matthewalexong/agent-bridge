import assert from "node:assert/strict";
import test from "node:test";
import { assessShoppingSafety } from "../lib/shopping-safety.mjs";

const NOW = "2026-08-22T20:00:00.000Z";
const candidate = (overrides = {}) => ({ id: "A", identity_verified: true, product_key: "acme-kettle-k1", condition: "new", seller: "Kettle Shop", model: "K1", identifiers: { upc: "012345678905" }, certifications: [{ scheme: "UL", jurisdiction: "US", status: "valid", evidence_status: "verified", applies_to_exact_model: true, source_id: "ul-directory", expires_at: "2027-01-01T00:00:00.000Z" }], remediations: [], ...overrides });
const coverage = (overrides = {}) => ({ authority_id: "CPSC", jurisdiction: "US", product_category: "electric_kettles", status: "complete", searched_at: "2026-08-22T19:00:00.000Z", source_id: "cpsc-search", product_key: "acme-kettle-k1", ...overrides });
const notice = (overrides = {}) => ({ id: "R1", notice_type: "recall", authority_type: "regulator", evidence_status: "verified", source_id: "cpsc-r1", status: "active", severity: "serious", affected: { product_keys: ["acme-kettle-k1"], models: ["K1"], identifiers: { upc: "012345678905" }, scope_complete: true }, ...overrides });
const input = (overrides = {}) => ({ evaluated_at: NOW, jurisdiction: "US", product_category: "electric_kettles", required_authorities: ["CPSC"], coverage: [coverage()], certification_requirements: [{ scheme: "UL", jurisdiction: "US" }], notices: [], candidates: [candidate()], ...overrides });
const assess = (overrides = {}) => assessShoppingSafety(input(overrides)).assessments[0];

test("complete authoritative coverage and exact valid certification clear ranking only", () => {
  const result = assess();
  assert.equal(result.action, "eligible");
  assert.equal(result.safety_cleared_for_ranking, true);
  assert.equal(result.purchase_allowed, false);
});

test("no notice results without complete authority coverage never means cleared", () => {
  const result = assess({ coverage: [] });
  assert.equal(result.action, "research_more");
  assert.deepEqual(result.research, ["coverage:cpsc:missing"]);
});

test("an exact active unresolved recall blocks the product", () => {
  const result = assess({ notices: [notice()] });
  assert.equal(result.action, "avoid_product");
  assert.ok(result.blockers.includes("notice:R1:active_unremediated_recall"));
  assert.equal(result.notice_results[0].match, "affected");
});

test("a similar model notice does not contaminate the exact product", () => {
  const result = assess({ notices: [notice({ affected: { product_keys: ["acme-kettle-k2"], models: ["K2"], scope_complete: true } })] });
  assert.equal(result.action, "eligible");
  assert.equal(result.notice_results[0].match, "not_affected");
});

test("serial-bounded recalls abstain without serial and distinguish outside/inside range", () => {
  const serialNotice = notice({ affected: { product_keys: ["acme-kettle-k1"], serial_ranges: [{ prefix: "K1-", start: "000100", end: "000199" }], scope_complete: true } });
  let result = assess({ notices: [serialNotice] });
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("notice:R1:serial_number_required"));
  result = assess({ notices: [serialNotice], candidates: [candidate({ serial_number: "K1-000250" })] });
  assert.equal(result.action, "eligible");
  result = assess({ notices: [serialNotice], candidates: [candidate({ serial_number: "K1-000150" })] });
  assert.equal(result.action, "avoid_product");
});

test("manufacture-date scope remains unknown until the exact unit date is known", () => {
  const dated = notice({ affected: { models: ["K1"], manufactured_from: "2025-01-01T00:00:00.000Z", manufactured_to: "2025-06-30T23:59:59.000Z", scope_complete: true } });
  assert.equal(assess({ notices: [dated] }).action, "research_more");
  assert.equal(assess({ notices: [dated], candidates: [candidate({ manufactured_at: "2025-03-01T00:00:00.000Z" })] }).action, "avoid_product");
  assert.equal(assess({ notices: [dated], candidates: [candidate({ manufactured_at: "2025-09-01T00:00:00.000Z" })] }).action, "eligible");
});

test("unverified and nonofficial recall claims are excluded rather than promoted", () => {
  for (const bad of [notice({ evidence_status: "unknown" }), notice({ authority_type: "customer_review" })]) {
    const result = assess({ notices: [bad] });
    assert.equal(result.action, "eligible");
    assert.equal(result.notice_results[0].match, "excluded");
  }
});

test("verified exact-unit remediation can clear a recall but remains disclosed", () => {
  const remediated = candidate({ remediations: [{ notice_id: "R1", status: "completed", evidence_status: "verified", source_id: "manufacturer-service-record", restores_compliance: true }] });
  const result = assess({ notices: [notice()], candidates: [remediated] });
  assert.equal(result.action, "eligible");
  assert.deepEqual(result.warnings, ["notice:R1:verified_remediation_completed"]);
});

test("an active sales ban cannot be repaired away by a service record", () => {
  const remediated = candidate({ remediations: [{ notice_id: "R1", status: "completed", evidence_status: "verified", source_id: "service-record", restores_compliance: true }] });
  const result = assess({ notices: [notice({ notice_type: "sales_ban" })], candidates: [remediated] });
  assert.equal(result.action, "avoid_product");
  assert.ok(result.blockers.includes("notice:R1:sales_ban"));
});

test("a moderate official safety warning requires an explicit tradeoff", () => {
  const result = assess({ notices: [notice({ notice_type: "safety_warning", severity: "moderate" })] });
  assert.equal(result.action, "clarify_tradeoff");
  assert.deepEqual(result.clarifications, ["notice:R1:moderate_safety_tradeoff"]);
});

test("missing, expired, and revoked certifications cannot satisfy a jurisdictional requirement", () => {
  let result = assess({ candidates: [candidate({ certifications: [] })] });
  assert.equal(result.action, "research_more");
  result = assess({ candidates: [candidate({ certifications: [{ scheme: "UL", jurisdiction: "US", status: "valid", evidence_status: "verified", applies_to_exact_model: true, source_id: "ul", expires_at: "2026-01-01T00:00:00.000Z" }] })] });
  assert.equal(result.action, "avoid_product");
  result = assess({ candidates: [candidate({ certifications: [{ scheme: "UL", jurisdiction: "US", status: "revoked", evidence_status: "verified", applies_to_exact_model: true, source_id: "ul" }] })] });
  assert.equal(result.action, "avoid_product");
});

test("stale, partial, wrong-category, and wrong-product coverage do not clear safety", () => {
  for (const check of [coverage({ searched_at: "2026-07-01T00:00:00.000Z" }), coverage({ status: "partial" }), coverage({ product_category: "toasters" }), coverage({ product_key: "other" })]) {
    assert.equal(assess({ coverage: [check] }).action, "research_more");
  }
});

test("unverified product identity prevents notice clearance", () => {
  const result = assess({ candidates: [candidate({ identity_verified: false })] });
  assert.equal(result.action, "research_more");
  assert.ok(result.research.includes("identity_not_verified_for_safety_scope"));
});
