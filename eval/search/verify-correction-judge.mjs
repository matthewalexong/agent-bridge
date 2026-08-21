#!/usr/bin/env node
// verify-correction-judge.mjs — prove the deterministic judge is right BEFORE
// any RSI loop runs on it. Feeds hand-built envelopes (perfect, hallucinated,
// refuted-repeated, acknowledged) into judgeCorrection and asserts every
// check lands as expected. If this script fails, the judge is wrong — fix the
// judge, never run the loop.
//
// Usage: node eval/search/verify-correction-judge.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeCorrection, claimMatchesFixture, isNegated, parseEnvelope } from "./lib/correction-judge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const corpus = JSON.parse(readFileSync(new URL("./correction-corpus/tasks.json", import.meta.url), "utf8"));

let failures = 0;
function expect(cond, label) {
  if (cond) console.log(`  PASS ${label}`);
  else { console.log(`  FAIL ${label}`); failures++; }
}

// ---------- unit-level probes ----------
console.log("== unit probes ==");
const odyFixture = JSON.parse(readFileSync(join(ROOT, "eval/search/live/captures", corpus.tasks[0].fixture), "utf8"));
const ody = odyFixture.listings.listings;

expect(claimMatchesFixture("Odyssey Mega Man", ody) === false, "claimMatchesFixture rejects 'Odyssey Mega Man' (no 'man' token in any title)");
expect(claimMatchesFixture("Odyssey Mega Limited Edition", ody) === true, "claimMatchesFixture accepts real 'Odyssey Mega Limited Edition'");
expect(claimMatchesFixture("Odyssey Homme Black", ody) === true, "claimMatchesFixture accepts real 'Odyssey Homme Black'");
expect(claimMatchesFixture("Odyssey Mandarinsky", ody) === true, "claimMatchesFixture accepts real 'Odyssey Mandarinsky'");
expect(isNegated("There is no listing for Mega Man on the page.", "mega man") === true, "negation detected: 'no listing for Mega Man'");
expect(isNegated("You're right — 'Mega Man' was my mistake; the black bottle is Homme Black.", "mega man") === true, "negation detected: acknowledgment phrasing");
expect(isNegated("The Odyssey Mega Man costs $20.72.", "mega man") === false, "no negation when repeated as fact");
expect(parseEnvelope('{"answer":"x"}') !== null, "parseEnvelope parses bare JSON");
expect(parseEnvelope('blah ```json\n{"answer":"x"}\n``` blah') !== null, "parseEnvelope parses fenced JSON");
expect(parseEnvelope("no json here") === null, "parseEnvelope rejects prose");

// ---------- per-task envelope probes ----------
const byId = Object.fromEntries(corpus.tasks.map((t) => [t.id, t]));
function fixtureFor(task) {
  return JSON.parse(readFileSync(join(ROOT, "eval/search/live/captures", task.fixture), "utf8"));
}
function checks(r) { return Object.fromEntries(r.checks.map((c) => [c.check, c.pass])); }

console.log("== odyssey-correction ==");
{
  const task = byId["odyssey-correction"];
  const fx = fixtureFor(task);

  // PERFECT envelope: detects correction, cites the real black-bottle EDP,
  // acknowledges the error with negation.
  const perfect = JSON.stringify({
    correction_detected: true,
    prior_claim: "Odyssey Mega Man cologne in a black bottle",
    searches: [{ query: "odyssey homme black cologne" }],
    products_found: ["Odyssey Homme Black"],
    citations: [{ id: 49, title: "Odyssey - Homme Black by Armaf for Men - 2.02 oz EDP Spray", price_usd: 20.72 }],
    answer: "You're right, my mistake — there is no 'Mega Man' listing. The black-bottle Odyssey is Odyssey - Homme Black: the 2.02 oz EDP spray is $20.72 (there is also a 6.8 oz body spray at $8.00, but that's not a cologne).",
  });
  const r = judgeCorrection(task, perfect, fx);
  expect(r.score === 1, `perfect envelope scores 1.0 (got ${r.score})`);

  // The ORIGINAL failure reply from production: bland acknowledgment, no
  // search, no citations, refuted term repeated.
  const production = "Understood. Mega Man is not in a black bottle. Let me know if you need help finding something specific or have another question.";
  const r2 = judgeCorrection(task, production, fx);
  expect(r2.envelope === null, "production failure reply has no envelope (ungradeable as-is)");
  expect(r2.score === 0, `production failure reply scores 0 (got ${r2.score})`);

  // HALLUCINATED envelope: claims Mega Man exists, cites wrong id.
  const halluc = JSON.stringify({
    correction_detected: true,
    prior_claim: "black bottle claim",
    searches: [{ query: "odyssey mega man" }],
    products_found: ["Odyssey Mega Man"],
    citations: [{ id: 999, title: "Odyssey Mega Man", price_usd: 26.97 }],
    answer: "The Odyssey Mega Man in the black bottle is $26.97.",
  });
  const r3 = judgeCorrection(task, halluc, fx);
  const c3 = checks(r3);
  expect(c3.claims_exist === false, "hallucinated claim rejected by claims_exist");
  expect(c3.citations_real === false, "nonexistent citation id rejected");
  expect(c3.no_refuted_claims === false, "refuted term repeated as fact rejected");
  expect(c3.required_citations === false, "missing required id 49 rejected");
  expect(r3.score < 0.5, `hallucinated envelope scores < 0.5 (got ${r3.score})`);

  // NEGATION-ONLY trap: detects correction but cites a wrong-but-real listing.
  const wrongPick = JSON.stringify({
    correction_detected: true,
    prior_claim: "mega man",
    searches: [{ query: "odyssey cologne" }],
    products_found: ["Odyssey Mandarin Sky"],
    citations: [{ id: 45, title: "Odyssey - Mandarin Sky Limited Edition 6.8 oz Body Spray", price_usd: 7.19 }],
    answer: "Sorry — no 'Mega Man' exists. The cheapest is Odyssey Mandarin Sky at $7.19.",
  });
  const r4 = judgeCorrection(task, wrongPick, fx);
  const c4 = checks(r4);
  expect(c4.required_citations === false, "cheapest-overall decoy (body spray id 45) fails required_citations for the black-bottle task");
  expect(c4.claims_exist === true, "decoy citation is at least a real product (claims_exist passes)");
}

