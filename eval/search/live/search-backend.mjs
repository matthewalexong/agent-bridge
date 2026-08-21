// search-backend.mjs — the panel brain's research tool.
//
// Two modes:
//   FIXTURE (default for eval): renders listings from a captured SERP JSON
//     (eval/search/live/captures/extract-*.json). Deterministic, offline,
//     free. The query filters listings by title tokens — like a real search
//     engine returns a relevance-filtered page, and a query for something
//     that doesn't exist returns nothing (which is a FINDING, not an error).
//   LIVE (AB_SEARCH_BACKEND=live): real Amazon SERP via extract-serp.mjs —
//     real Chrome, real cookies. Tab is always closed by extract-serp.
//     Only for final live verification; never inside the eval loop.
//
// Output is a plain-text rendered SERP with stable [id N] handles the model
// can cite. The judge validates citations against these ids.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "of", "in", "on", "to", "with",
  "is", "it", "one", "that", "this", "me", "my", "find", "search", "what",
  "which", "cheapest", "best", "show", "get", "help", "looking", "cologne",
]);
// NOTE: "cologne" is NOT a stopword for matching — it's the product family.
STOPWORDS.delete("cologne");

export function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function renderListing(l) {
  const parts = [`[id ${l.id}] ${l.title || "(no title)"}`];
  if (l.price_usd != null) parts.push(`$${Number(l.price_usd).toFixed(2)}`);
  if (l.size_raw) parts.push(l.size_raw);
  if (l.stock) parts.push(l.stock);
  if (l.review_count != null) parts.push(`${Number(l.review_count).toLocaleString("en-US")} reviews`);
  if (l.rating != null) parts.push(`rating ${l.rating}`);
  if (l.sponsored) parts.push("SPONSORED");
  return parts.join(" | ");
}

// Render a fixture's listings as a SERP page filtered by query tokens.
// A listing matches if ANY non-stopword query token appears in its title.
// Matches are ranked by number of distinct matched tokens (desc), then page
// order — like a real SERP ranks by relevance instead of dumping raw page
// order. (Raw page order buried the correct listing past the 15-result cap
// on broad queries; a real Amazon SERP would not do that.) Deterministic:
// stable sort, token-count key only.
// Zero matches is a legitimate result — it means the searched thing isn't
// on this page.
export function renderFixtureSerp(fixture, query, { maxListings = 15 } = {}) {
  const listings = fixture?.listings?.listings ?? fixture?.listings ?? [];
  const arr = Array.isArray(listings) ? listings : Object.values(listings);
  const qTokens = [...new Set(tokenize(query))];
  const matched = arr
    .map((l, idx) => {
      const title = (l.title || "").toLowerCase();
      const hits = qTokens.filter((t) => title.includes(t)).length;
      return { l, idx, hits };
    })
    .filter((m) => m.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.idx - b.idx)
    .map((m) => m.l);
  const source = fixture?.url || "fixture";
  if (matched.length === 0) {
    return `SEARCH RESULTS for "${query}" (source: ${source})\nNo listings matched. ${arr.length} listings existed on the page but none matched these terms.`;
  }
  const lines = matched.slice(0, maxListings).map(renderListing);
  return `SEARCH RESULTS for "${query}" (source: ${source}, ${matched.length} matched)\n${lines.join("\n")}`;
}

export function loadFixture(pathOrName) {
  const p = pathOrName.startsWith("/")
    ? pathOrName
    : join(__dirname, "captures", pathOrName);
  return JSON.parse(readFileSync(p, "utf8"));
}

// Backend factory: env/config-controlled so eval never touches live Chrome.
//   opts.fixture     — fixture object or path (fixture mode)
//   opts.live        — true for live mode (extract-serp)
export function makeSearchBackend(opts = {}) {
  if (opts.live || process.env.AB_SEARCH_BACKEND === "live") {
    return async function liveSearch(query) {
      const { extractSerp } = await import(join(__dirname, "extract-serp.mjs"));
      const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
      const res = await extractSerp({ url }); // tab always closed inside
      return renderFixtureSerp(res, query, { maxListings: 15 });
    };
  }
  let fixture = opts.fixture;
  if (typeof fixture === "string") fixture = loadFixture(fixture);
  if (!fixture) throw new Error("search-backend: no fixture provided (fixture mode)");
  return async function fixtureSearch(query) {
    return renderFixtureSerp(fixture, query);
  };
}
