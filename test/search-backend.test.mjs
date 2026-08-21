import test from "node:test";
import assert from "node:assert/strict";
import { renderFixtureSerp, tokenize, makeSearchBackend, loadFixture } from "../eval/search/live/search-backend.mjs";

// 52-style fixture: many listings share a common token; the specific one
// we want carries MORE query tokens. Raw page order would bury it past
// the 15-result cap; relevance ranking must surface it.
const fixture = {
  url: "https://amazon.test/s?k=odyssey",
  listings: {
    listings: [
      // 20 decoys that share "odyssey" only, listed FIRST in page order
      ...Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `Odyssey Variant ${i + 1}`, price_usd: 10 + i })),
      // the target: carries odyssey + homme + black (3 query tokens)
      { id: 49, title: "Odyssey - Homme Black by Armaf for Men - 2.02 oz EDP Spray", price_usd: 20.72 },
      { id: 50, title: "Odyssey - Homme Black Body Spray", price_usd: 8.0 },
    ],
  },
};

test("renderFixtureSerp: relevance ranking surfaces multi-token matches past the 15-cap", () => {
  // Regression: raw page-order slicing returned only the first 15 decoys;
  // "odyssey homme black" never showed id 49. A real SERP ranks by relevance.
  const out = renderFixtureSerp(fixture, "odyssey homme black");
  assert.ok(out.includes("[id 49]"), "id 49 must be visible");
  const lines = out.split("\n").filter((l) => l.startsWith("[id"));
  assert.ok(lines.length <= 15, "cap respected");
  // Top results must be the 3-token and 2-token matches, before 1-token decoys
  assert.ok(lines[0].includes("[id 49]"), `first result should be id 49, got: ${lines[0]}`);
});

test("renderFixtureSerp: zero matches reported honestly", () => {
  const out = renderFixtureSerp(fixture, "unicorn platinum");
  assert.ok(out.includes("No listings matched"));
});

test("renderFixtureSerp: deterministic ordering (stable tie-break)", () => {
  const a = renderFixtureSerp(fixture, "odyssey homme black");
  const b = renderFixtureSerp(fixture, "odyssey homme black");
  assert.equal(a, b);
});

test("tokenize: drops stopwords and 1-char tokens, keeps product tokens", () => {
  const toks = tokenize("find the cheapest Odyssey cologne in a black bottle");
  assert.ok(toks.includes("odyssey"));
  assert.ok(toks.includes("black"));
  assert.ok(toks.includes("cologne"), "cologne is the product family, not a stopword");
  assert.ok(!toks.includes("the"));
  assert.ok(!toks.includes("cheapest"));
});

test("makeSearchBackend fixture mode via name; live mode never used here", () => {
  const search = makeSearchBackend({ fixture });
  return search("odyssey").then((r) => {
    assert.ok(r.startsWith("SEARCH RESULTS"));
    assert.ok(r.includes("[id"));
  });
});

test("loadFixture resolves bare names against captures/", () => {
  // Uses a real capture written by extract-serp (committed fixture).
  const f = loadFixture("extract-2026-08-21T16-02-38-384Z.json");
  assert.ok(f.listings.listings.length > 0);
});
