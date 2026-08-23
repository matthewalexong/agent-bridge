import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assessCounterfeitRisk } from "../lib/shopping-counterfeit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(here, "../eval/shopping/counterfeit/tasks.json"), "utf8"));
const expectedStatus = { low: "low", medium: "acceptable", high: "elevated", unknown: "unknown" };

function evidenceOffer(raw, userAcceptsGray = false) {
  const complaints = Array.from({ length: raw.authenticity_complaints || 0 }, (_, index) => ({ source_id: `review-${index}`, independence_key: `person-${index}`, source_type: "customer_review", relevance: "authenticity", verified: true, resolved: false }));
  const packaging_signals = [];
  if (raw.packaging_mismatch) packaging_signals.push({ type: "packaging_mismatch", present: true, evidence_status: "verified", source_type: "exact_item_photo" });
  if (raw.seal_issues) packaging_signals.push({ type: "seal_issue", present: true, evidence_status: "verified", source_type: "exact_item_photo" });
  return {
    id: raw.id,
    landed_total_usd: raw.landed_total_usd,
    landed_price_verified: true,
    exact_product: raw.exact_product,
    authorization: { status: raw.authorized_seller === true ? "authorized" : raw.authorized_seller === false ? "unauthorized" : "unknown", evidence_status: raw.authorized_seller == null ? "unknown" : "verified" },
    warranty: { applies: raw.manufacturer_warranty, evidence_status: raw.manufacturer_warranty == null ? "unknown" : "verified" },
    identifiers: { conflict: raw.identifier_conflict === true, evidence_status: "verified" },
    packaging_signals,
    complaints,
    sold_by_platform: raw.sold_by_platform,
    fulfilled_by_platform: raw.fulfilled_by_platform,
    gray_market_disclosed: raw.gray_market_disclosed,
    user_accepts_gray_market: userAcceptsGray,
    returnable: raw.returnable,
    condition: raw.condition,
  };
}

test("deterministic adjudicator reproduces every counterfeit corpus risk label", () => {
  for (const task of corpus) {
    const result = assessCounterfeitRisk({ category: task.category, authorized_market_median_usd: task.authorized_market_median_usd, authorized_market_median_verified: true, offers: task.offers.map((offer) => evidenceOffer(offer, task.id === "disclosed-gray-market")) });
    const actual = Object.fromEntries(result.assessments.map((item) => [item.offer_id, item.risk_status]));
    const expected = Object.fromEntries(Object.entries(task.expected.risks).map(([id, level]) => [id, expectedStatus[level]]));
    assert.deepEqual(actual, expected, task.id);
  }
});

test("price anomaly alone remains unknown", () => {
  const offer = evidenceOffer({ id: "price", landed_total_usd: 60, authorized_seller: null, manufacturer_warranty: null, exact_product: true });
  const result = assessCounterfeitRisk({ category: "luxury_accessory", authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.risk_status, "unknown");
  assert.ok(result.signals.some((item) => item.code === "extreme_price_anomaly"));
  assert.equal(result.accusation_allowed, false);
});

test("platform fulfillment never verifies seller or authenticity", () => {
  const offer = evidenceOffer({ id: "market", landed_total_usd: 95, authorized_seller: null, manufacturer_warranty: null, exact_product: true, sold_by_platform: false, fulfilled_by_platform: true });
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.risk_status, "unknown");
  assert.ok(result.critical_unknowns.includes("seller_authorization"));
  assert.ok(result.signals.some((item) => item.code === "third_party_seller_platform_fulfilled"));
});

test("authorized seller plus applicable warranty is low risk absent conflicts", () => {
  const offer = evidenceOffer({ id: "safe", landed_total_usd: 99, authorized_seller: true, manufacturer_warranty: true, exact_product: true });
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.risk_status, "low");
  assert.equal(result.reason, "verified_authorized_warranty_chain");
  assert.equal(result.purchase_gate, "eligible_for_other_shopping_checks");
});

