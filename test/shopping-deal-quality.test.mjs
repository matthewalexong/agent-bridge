import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDealQuality } from "../lib/shopping-deal-quality.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-22T20:00:00.000Z");
const current = (overrides = {}) => ({ product_key: "camera-x", variant: "black", condition: "new", currency: "USD", landed_total_usd: 80, landed_price_verified: true, exact_identity: true, stock: "in_stock", risk_status: "low", ...overrides });
const history = (prices, overrides = {}) => prices.map((price, index) => ({ product_key: "camera-x", variant: "black", condition: "new", currency: "USD", landed_total_usd: price, verified: true, observed_at: new Date(NOW - (prices.length - index) * 10 * DAY).toISOString(), source: { id: `h${index}`, source_type: "history_provider", url: "https://history.example/item" }, ...overrides }));
const policy = { evaluated_at: new Date(NOW).toISOString(), min_observations: 5, min_distinct_days: 5, min_span_days: 30 };

test("verified exact-product landed history identifies a historical low", () => {
  const result = analyzeDealQuality({ current: current({ landed_total_usd: 70 }), observations: history([100, 95, 90, 85, 80]), policy });
  assert.equal(result.deal_quality, "historical_low");
  assert.equal(result.history.sufficient, true);
  assert.equal(result.timing.action, "buy_now");
  assert.equal(result.timing.future_price_guaranteed, false);
});

test("headline reference discount does not make an ordinary price a good deal", () => {
  const result = analyzeDealQuality({
    current: current({ landed_total_usd: 100, reference_price_usd: 200, advertised_discount_percent: 50, reference_price_verified: false, sale_claimed: true }),
    observations: history([95, 98, 100, 102, 105]), policy,
  });
  assert.equal(result.deal_quality, "typical");
  assert.ok(result.sale_claim.flags.includes("inflated_reference_price_risk"));
  assert.ok(result.sale_claim.flags.includes("ordinary_price_marketed_as_sale"));
  assert.equal(result.sale_claim.trustworthy_sale_claim, false);
  assert.equal(result.timing.action, "monitor");
});

test("advertised discount arithmetic mismatch is explicit", () => {
  const result = analyzeDealQuality({
    current: current({ landed_total_usd: 80, reference_price_usd: 100, advertised_discount_percent: 40, reference_price_verified: true }),
    observations: history([90, 92, 95, 98, 100]), policy,
  });
  assert.ok(result.sale_claim.flags.includes("advertised_discount_math_mismatch"));
  assert.equal(result.sale_claim.computed_reference_discount_percent, 20);
});

test("wrong variants, conditions, currencies, snippets, and unverified points are excluded", () => {
  const valid = history([80, 85, 90, 95, 100]);
  const invalid = [
    { ...valid[0], variant: "silver", observed_at: new Date(NOW - 100 * DAY).toISOString() },
    { ...valid[0], condition: "used", observed_at: new Date(NOW - 101 * DAY).toISOString() },
    { ...valid[0], currency: "EUR", observed_at: new Date(NOW - 102 * DAY).toISOString() },
    { ...valid[0], verified: false, observed_at: new Date(NOW - 103 * DAY).toISOString() },
    { ...valid[0], source: { id: "s", source_type: "search_snippet" }, observed_at: new Date(NOW - 104 * DAY).toISOString() },
  ];
  const result = analyzeDealQuality({ current: current(), observations: [...valid, ...invalid], policy });
  assert.equal(result.history.stats.observation_count, 5);
  assert.deepEqual(result.history.excluded_observations, { variant_mismatch: 1, condition_mismatch: 1, currency_mismatch: 1, unverified: 1, search_snippet: 1 });
});

test("duplicate points and a short history cannot manufacture sufficiency", () => {
  const observed_at = new Date(NOW - DAY).toISOString();
  const observations = Array.from({ length: 8 }, (_, index) => ({ product_key: "camera-x", variant: "black", condition: "new", currency: "USD", landed_total_usd: 80, verified: true, observed_at, source: { id: `same-${index}`, source_type: "history_provider", url: "https://history.example/item" } }));
  const result = analyzeDealQuality({ current: current(), observations, policy });
  assert.equal(result.history.stats.observation_count, 1);
  assert.equal(result.history.sufficient, false);
  assert.equal(result.timing.action, "research_more");
});

test("risk and identity blockers override an attractive price", () => {
  const observations = history([100, 95, 90, 85, 80]);
  const risky = analyzeDealQuality({ current: current({ landed_total_usd: 60, risk_status: "elevated" }), observations, policy });
  const wrong = analyzeDealQuality({ current: current({ landed_total_usd: 60, exact_identity: false }), observations, policy });
  assert.deepEqual(risky.timing, { action: "avoid_offer", reason: "offer_risk_elevated", future_price_guaranteed: false });
  assert.deepEqual(wrong.timing, { action: "research_more", reason: "exact_identity_unverified", future_price_guaranteed: false });
});

test("above-typical pricing yields wait unless the need is immediate", () => {
  const observations = history([70, 75, 80, 85, 90]);
  const flexible = analyzeDealQuality({ current: current({ landed_total_usd: 100 }), observations, policy });
  const urgent = analyzeDealQuality({ current: current({ landed_total_usd: 100 }), observations, policy, user_context: { urgency: "immediate" } });
  assert.equal(flexible.deal_quality, "above_typical");
  assert.equal(flexible.timing.action, "wait");
  assert.equal(urgent.timing.action, "buy_if_needed");
});

test("user maximum and reached target are deterministic timing constraints", () => {
  const observations = history([80, 90, 100, 110, 120]);
  const overBudget = analyzeDealQuality({ current: current({ landed_total_usd: 85 }), observations, policy, user_context: { max_price_usd: 80 } });
  const target = analyzeDealQuality({ current: current({ landed_total_usd: 85 }), observations, policy, user_context: { target_price_usd: 90 } });
  assert.equal(overBudget.timing.action, "wait");
  assert.equal(overBudget.timing.reason, "over_user_budget");
  assert.equal(target.timing.action, "buy_now");
  assert.equal(target.timing.reason, "user_target_reached");
});
