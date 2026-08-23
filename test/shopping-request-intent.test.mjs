import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { issueShoppingRequestReceipt, inventoryShoppingRequestClauses, verifyShoppingRequestReceipt } from "../lib/shopping-request-intent.mjs";

const NOW = "2026-08-22T20:00:00.000Z";

test("request intake inventories every clause and flags constraint domains", () => {
  const inventory = inventoryShoppingRequestClauses("I need headphones. They must be under $200. They must work with my iPhone. No leather. Deliver by Friday.");
  assert.equal(inventory.clauses.length, 5);
  assert.deepEqual(inventory.clauses.map((item) => item.constraint_hints), [[], ["budget"], ["compatibility"], ["composition"], ["deadline", "fulfillment"]]);
  assert.deepEqual(inventory.clauses.map((item) => inventory.text.slice(item.start, item.end)), inventory.clauses.map((item) => item.text));
  assert.deepEqual(inventory.clauses[1].literal_facts.map(({ kind, operator, value, unit }) => ({ kind, operator, value, unit })), [{ kind: "money", operator: "lt", value: 200, unit: "USD" }]);
  assert.deepEqual(inventory.clauses[3].literal_facts.map(({ kind, operator, value, unit }) => ({ kind, operator, value, unit })), [{ kind: "negation", operator: "not_allowed", value: false, unit: null }]);
  assert.deepEqual(inventory.clauses[4].literal_facts.map(({ kind, operator, value, unit }) => ({ kind, operator, value, unit })), [{ kind: "deadline", operator: "by", value: "friday", unit: "date" }]);
  const ordinary = inventoryShoppingRequestClauses("Look for over-ear headphones. Tell me before I buy.");
  assert.deepEqual(ordinary.clauses.map((item) => item.constraint_hints), [[], []]);
});

test("request receipts reject message, clause, provenance, and process tampering", () => {
  const receipt = issueShoppingRequestReceipt({ request_id: "panel_7", text: "Find a camera. Keep it under $500.", captured_at: NOW });
  assert.equal(verifyShoppingRequestReceipt(receipt), true);
  assert.match(receipt.message_sha256, /^[a-f0-9]{64}$/);
  for (const mutate of [
    (value) => { value.text = "Find any camera."; },
    (value) => { value.clauses[1].constraint_hints = []; },
    (value) => { value.request_id = "panel_8"; },
    (value) => { value.captured_at = "2026-08-22T19:00:00.000Z"; },
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assert.equal(verifyShoppingRequestReceipt(changed), false);
  }
  const moduleUrl = new URL("../lib/shopping-request-intent.mjs", import.meta.url).href;
  const script = `import { verifyShoppingRequestReceipt } from ${JSON.stringify(moduleUrl)}; const value = JSON.parse(process.argv[1]); process.stdout.write(String(verifyShoppingRequestReceipt(value)));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(receipt)], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "false");
});

test("typed literals preserve numeric value, unit, direction, deadline, and polarity", () => {
  const clauses = inventoryShoppingRequestClauses("At least 16 GB; under €999; no more than 20%; exactly 2 units; deliver by 2026-09-01; without leather.").clauses;
  assert.deepEqual(clauses.map((clause) => clause.literal_facts.map(({ kind, operator, value, unit }) => ({ kind, operator, value, unit }))), [
    [{ kind: "measurement", operator: "gte", value: 16, unit: "gb" }],
    [{ kind: "money", operator: "lt", value: 999, unit: "EUR" }],
    [{ kind: "percentage", operator: "lte", value: 20, unit: "%" }],
    [{ kind: "quantity", operator: "eq", value: 2, unit: "units" }],
    [{ kind: "deadline", operator: "by", value: "2026-09-01", unit: "date" }],
    [{ kind: "negation", operator: "not_allowed", value: false, unit: null }],
  ]);
  const negatedComparisons = inventoryShoppingRequestClauses("Not over $500; not under 16 GB.").clauses;
  assert.deepEqual(negatedComparisons.map((clause) => clause.literal_facts.map(({ operator }) => operator)), [["lte"], ["gte"]]);
});

test("shipment tracking and privacy tracking route to different constraint domains", () => {
  const inventory = inventoryShoppingRequestClauses("Tracking is required. Do not allow location tracking.");
  assert.deepEqual(inventory.clauses.map((item) => item.constraint_hints), [["fulfillment"], ["privacy"]]);
});