test("open-box and refurbished condition are distinct from counterfeit risk", () => {
  for (const condition of ["open_box", "refurbished"]) {
    const offer = evidenceOffer({ id: condition, landed_total_usd: 90, authorized_seller: true, manufacturer_warranty: true, exact_product: true, condition });
    const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
    assert.equal(result.risk_status, "low");
    assert.equal(result.distinctions.condition, condition);
  }
});

test("disclosed accepted returnable gray market is acceptable, not counterfeit", () => {
  const offer = evidenceOffer({ id: "gray", landed_total_usd: 80, authorized_seller: false, manufacturer_warranty: false, exact_product: true, gray_market_disclosed: true, returnable: true }, true);
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.risk_status, "acceptable");
  assert.equal(result.definitive_counterfeit_finding, false);
  assert.match(result.reason, /user_accepted_disclosed/);
});

test("an authorized-seller-only requirement rejects verified gray market without relabeling it counterfeit", () => {
  const offer = evidenceOffer({ id: "gray-required", landed_total_usd: 80, authorized_seller: false, manufacturer_warranty: false, exact_product: true, gray_market_disclosed: true, returnable: true }, true);
  const result = assessCounterfeitRisk({
    requirements: { authorized_seller_required: true },
    authorized_market_median_usd: 100,
    authorized_market_median_verified: true,
    offers: [offer],
  });
  const assessment = result.assessments[0];
  assert.equal(assessment.risk_status, "acceptable");
  assert.equal(assessment.authorization_requirement.status, "failed");
  assert.equal(assessment.authorization_requirement.gate, "avoid_offer");
  assert.deepEqual(assessment.requirement_failures, ["authorized_seller_required"]);
  assert.equal(assessment.purchase_gate, "avoid_offer");
  assert.equal(assessment.definitive_counterfeit_finding, false);
  assert.equal(assessment.accusation_allowed, false);
  assert.deepEqual(result.decision.avoid_offer_ids, ["gray-required"]);
});

test("an unresolved authorized-seller-only requirement requests research rather than guessing", () => {
  const offer = evidenceOffer({ id: "unknown-required", landed_total_usd: 100, authorized_seller: null, manufacturer_warranty: true, exact_product: true });
  const assessment = assessCounterfeitRisk({ requirements: { authorized_seller_required: true }, offers: [offer] }).assessments[0];
  assert.equal(assessment.authorization_requirement.status, "unknown");
  assert.deepEqual(assessment.requirement_unknowns, ["authorized_seller_required"]);
  assert.equal(assessment.purchase_gate, "research_more");
  assert.equal(assessment.accusation_allowed, false);
});

test("verified authorization satisfies the separate seller requirement", () => {
  const offer = evidenceOffer({ id: "authorized-required", landed_total_usd: 100, authorized_seller: true, manufacturer_warranty: true, exact_product: true });
  const assessment = assessCounterfeitRisk({ requirements: { authorized_seller_required: true }, offers: [offer] }).assessments[0];
  assert.deepEqual(assessment.authorization_requirement, { required: true, status: "satisfied", gate: "eligible_for_other_shopping_checks" });
  assert.equal(assessment.risk_status, "low");
  assert.equal(assessment.purchase_gate, "eligible_for_other_shopping_checks");
});

test("unauthorized channel is not acceptable unless disclosed gray market was accepted", () => {
  const offer = evidenceOffer({ id: "unauthorized", landed_total_usd: 95, authorized_seller: false, manufacturer_warranty: false, exact_product: true });
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.risk_status, "unknown");
  assert.equal(result.purchase_gate, "research_more");
  assert.equal(result.reason, "unauthorized_channel_requires_additional_authenticity_evidence");
});

test("verified identifier conflict is direct elevated risk for an exact product", () => {
  const offer = evidenceOffer({ id: "identifier", landed_total_usd: 95, authorized_seller: true, manufacturer_warranty: true, identifier_conflict: true, exact_product: true });
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.risk_status, "elevated");
  assert.ok(result.signals.some((item) => item.code === "verified_identifier_conflict"));
  assert.equal(result.accusation_allowed, false);
});

