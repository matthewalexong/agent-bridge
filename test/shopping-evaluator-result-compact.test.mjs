import test from "node:test";
import assert from "node:assert/strict";
import { compactShoppingEvaluatorResult } from "../lib/shopping-evaluator-result-compact.mjs";

test("result compaction keeps the complete exact-offer assessment and top-level diagnostics", () => {
  const result = {
    evaluated_at: "2026-08-24T20:00:00.000Z",
    warnings: ["directory coverage incomplete"],
    assessments: [
      { offer_id: "offer-a", product_id: "camera-x", risk_status: "low", signals: [{ code: "seller_verified" }] },
      { offer_id: "offer-b", product_id: "camera-x", risk_status: "unknown", signals: [{ code: "authorization_unknown" }] },
    ],
  };
  const compacted = compactShoppingEvaluatorResult({ stage: "counterfeit", subject: { product_id: "camera-x", offer_id: "offer-a" }, result });
  assert.deepEqual(compacted.warnings, result.warnings);
  assert.deepEqual(compacted.assessments, [result.assessments[0]]);
  assert.equal(result.assessments.length, 2, "compaction must not mutate the process result");
});

test("result compaction keeps the exact product assessment when no offer subject exists", () => {
  const result = { assessments: [
    { id: "camera-x", action: "eligible", details: ["exact"] },
    { id: "camera-y", action: "research_more", details: ["other"] },
  ] };
  const compacted = compactShoppingEvaluatorResult({ stage: "compatibility", subject: { product_id: "camera-x" }, result });
  assert.deepEqual(compacted.assessments, [result.assessments[0]]);
});

test("result compaction fails open to the full result when exact projection is ambiguous", () => {
  const result = { assessments: [{ id: "offer-a", product_id: "camera-x" }, { id: "offer-a", product_id: "camera-x" }] };
  const compacted = compactShoppingEvaluatorResult({ stage: "merchant", subject: { product_id: "camera-x", offer_id: "offer-a" }, result });
  assert.equal(compacted.assessments.length, 2);
});

test("cross-candidate comparison stages remain complete", () => {
  const result = { normalized_offers: [{ id: "offer-a" }, { id: "offer-b" }], verified_decision: { selected_offer: "offer-a" } };
  const compacted = compactShoppingEvaluatorResult({ stage: "offer", subject: { product_id: "camera-x", offer_id: "offer-a" }, result });
  assert.deepEqual(compacted, result);
});

