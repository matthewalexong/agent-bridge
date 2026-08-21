import test from "node:test";
import assert from "node:assert/strict";
import { judgeClarify, distinguishingAttribute } from "../eval/search/lib/clarify-judge.mjs";

// Ground truth: the clarify layer must only ask when the user's stated
// constraints genuinely cannot pick one listing AND the standing tie-breaks
// (cheapest, then reviews) also fail to separate them. Asking otherwise
// wastes the user's time; NOT asking on a true ambiguity guesses at intent.

function mk(id, flavor, g, price, reviews, extra = {}) {
  return {
    id,
    title: `Test Protein ${flavor} ${g}g`,
    brand: "Optimum",
    flavor,
    size_value: g,
    size_unit: "g",
    size_raw: `${g}g`,
    price_usd: price,
    reviews_raw: reviews,
    stock: "in stock",
    protein_value: null,
    ...extra,
  };
}

test("flavor ambiguity among tied candidates -> clarify with real options", () => {
  const r = judgeClarify([], [
    mk("a", "Chocolate", 1000, 40, "1,000"),
    mk("b", "Vanilla", 1000, 40, "1,000"),
  ]);
  assert.equal(r.action, "clarify");
  assert.equal(r.distinguishing_attr, "flavor");
  assert.match(r.question, /Chocolate/);
  assert.match(r.question, /Vanilla/);
  assert.deepEqual(r.tied_candidates, ["a", "b"]);
});

test("size ambiguity -> clarify", () => {
  const r = judgeClarify([], [
    mk("a", "Chocolate", 500, 40, "1,000"),
    mk("b", "Chocolate", 1000, 40, "1,000"),
  ]);
  assert.equal(r.action, "clarify");
  assert.equal(r.distinguishing_attr, "size");
});

test("cheapest decides -> never ask", () => {
  const r = judgeClarify([], [
    mk("a", "Chocolate", 1000, 35, "500"),
    mk("b", "Vanilla", 1000, 40, "2,000"),
  ]);
  assert.equal(r.action, "no-clarify");
  assert.match(r.reason, /cheapest/i);
});

test("reviews break a price tie -> never ask", () => {
  const r = judgeClarify([], [
    mk("a", "Chocolate", 1000, 40, "500"),
    mk("b", "Vanilla", 1000, 40, "2,000"),
  ]);
  assert.equal(r.action, "no-clarify");
  assert.match(r.reason, /review/i);
});

test("exactly one qualifying match -> never ask", () => {
  const r = judgeClarify([], [mk("a", "Chocolate", 1000, 40, "500")]);
  assert.equal(r.action, "no-clarify");
});

test("zero qualifying matches -> never ask (reformulate territory)", () => {
  const r = judgeClarify(
    [{ kind: "flavor", value: "strawberry" }],
    [mk("a", "Chocolate", 1000, 40, "500")]
  );
  assert.equal(r.action, "no-clarify");
});

test("constraints narrow to one -> never ask", () => {
  const r = judgeClarify(
    [{ kind: "flavor", value: "chocolate" }],
    [
      mk("a", "Chocolate", 1000, 40, "1,000"),
      mk("b", "Vanilla", 1000, 40, "1,000"),
    ]
  );
  assert.equal(r.action, "no-clarify");
});

test("candidates identical on all questionable attrs -> fall back to policy, no ask", () => {
  const r = judgeClarify([], [
    mk("a", "Chocolate", 1000, 40, null, { brand: "X" }),
    mk("b", "Chocolate", 1000, 40, null, { brand: "X" }),
  ]);
  // both same flavor, same size, same brand, no price/review signal —
  // there is nothing meaningful to ask
  assert.equal(r.action, "no-clarify");
});

test("out of stock excluded from the tie pool", () => {
  const r = judgeClarify([], [
    mk("a", "Chocolate", 1000, 40, "1,000"),
    mk("b", "Vanilla", 1000, 40, "1,000", { stock: "out of stock" }),
  ]);
  assert.equal(r.action, "no-clarify"); // only one in-stock candidate
});

test("distinguishingAttribute skips mostly-unknown attrs", () => {
  const d = distinguishingAttribute([
    mk("a", "", 1000, 40, null),
    mk("b", "", 1000, 40, null),
  ]);
  // flavor unknown on both -> skip; size known+equal -> not distinguishing;
  // brand equal -> null
  assert.equal(d, null);
});
