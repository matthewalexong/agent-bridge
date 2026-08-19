// eval/search/lib/search-judge.mjs — the deterministic judgment layer for search.
// NO LLM involvement. The model transcribes listing attributes; this code does
// ALL constraint matching, unit normalization, and the stop/reformulate decision.
// Same extract-then-judge principle as eval/lib/judge.mjs.
//
// Input:  constraints (the user's parsed intent — fixed by the task, so the only
//         thing that can move the score is how well listings were transcribed)
//         listings    (the model's transcription of the search results page)
// Output: { action: "stop"|"reformulate", selected_listing: id|null,
//           matched_constraints, total_constraints, explanation }

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const norm = (s) => String(s ?? "").trim().toLowerCase();

// ---- Unit normalization (arithmetic lives HERE, never in the model) ------
// Gemma empirically cannot convert units on its own (proven on the protein
// corpus). Search results mix units: g/kg/lb/oz for package size, g/mg for
// protein per serving. Conversions are deterministic code.
export function normalizeWeightG(value, unit) {
  const n = num(value);
  if (n == null) return null;
  const u = norm(unit);
  if (!u || u === "g" || u === "grams" || u === "gram") return n;
  if (u === "kg" || u === "kilograms" || u === "kilogram") return n * 1000;
  if (u === "lb" || u === "lbs" || u === "pounds" || u === "pound") return Math.round(n * 453.592);
  if (u === "oz" || u === "ounces" || u === "ounce") return Math.round(n * 28.3495);
  return n; // unknown unit: take as grams
}

export function normalizeProteinG(value, unit) {
  const n = num(value);
  if (n == null) return null;
  const u = norm(unit);
  if (u === "mg" || u === "milligrams" || u === "milligram") return n / 1000;
  return n; // g or unstated
}

// Brand canonicalization: listings render brand names inconsistently
// ("Muscle Max", "MUSCLEMAX", "muscle-max"). Strip non-alphanumerics and
// lowercase before comparing — matching is still exact on the canonical form.
export function canonicalBrand(s) {
  return norm(s).replace(/[^a-z0-9]/g, "");
}

// ---- Pack/multipack parsing ------------------------------------------------
// The pack multiplier ("(Pack of N)", "N-pack", "bundle of N") sits in the
// listing's Size line — deterministic text, trivial to parse in code. Gemma
// empirically transcribes it unreliably (~50% at temp 0: folds it into
// size_value or drops it), so like every arithmetic/normalization step, it
// lives HERE. totalSizeG prefers the code-parsed pack from size_raw over any
// model-emitted pack_count.
export function extractPackCount(sizeRaw) {
  const s = norm(sizeRaw);
  let m = s.match(/\(\s*pack\s*of\s*(\d+)\s*\)/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/(\d+)\s*-?\s*pack\b/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/bundle\s*of\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Total package size in grams, accounting for multipacks: a "1KG (Pack of 2)"
// listing delivers 2000g total. Code-parsed pack (from size_raw) wins over any
// model-emitted pack_count; missing/absent pack means single unit.
export function totalSizeG(listing) {
  const perUnit = normalizeWeightG(listing.size_value, listing.size_unit);
  if (perUnit == null) return null;
  const fromRaw = extractPackCount(listing.size_raw);
  const pack = fromRaw ?? num(listing.pack_count);
  return perUnit * (pack != null && pack >= 1 ? pack : 1);
}

// ---- Constraint scoring ---------------------------------------------------
// Each constraint is { kind, value, unit? }. Kinds:
//   flavor    — case-insensitive substring on the listing's flavor text
//   size_g    — TOTAL package size, grams (per-unit size × pack_count, normalized)
//   protein_g — protein per serving, grams (listing side normalized first)
//   brand     — canonical brand match (case/space/hyphen insensitive)
function constraintMet(c, listing) {
  switch (c.kind) {
    case "flavor":
      return norm(listing.flavor).includes(norm(c.value));
    case "size_g": {
      const g = totalSizeG(listing);
      // 0.5% relative tolerance: round-tripped unit conversions (1 KG -> 1000g,
      // 2.2 LB -> 998g) must not flip decisions at kilogram scale.
      return g != null && Math.abs(g - c.value) <= Math.max(2, c.value * 0.005);
    }
    case "protein_g": {
      const g = normalizeProteinG(listing.protein_value, listing.protein_unit);
      return g != null && Math.abs(g - c.value) <= 0.5;
    }
    case "brand":
      return canonicalBrand(listing.brand) === canonicalBrand(c.value);
    default:
      return false;
  }
}

export function judgeSearch(constraints, listings) {
  const ls = Array.isArray(listings) ? listings : [];
  const total = constraints.length;

  // Score every listing against the constraints.
  const scored = ls.map((l, i) => {
    const met = constraints.map((c) => constraintMet(c, l));
    return {
      id: l.id ?? `listing-${i}`,
      metCount: met.filter(Boolean).length,
      full: met.every(Boolean) && met.length === total,
      inStock: norm(l.stock) !== "out of stock",
      sponsored: Boolean(l.sponsored),
      price: num(l.price_usd),
    };
  });

  // Decision rules, in priority order:
  // 1. In-stock FULL match exists → STOP. Prefer organic over sponsored twins;
  //    among equally-qualified matches prefer the CHEAPEST (unknown prices
  //    sort after known ones; price ties keep SERP order — stable sort).
  // 2. Full matches exist but ALL out of stock → REFORMULATE (the search as it
  //    stands cannot deliver the product; a different query or size/flavor is
  //    needed — the agent must not just declare failure).
  // 3. No full match at all → REFORMULATE.
  const fullInStock = scored.filter((s) => s.full && s.inStock);
  if (fullInStock.length) {
    const organic = fullInStock.filter((s) => !s.sponsored);
    const pool = organic.length ? organic : fullInStock;
    const pick = [...pool].sort((a, b) => {
      if (a.price == null && b.price == null) return 0;
      if (a.price == null) return 1;
      if (b.price == null) return -1;
      return a.price - b.price;
    })[0];
    const tiebroken = pool.length > 1 && pick.price != null;
    return {
      action: "stop",
      selected_listing: pick.id,
      matched_constraints: pick.metCount,
      total_constraints: total,
      explanation: tiebroken
        ? `Listing ${pick.id} satisfies all ${total} constraints and is the cheapest qualifying match ($${pick.price}).`
        : `Listing ${pick.id} satisfies all ${total} constraints${organic.length ? "" : " (sponsored, but the only in-stock full match)"} — search is enough.`,
    };
  }

  const bestPartial = scored.reduce((a, b) => (b.metCount > (a?.metCount ?? -1) ? b : a), null);
  const oosFull = scored.filter((s) => s.full && !s.inStock);
  return {
    action: "reformulate",
    selected_listing: null,
    // metCount semantics: the best constraint coverage ANY listing achieves,
    // stock-independent. An out-of-stock full match reports total_constraints
    // here while the action is still "reformulate" — the match exists, it just
    // cannot be bought. This is exactly what the oos-full-match task tests.
    matched_constraints: oosFull.length
      ? total
      : (bestPartial ? bestPartial.metCount : 0),
    total_constraints: total,
    explanation: oosFull.length
      ? `A full match exists but is out of stock; the search needs reformulation.`
      : `No listing satisfies all ${total} query constraints; reformulate the search.`,
  };
}
