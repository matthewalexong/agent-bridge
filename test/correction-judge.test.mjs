import test from "node:test";
import assert from "node:assert/strict";
import { judgeCorrection, claimMatchesFixture, parseEnvelope, isNegated } from "../eval/search/lib/correction-judge.mjs";

const fixture = {
  listings: { listings: [
    { id: 12, title: "Odyssey - Mega Limited Edition", price_usd: 26.83 },
    { id: 49, title: "Odyssey - Homme Black by Armaf for Men - 2.02 oz EDP Spray", price_usd: 20.72 },
    { id: 1, title: "Odyssey - Mandarinsky Limited Edition", price_usd: 31.92 },
  ] },
};
const correctionTask = {
  id: "t", expects_correction: true, refuted_terms: ["mega man"],
  requires_search: true, required_ids: [49],
};

function envStr(over = {}) {
  return JSON.stringify({
    correction_detected: true,
    prior_claim: "Mega Man",
    searches: [{ query: "odyssey black" }],
    products_found: ["Odyssey - Homme Black"],
    citations: [{ id: 49, price_usd: 20.72 }],
    answer: "You're right — there is no such product. The black-bottle one is Odyssey - Homme Black, $20.72.",
    ...over,
  });
}

test("correction-judge: perfect correction envelope scores 1", () => {
  const v = judgeCorrection(correctionTask, envStr(), fixture);
  assert.equal(v.score, 1, JSON.stringify(v.checks));
});

test("correction-judge: token-boundary — 'mega man' does NOT match 'Mega Limited Edition' or 'Mandarinsky'", () => {
  // The substring bug: 'man' matched inside 'Mandarinsky'. Token-boundary
  // matching must reject it so hallucinated product names fail claims_exist.
  assert.equal(claimMatchesFixture("Mega Man", fixture.listings.listings), false);
  assert.equal(claimMatchesFixture("Odyssey Homme Black", fixture.listings.listings), true);
});

test("correction-judge: hallucinated product name fails claims_exist", () => {
  const v = judgeCorrection(correctionTask, envStr({ products_found: ["Odyssey Mega Man"] }), fixture);
  const claims = v.checks.find((c) => c.check === "claims_exist");
  assert.equal(claims.pass, false);
});

test("correction-judge: empty citations OK on non-search task, FAIL on product task", () => {
  // The verifier caught this: a thank-you with no citations must not be
  // penalized, but a product-fact answer with zero citations must be.
  const thanks = { id: "t2", expects_correction: false, refuted_terms: [], requires_search: false, required_ids: [] };
  const v1 = judgeCorrection(thanks, JSON.stringify({
    correction_detected: false, prior_claim: null, searches: [], products_found: [], citations: [], answer: "You're welcome!",
  }), fixture);
  const c1 = v1.checks.find((c) => c.check === "citations_real");
  assert.equal(c1.pass, true, JSON.stringify(v1.checks));

  const v2 = judgeCorrection(correctionTask, envStr({ citations: [] }), fixture);
  const c2 = v2.checks.find((c) => c.check === "citations_real");
  assert.equal(c2.pass, false);
});

test("correction-judge: refuted term repeated as fact fails; negated passes", () => {
  const bad = judgeCorrection(correctionTask, envStr({
    answer: "Odyssey Mega Man is $26.83 and in stock.", // repeats refuted claim as fact
  }), fixture);
  assert.equal(bad.checks.find((c) => c.check === "no_refuted_claims").pass, false);

  const good = judgeCorrection(correctionTask, envStr({
    answer: "You're right, there is no Mega Man product. The correct one is Odyssey - Homme Black, $20.72.",
  }), fixture);
  assert.equal(good.checks.find((c) => c.check === "no_refuted_claims").pass, true);
});

test("correction-judge: wrong price citation fails citations_real", () => {
  const v = judgeCorrection(correctionTask, envStr({ citations: [{ id: 49, price_usd: 99.99 }] }), fixture);
  assert.equal(v.checks.find((c) => c.check === "citations_real").pass, false);
});

test("correction-judge: missing required citation id fails", () => {
  const v = judgeCorrection(correctionTask, envStr({ citations: [{ id: 12, price_usd: 26.83 }] }), fixture);
  assert.equal(v.checks.find((c) => c.check === "required_citations").pass, false);
});

test("correction-judge: no search on product question fails evidence_used", () => {
  const v = judgeCorrection(correctionTask, envStr({ searches: [] }), fixture);
  assert.equal(v.checks.find((c) => c.check === "evidence_used").pass, false);
});

test("correction-judge: wrong correction_detected fails", () => {
  const v = judgeCorrection(correctionTask, envStr({ correction_detected: false, prior_claim: null }), fixture);
  assert.equal(v.checks.find((c) => c.check === "correction_correct").pass, false);
});

test("parseEnvelope: fenced json, bare json, garbage", () => {
  const j = JSON.stringify({ a: 1 });
  assert.deepEqual(parseEnvelope("```json\n" + j + "\n```"), { a: 1 });
  assert.deepEqual(parseEnvelope("here: " + j), { a: 1 });
  assert.equal(parseEnvelope("no envelope here"), null);
  assert.equal(parseEnvelope("{broken"), null);
});

test("isNegated: cues within window", () => {
  assert.equal(isNegated("there is no mega man product", "mega man"), true);
  assert.equal(isNegated("mega man is great", "mega man"), false);
});