test("complaints require three independent verified unresolved authenticity reports", () => {
  const base = evidenceOffer({ id: "complaints", landed_total_usd: 100, authorized_seller: null, manufacturer_warranty: null, exact_product: true });
  const repeated = { source_id: "review", independence_key: "same-person", source_type: "customer_review", relevance: "authenticity", verified: true, resolved: false };
  base.complaints = [repeated, { ...repeated, source_id: "copy" }, { ...repeated, source_id: "copy-2" }];
  let result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [base] }).assessments[0];
  assert.equal(result.complaint_evidence.independent, 1);
  assert.equal(result.risk_status, "unknown");
  base.complaints = [1, 2, 3].map((number) => ({ ...repeated, source_id: `source-${number}`, independence_key: `person-${number}` }));
  result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [base] }).assessments[0];
  assert.equal(result.risk_status, "elevated");
});

test("search snippets, irrelevant reports, and resolved complaints are excluded", () => {
  const offer = evidenceOffer({ id: "noise", landed_total_usd: 100, authorized_seller: null, manufacturer_warranty: null, exact_product: true });
  offer.complaints = [
    { source_id: "s", source_type: "search_snippet", relevance: "authenticity", verified: true, resolved: false },
    { source_id: "delivery", source_type: "customer_review", relevance: "delivery", verified: true, resolved: false },
    { source_id: "resolved", source_type: "customer_review", relevance: "authenticity", verified: true, resolved: true },
  ];
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.complaint_evidence.unresolved, 0);
  assert.equal(result.risk_status, "unknown");
});

test("unverified official accusation is excluded and cannot authorize accusation language", () => {
  const offer = evidenceOffer({ id: "claim", landed_total_usd: 100, authorized_seller: null, manufacturer_warranty: null, exact_product: true });
  offer.official_finding = { counterfeit: true, authority_type: "customer_review", evidence_status: "explicit" };
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.accusation_allowed, false);
  assert.ok(result.excluded_signals.some((item) => item.code === "unverified_counterfeit_claim"));
  assert.match(result.language_guardrail, /do not state/i);
});

test("verified official finding is the only path to an affirmative counterfeit conclusion", () => {
  const offer = evidenceOffer({ id: "official", landed_total_usd: 100, authorized_seller: true, manufacturer_warranty: true, exact_product: true });
  offer.official_finding = { counterfeit: true, authority_type: "manufacturer", evidence_status: "verified" };
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] }).assessments[0];
  assert.equal(result.risk_status, "elevated");
  assert.equal(result.definitive_counterfeit_finding, true);
  assert.equal(result.accusation_allowed, true);
});

test("wrong product identity routes to exact-product search without calling it counterfeit", () => {
  const offer = evidenceOffer({ id: "wrong", landed_total_usd: 100, authorized_seller: true, manufacturer_warranty: true, exact_product: false });
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [offer] });
  assert.equal(result.assessments[0].risk_status, "low");
  assert.equal(result.decision.action, "search_exact_product");
  assert.deepEqual(result.decision.identity_mismatch_offer_ids, ["wrong"]);
});

test("decision partitions safe, research, and avoid offers without selecting", () => {
  const safe = evidenceOffer({ id: "safe", landed_total_usd: 100, authorized_seller: true, manufacturer_warranty: true, exact_product: true });
  const unknown = evidenceOffer({ id: "unknown", landed_total_usd: 100, authorized_seller: null, manufacturer_warranty: null, exact_product: true });
  const elevated = evidenceOffer({ id: "elevated", landed_total_usd: 100, authorized_seller: false, manufacturer_warranty: false, identifier_conflict: true, exact_product: true });
  const result = assessCounterfeitRisk({ authorized_market_median_usd: 100, authorized_market_median_verified: true, offers: [safe, unknown, elevated] });
  assert.deepEqual(result.decision.eligible_offer_ids, ["safe"]);
  assert.deepEqual(result.decision.research_offer_ids, ["unknown"]);
  assert.deepEqual(result.decision.avoid_offer_ids, ["elevated"]);
  assert.equal(result.decision.selects_offer, false);
});
