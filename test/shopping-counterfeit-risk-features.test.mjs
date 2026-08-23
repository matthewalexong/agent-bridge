import test from "node:test";
import assert from "node:assert/strict";
import { deriveRiskFeatures } from "../eval/shopping/counterfeit/lib/risk-features.mjs";

test("risk features calculate price anomaly and preserve independent evidence", () => {
  const [risk] = deriveRiskFeatures({
    authorized_market_median_usd: 100,
    offers: [{
      id: "A", landed_total_usd: 40, authorized_seller: false,
      manufacturer_warranty: false, identifier_conflict: true,
      authenticity_complaints: 5, packaging_mismatch: true,
    }],
  });
  assert.equal(risk.price_discount_pct_vs_authorized_median, 60);
  assert.deepEqual(risk.evidence_flags, [
    "unauthorized_seller", "extreme_price_anomaly", "no_manufacturer_warranty",
    "identifier_conflict", "repeated_authenticity_complaints", "packaging_mismatch",
  ]);
});

test("platform fulfillment does not become platform seller evidence", () => {
  const [risk] = deriveRiskFeatures({
    offers: [{ id: "A", sold_by_platform: false, fulfilled_by_platform: true }],
  });
  assert.ok(risk.evidence_flags.includes("third_party_seller_platform_fulfilled"));
  assert.ok(risk.evidence_flags.includes("authorization_unknown"));
});

test("gray market and open-box remain distinct non-counterfeit facts", () => {
  const risks = deriveRiskFeatures({ offers: [
    { id: "A", gray_market_disclosed: true },
    { id: "B", condition: "open_box" },
  ] });
  assert.ok(risks[0].evidence_flags.includes("gray_market_disclosed"));
  assert.ok(risks[1].evidence_flags.includes("condition_open_box"));
  assert.ok(!risks.flatMap((r) => r.evidence_flags).includes("counterfeit"));
});