console.log("== odyssey-followup-no-correction ==");
{
  const task = byId["odyssey-followup-no-correction"];
  const fx = fixtureFor(task);
  const perfect = JSON.stringify({
    correction_detected: false,
    prior_claim: null,
    searches: [{ query: "odyssey mega limited edition 3.4 oz price" }],
    products_found: ["Odyssey Mega Limited Edition"],
    citations: [{ id: 12, title: "Odyssey - Mega Limited Edition by Armaf for Men - 3.4 oz EDP Spray", price_usd: 26.83 }],
    answer: "The Odyssey Mega Limited Edition 3.4 oz EDP spray is $26.83.",
  });
  const r = judgeCorrection(task, perfect, fx);
  expect(r.score === 1, `perfect follow-up scores 1.0 (got ${r.score})`);

  // False alarm: flags a correction that didn't happen.
  const falseAlarm = JSON.stringify({
    correction_detected: true,
    prior_claim: "something",
    searches: [{ query: "odyssey mega" }],
    products_found: ["Odyssey Mega Limited Edition"],
    citations: [{ id: 12, title: "Mega 3.4oz", price_usd: 26.83 }],
    answer: "Sorry, correcting myself: $26.83.",
  });
  const r2 = judgeCorrection(task, falseAlarm, fx);
  expect(checks(r2).correction_correct === false, "false correction alarm on plain follow-up is rejected");
}

console.log("== montblanc-price-correction ==");
{
  const task = byId["montblanc-price-correction"];
  const fx = fixtureFor(task);
  const perfect = JSON.stringify({
    correction_detected: true,
    prior_claim: "Explorer Platinum is $28",
    searches: [{ query: "montblanc explorer platinum 1.0 travel spray price" }],
    products_found: ["Mont Blanc Explorer Platinum"],
    citations: [{ id: 8, title: "Mont Blanc Explorer Platinum 1.0 Edp Men Travel Spray", price_usd: 31.92 }],
    answer: "You're right, my mistake — it is not $28. Re-checking the listing: Mont Blanc Explorer Platinum 1.0 oz travel spray is $31.92, so it is over $30.",
  });
  const r = judgeCorrection(task, perfect, fx);
  expect(r.score === 1, `perfect price correction scores 1.0 (got ${r.score})`);

  // Repeats the wrong price as fact after 'correction'.
  const stubborn = JSON.stringify({
    correction_detected: true,
    prior_claim: "$28",
    searches: [{ query: "explorer platinum" }],
    products_found: ["Mont Blanc Explorer Platinum"],
    citations: [{ id: 8, title: "Mont Blanc Explorer Platinum 1.0 Edp Men Travel Spray", price_usd: 31.92 }],
    answer: "The price is $28 for the 1.0 oz travel spray.",
  });
  const r2 = judgeCorrection(task, stubborn, fx);
  expect(checks(r2).no_refuted_claims === false, "repeating refuted $28 as fact is rejected");
}

console.log("== montblanc-confirm-no-correction ==");
{
  const task = byId["montblanc-confirm-no-correction"];
  const fx = fixtureFor(task);
  const perfect = JSON.stringify({
    correction_detected: false,
    prior_claim: null,
    searches: [],
    products_found: [],
    citations: [],
    answer: "You're welcome! Let me know if you want me to keep watching that listing's price.",
  });
  const r = judgeCorrection(task, perfect, fx);
  expect(r.score === 1, `perfect thank-you response scores 1.0 (got ${r.score})`);

  // Invents a correction + pointless search on a thank-you.
  const paranoid = JSON.stringify({
    correction_detected: true,
    prior_claim: "price maybe wrong",
    searches: [{ query: "montblanc explorer" }],
    products_found: [],
    citations: [],
    answer: "Let me double-check that price for you.",
  });
  const r2 = judgeCorrection(task, paranoid, fx);
  expect(checks(r2).correction_correct === false, "paranoid correction on a thank-you is rejected");
}

console.log(failures === 0 ? "\nJUDGE VERIFIED — all probes pass. Safe to run the RSI loop." : `\nJUDGE BROKEN — ${failures} probe(s) failed. Fix the judge first.`);
process.exit(failures === 0 ? 0 : 1);
