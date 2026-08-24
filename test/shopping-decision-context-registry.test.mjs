import test from "node:test";
import assert from "node:assert/strict";
import { createShoppingDecisionContext } from "../lib/shopping-decision-context.mjs";
import { createShoppingDecisionContextRegistry } from "../lib/shopping-decision-context-registry.mjs";
import { issueShoppingRequestReceipt } from "../lib/shopping-request-intent.mjs";

const NOW = Date.parse("2026-08-24T20:00:00.000Z");
const skipped = () => ({ required: false, reason: "Not applicable to this fixture." });

function context(at = NOW, max_age_seconds = 3_600, product_id = "camera-x") {
  const request_receipt = issueShoppingRequestReceipt({ request_id: `panel-context-ref-${product_id}`, request_revision: 1, text: `Research ${product_id}.`, captured_at: new Date(at).toISOString() });
  const clauseId = request_receipt.clauses[0].clause_id;
  return createShoppingDecisionContext({
    request_receipt,
    profile_state_revision: 0,
    phase: "product_recommendation",
    product_id,
    objective: `Research ${product_id}.`,
    objective_clause_ids: [clauseId],
    clause_dispositions: [{ clause_id: clauseId, role: "objective" }],
    market_country_code: "US",
    destination: { country_code: "US" },
    applicability: Object.fromEntries(["candidate_coverage", "performance", "value", "condition", "promotion", "review_integrity", "composition", "privacy", "compatibility", "lifecycle", "preferences", "ownership", "deal"].map((name) => [name, skipped()])),
    max_age_seconds,
  }, () => at);
}

test("decision-context registry reuses the exact signed artifact by compact reference", () => {
  const registry = createShoppingDecisionContextRegistry({ clock: () => NOW });
  const signed = context();
  const reference = registry.remember(signed);
  assert.deepEqual(reference, { context_id: signed.context_id });
  assert.deepEqual(registry.resolve(reference), signed);
});

test("decision-context registry fails closed for unknown, expired, and tampered contexts", () => {
  const registry = createShoppingDecisionContextRegistry({ clock: () => NOW });
  assert.throws(() => registry.resolve({ context_id: `shopping_context_${"0".repeat(32)}` }), { code: "shopping_decision_context_reference_unknown" });
  const shortLived = context(NOW, 300);
  registry.remember(shortLived, NOW);
  assert.throws(() => registry.resolve({ context_id: shortLived.context_id }, NOW + 300_001), { code: "shopping_decision_context_reference_expired" });
  const tampered = context();
  tampered.product_id = "camera-y";
  assert.throws(() => registry.remember(tampered), { code: "shopping_decision_context_reference_invalid" });
});

test("decision-context registry evicts the least recently used bounded entry", () => {
  const registry = createShoppingDecisionContextRegistry({ max_entries: 1, clock: () => NOW });
  const first = context();
  registry.remember(first);
  const second = context(NOW, 3_600, "camera-y");
  registry.remember(second);
  assert.throws(() => registry.resolve({ context_id: first.context_id }), { code: "shopping_decision_context_reference_unknown" });
  assert.deepEqual(registry.resolve({ context_id: second.context_id }), second);
});
