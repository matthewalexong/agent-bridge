import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { preparePurchaseDecision, finalizePurchaseDecision } from "../eval/shopping/lib/purchase-controller.mjs";

const taskDir = new URL("../eval/shopping/tasks/", import.meta.url);
const expected = {
  "shipping-trap": ["select", "B", 98],
  "edition-decoy": ["select", "B", 31],
  "unit-value": ["select", "B", 48],
  "ineligible-coupon": ["select", "B", 65],
  "authorized-seller": ["select", "B", 199],
  "condition-trap": ["select", "B", 149],
  "unknown-shipping": ["select", "B", 46],
  "stock-trap": ["select", "B", 699],
  "no-match": ["research_more", null, null],
  "clarify": ["clarify", null, null],
};

for (const file of readdirSync(taskDir).filter((name) => name.endsWith(".json")).sort()) {
  const task = JSON.parse(readFileSync(join(taskDir.pathname, file), "utf8"));
  test(`shopping controller: ${task.id}`, () => {
    const { verified_decision: decision } = preparePurchaseDecision(task);
    const [action, offer, landed] = expected[task.id];
    assert.deepEqual(decision, {
      action,
      selected_offer: offer,
      landed_total_usd: landed,
    });
  });
}

test("model explanation cannot override safety-critical decision fields", () => {
  const verified = { action: "select", selected_offer: "B", landed_total_usd: 98 };
  const result = finalizePurchaseDecision(verified, {
    action: "select",
    selected_offer: "A",
    landed_total_usd: 1,
    evidence: ["model prose"],
  });
  assert.deepEqual(result, { ...verified, evidence: ["model prose"] });
});

test("legacy purchase controller also refuses raw listing quantity for unit value", () => {
  const task = { objective: "unit_cost", requirements: { product_key: "x" }, offers: [{ id: "A", product_key: "x", quantity: 999, price_usd: 10, shipping_usd: 0, stock: "in_stock" }] };
  const result = preparePurchaseDecision(task);
  assert.deepEqual(result.verified_decision, { action: "research_more", selected_offer: null, landed_total_usd: null });
  assert.equal(result.normalized_offers[0].computed_unit_cost_usd, null);
});
