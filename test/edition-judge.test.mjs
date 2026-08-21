import assert from "node:assert/strict";
import test from "node:test";
import { judgeEditionDecoy } from "../eval/search/lib/edition-judge.mjs";

// Fixture shape mirrors captures/extract-black-bottle-*.json
const fixture = {
  listings: [
    { id: 1, title: "Odyssey - Homme Black by Armaf for Men - 2.02 oz EDP Spray", price_usd: 20.72 },
    { id: 2, title: "Armaf Odyssey Homme for Men Eau de Parfum Spray, 3.4 Ounce", price_usd: 25.99 },
    { id: 3, title: "Armaf Odyssey Black Forest Dessert Edition Eau de Parfum Spray 3.4 oz", price_usd: 25.26 },
    { id: 6, title: "Odyssey - Homme Black by Armaf for Men - 6.8 oz Body Spray", price_usd: 8.0 },
    { id: 8, title: "Odyssey Black Forest Eau de Toilette, 3.4 fl oz", price_usd: 17.99 },
  ],
};
const spec = {
  allowed_ids: [1, 6],
  decoy_ids: [3, 8],
  decoy_names: ["black forest"],
  must_cite_one_of: [1, 6],
};

test("judge: clean envelope citing only correct listings passes", () => {
  const env = {
    citations: [{ id: 1, price_usd: 20.72 }, { id: 6, price_usd: 8.0 }],
    products_found: ["Odyssey - Homme Black"],
    answer: "The black-bottle Odyssey is Odyssey Homme Black.",
  };
  const r = judgeEditionDecoy(env, fixture, spec);
  assert.equal(r.pass, true, JSON.stringify(r.failures));
});

test("judge: reproduces the live bug — citing Black Forest Dessert Edition fails", () => {
  const env = {
    citations: [{ id: 3, price_usd: 25.26 }, { id: 1, price_usd: 20.72 }],
    products_found: ["Odyssey - Homme Black"],
    answer: "Cheapest is the body spray at $8.00 [id 6]. The 3.4 oz Black Forest Dessert Edition is $25.26 [id 3].",
  };
  const r = judgeEditionDecoy(env, fixture, spec);
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes("[id 3]")), `should flag citation 3: ${r.failures}`);
  assert.ok(r.failures.some((f) => f.includes("answer presents decoy")), `should flag answer text: ${r.failures}`);
});

test("judge: decoy in products_found fails", () => {
  const env = {
    citations: [{ id: 1, price_usd: 20.72 }],
    products_found: ["Odyssey Black Forest Dessert Edition"],
    answer: "Odyssey Homme Black.",
  };
  const r = judgeEditionDecoy(env, fixture, spec);
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes("products_found")));
});

test("judge: uncited id-shifted decoy still caught by title marker", () => {
  const shifted = { listings: [{ id: 99, title: "Armaf Odyssey Black Forest Dessert Edition", price_usd: 25 }, { id: 1, title: "Odyssey - Homme Black 2.02 oz", price_usd: 20.72 }] };
  const env = { citations: [{ id: 99, price_usd: 25 }], products_found: [], answer: "x" };
  const r = judgeEditionDecoy(env, shifted, spec);
  assert.equal(r.pass, false);
});

test("judge: no correct citation fails (unfounded)", () => {
  const env = { citations: [], products_found: [], answer: "It costs about $20." };
  const r = judgeEditionDecoy(env, fixture, spec);
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes("no citation")));
});
