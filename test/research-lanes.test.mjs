import assert from "node:assert/strict";
import test from "node:test";
import { executeSearchBatch, formatSearchBatchResults, parseSearchBatchDirective } from "../eval/search/live/research-lanes.mjs";

test("search batches accept only bounded architecture lanes", () => {
  const parsed = parseSearchBatchDirective('SEARCH_BATCH: [{"lane":"product_evidence","query":"camera battery test"},{"lane":"safety","query":"camera recall"}]');
  assert.deepEqual(parsed, { error: null, items: [
    { lane: "product_evidence", query: "camera battery test" },
    { lane: "safety", query: "camera recall" },
  ] });
  assert.equal(parseSearchBatchDirective('SEARCH_BATCH: [{"lane":"gemma","query":"decide"}]').error, "invalid_search_batch_item");
  assert.equal(parseSearchBatchDirective("SEARCH_BATCH: not-json").error, "invalid_search_batch_json");
});

test("independent lane searches start concurrently", async () => {
  const started = [];
  const releases = [];
  const search = (query) => new Promise((resolve) => { started.push(query); releases.push(() => resolve(`result:${query}`)); });
  const pending = executeSearchBatch([
    { lane: "product_evidence", query: "camera tests" },
    { lane: "safety", query: "camera recalls" },
    { lane: "offer_risk", query: "camera authorized sellers" },
  ], search);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["camera tests", "camera recalls", "camera authorized sellers"], "all searches must start before any one completes");
  releases.forEach((release) => release());
  const entries = await pending;
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.status === "complete"));
});

test("shared query keys deduplicate within and across batches", async () => {
  let calls = 0;
  const cache = new Map();
  const search = async (query) => { calls += 1; return `results:${query}`; };
  let entries = await executeSearchBatch([
    { lane: "discovery", query: "  Camera X  " },
    { lane: "price_logistics", query: "camera x" },
  ], search, { cache });
  assert.equal(calls, 1);
  assert.deepEqual(entries[0].lanes, ["discovery", "price_logistics"]);
  entries = await executeSearchBatch([{ lane: "offer_risk", query: "CAMERA X" }], search, { cache });
  assert.equal(calls, 1);
  assert.equal(entries[0].cached, true);
  assert.match(formatSearchBatchResults(entries), /LANES: offer_risk\nQUERY: CAMERA X\nresults:Camera X/i);
});
