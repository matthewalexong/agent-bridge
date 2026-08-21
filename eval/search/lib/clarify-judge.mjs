#!/usr/bin/env node
// eval/search/lib/clarify-judge.mjs — deterministic "should the agent ask the
// user for more detail?" judgment layer. NO LLM.
//
// When is a request incomplete? Not when listings are messy (that's
// reformulate), but when the USER never specified enough to distinguish
// between several perfectly-qualified options. Example: "buy protein powder"
// against a SERP where a 1kg chocolate, a 1kg vanilla and a 2kg chocolate ALL
// match every stated constraint — nothing in the request picks one. The
// correct action is to ASK, not to guess by price or position.
//
// Decision policy (pure code, deterministic):
//   1. 0 in-stock full matches            -> clarify is WRONG
//      (nothing to choose between; either buy nothing or reformulate)
//   2. 1 in-stock full match              -> clarify is WRONG
//      (the request already picks a winner — asking wastes the user's time)
//   3. >=2 in-stock full matches that TIE-BREAK cleanly
//      (cheapest price differs, or reviews break a price tie)
//                                         -> clarify is WRONG
//      (the standing policy "cheapest qualifying wins" already decides;
//       asking would second-guess an encoded, defensible default)
//   4. >=2 in-stock full matches with NO separating signal the user stated
//      and the tie-break pool is genuinely ambiguous:
//        - same price AND same (or all-unknown) review counts, OR
//        - prices equal within tolerance with unknown reviews on both
//                                         -> clarify is RIGHT
//      The question must name a DISTINGUISHING ATTRIBUTE that differs between
//      the tied candidates (size, flavor, brand) — asking "which one?" with
//      the actual options is the only move that respects the user's intent.
//
// The clarification QUESTION is composed in code from the tied candidates'
// differing attributes; the model's transcription supplies the raw material,
// but the choice of WHAT to ask about is deterministic.

import { judgeSearch, totalSizeG, extractReviewCount, canonicalBrand } from "./search-judge.mjs";

const num = (v) => {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    if (isFinite(n) && v.trim() !== "") return n;
  }
  return null;
};

// Attributes a clarification question can reference, in preference order.
// Each knows how to read itself off a listing.
const QUESTIONABLE_ATTRS = [
  { attr: "flavor", read: (l) => (l.flavor ?? "").trim() || null },
  { attr: "size", read: (l) => {
      const g = totalSizeG(l);
      return g != null ? `${g} g` : null;
    } },
  { attr: "brand", read: (l) => {
      const b = canonicalBrand(l.brand);
      return b || null;
    } },
];

// Find the first attribute on which the tied candidates actually differ.
// Returns { attr, options: [{listingId, value}] } or null if the candidates
// are indistinguishable on every questionable attribute (degenerate: then
// there is nothing meaningful to ask).
export function distinguishingAttribute(candidates) {
  for (const { attr, read } of QUESTIONABLE_ATTRS) {
    const values = candidates.map((l) => ({ listingId: l.id ?? "?", value: read(l) }));
    const known = values.filter((v) => v.value != null);
    if (known.length < 2) continue; // can't distinguish on mostly-unknown data
    const distinct = new Set(known.map((v) => v.value.toLowerCase()));
    if (distinct.size >= 2) return { attr, options: known };
  }
  return null;
}

// Main entry. Mirrors judgeSearch's matching semantics so the two layers
// never disagree about what counts as a full match.
export function judgeClarify(constraints, listings, opts = {}) {
  const base = judgeSearch(constraints, listings);

  const ls = Array.isArray(listings) ? listings : [];
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const total = constraints.length;
  const constraintMetLocal = (c, listing) => {
    // identical semantics to search-judge.constraintMet (kept local to avoid
    // exporting a private; verified in the judge harness below)
    switch (c.kind) {
      case "flavor": return norm(listing.flavor).includes(norm(c.value));
      case "size_g": {
        const g = totalSizeG(listing);
        return g != null && Math.abs(g - c.value) <= Math.max(2, c.value * 0.005);
      }
      case "protein_g": {
        const n = num(listing.protein_value);
        return n != null && Math.abs(n - c.value) <= 0.5;
      }
      case "brand": return canonicalBrand(listing.brand) === canonicalBrand(c.value);
      default: return false;
    }
  };

  const fullInStock = ls.filter((l) =>
    constraints.every((c) => constraintMetLocal(c, l)) && norm(l.stock) !== "out of stock");

  if (fullInStock.length <= 1) {
    return {
      action: "no-clarify",
      reason: fullInStock.length === 0
        ? "no in-stock full match — nothing to choose between"
        : "exactly one qualifying match — the request already decides",
      base_verdict: base.action,
    };
  }

  // >=2 full matches. Do the standing tie-breaks already decide?
  const priced = fullInStock.map((l) => ({
    id: l.id ?? "?",
    price: num(l.price_usd),
    reviews: extractReviewCount(l.reviews_raw) ?? num(l.review_count),
    listing: l,
  }));
  const knownPrices = priced.filter((p) => p.price != null);
  const minPrice = knownPrices.length ? Math.min(...knownPrices.map((p) => p.price)) : null;
  const cheapest = knownPrices.filter((p) => p.price === minPrice);

  let tieResolved = false;
  let how = "";
  if (minPrice != null && cheapest.length === 1) {
    tieResolved = true;
    how = "a single cheapest qualifying match decides";
  } else if (minPrice != null && cheapest.length > 1) {
    // Price tie -> reviews break it.
    const knownReviews = cheapest.filter((p) => p.reviews != null);
    if (knownReviews.length) {
      const maxR = Math.max(...knownReviews.map((p) => p.reviews));
      const winners = knownReviews.filter((p) => p.reviews === maxR);
      if (winners.length === 1) { tieResolved = true; how = "review count breaks the price tie"; }
    }
  }

  if (tieResolved) {
    return {
      action: "no-clarify",
      reason: how,
      base_verdict: base.action,
      selected_listing: base.selected_listing,
    };
  }

  // Genuinely ambiguous pool — is there anything meaningful to ask?
  const pool = (cheapest.length ? cheapest : priced).map((p) => p.listing);
  const dist = distinguishingAttribute(pool);
  if (!dist) {
    return {
      action: "no-clarify",
      reason: "candidates indistinguishable on flavor/size/brand — fall back to policy",
      base_verdict: base.action,
      selected_listing: base.selected_listing,
    };
  }

  const options = dist.options.map((o) => `${o.value} (${o.listingId})`).join(" or ");
  return {
    action: "clarify",
    reason: `${pool.length} qualifying matches are tied; only ${dist.attr} separates them`,
    question: `Which ${dist.attr} do you want? I found: ${options}.`,
    distinguishing_attr: dist.attr,
    tied_candidates: pool.map((l) => l.id ?? "?"),
  };
}
