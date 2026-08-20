#!/usr/bin/env node
// search-value.mjs — the MVP pipeline: search query → $/gram of protein ranking.
//
// Stage 1 (SERP): deterministic DOM extraction on the search page — coarse
//   filter to a shortlist of candidates (price, availability, ASIN).
// Stage 2 (Label): for each candidate, read the REGULATED facts — gallery OCR
//   of the Nutrition/Supplement Facts panel, DOM info-table fallback. Zero LLM.
// Rank by dollars per gram of protein, the metric that actually measures value.
//
// Usage:
//   node eval/search/live/search-value.mjs --query "whey protein isolate 5lb" [--top 6]
//
// All tabs are closed on every exit path. Sequential, bounded, deterministic.

import { extractSerp } from "./extract-serp.mjs";
import { readLabel } from "./read-label.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

// Stage 1 output → shortlist: unique ASINs with a price, in stock, bounded.
function shortlist(listings, n) {
  const seen = new Set();
  const picks = [];
  for (const l of listings) {
    if (!l.asin || seen.has(l.asin)) continue;
    if (l.price_usd == null || l.stock === "out of stock") continue;
    seen.add(l.asin);
    picks.push(l);
    if (picks.length >= n) break;
  }
  return picks;
}

async function main() {
  const query = arg("query");
  if (!query) {
    console.error('usage: search-value.mjs --query "whey protein isolate 5lb" [--top 6]');
    process.exit(1);
  }
  const top = Number(arg("top", 6));
  const serpUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;

  // Claimed package weight in grams, from the SERP listing's parsed size.
  // Whey is >=~20% protein by weight, so this bounds any plausible label total.
  const claimedGrams = (l) => {
    const oz = l.size_parsed?.total_oz;
    return oz ? Math.round(oz * 28.3495) : null;
  };

  // Stage 1 — one SERP tab.
  const serp = await extractSerp(serpUrl, "[mvp/serp]");
  const listings = serp.listings ?? [];
  const candidates = shortlist(listings, top);
  console.error(`[mvp] SERP: ${listings.length} listings → shortlist of ${candidates.length}`);

  // Stage 2 — one product-page tab per candidate, sequential, always closed.
  const results = [];
  for (const c of candidates) {
    console.error(`[mvp/label] ${c.asin} — ${c.title.slice(0, 60)}`);
    let label;
    try {
      label = await readLabel(c.asin, c.price_usd, Number(arg("max-images", 20)), claimedGrams(c));
    } catch (e) {
      label = { asin: c.asin, found: false, source: null, error: e.message };
    }
    results.push({
      asin: c.asin,
      title: c.title,
      price_usd: c.price_usd,
      review_count: c.review_count ?? null,
      label,
    });
  }

  // Rank: resolved candidates by $/g protein; suspect/unresolved sink to bottom.
  const ranked = [...results].sort((a, b) => {
    const ok = (r) => r.label.dollarsPerGramProtein != null && !r.label.suspect;
    if (ok(a) && !ok(b)) return -1;
    if (!ok(a) && ok(b)) return 1;
    const da = a.label.dollarsPerGramProtein ?? Infinity;
    const db = b.label.dollarsPerGramProtein ?? Infinity;
    return da - db;
  });

  const out = {
    query, capturedAt: new Date().toISOString(),
    serpResultCount: serp.resultCount ?? null,
    shortlistSize: candidates.length,
    resolved: ranked.filter((r) => r.label.dollarsPerGramProtein != null && !r.label.suspect).length,
    ranking: ranked.map((r, i) => ({
      rank: i + 1,
      asin: r.asin,
      price_usd: r.price_usd,
      dollars_per_gram_protein: r.label.suspect ? null : r.label.dollarsPerGramProtein,
      total_protein_g: r.label.totalProteinG,
      servings: r.label.servingsPerContainer,
      protein_per_serving_g: r.label.proteinPerServingG,
      claimed_weight_g: r.label.claimedWeightG,
      suspect: r.label.suspect || false,
      source: r.label.source ?? (r.label.error ? `error: ${r.label.error}` : "not found"),
      title: r.title,
    })),
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(join(__dirname, "captures"), { recursive: true });
  const outPath = join(__dirname, "captures", `value-${ts}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.error(`[mvp] wrote ${outPath}`);
}

main().catch((e) => {
  console.error("FATAL:", e.message || e);
  process.exit(1);
});
