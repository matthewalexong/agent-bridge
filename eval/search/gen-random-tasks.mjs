#!/usr/bin/env node
// eval/search/gen-random-tasks.mjs — procedural randomized stress-corpus generator.
//
// Why this exists: the hand-crafted ./tasks fixtures prove the skill works on
// cases WE thought of. This generator produces tasks nobody hand-wrote, so the
// skill is graded on what a real user might throw at it. Ground truth is NOT
// eyeballed — it is COMPUTED by running the same deterministic judge
// (lib/search-judge.mjs) over the generated listings, so every expected verdict
// is oracle-consistent with the judge. The skill's job is to transcribe well
// enough that the judge reproduces that verdict.
//
// Usage: node eval/search/gen-random-tasks.mjs [--seed 42] [--count 40] [--out tasks-random]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeSearch } from "./lib/search-judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const SEED = parseInt(argVal("--seed", "1337"), 10);
const COUNT = parseInt(argVal("--count", "40"), 10);
const OUT = path.resolve(__dirname, argVal("--out", "tasks-random"));

// ---- Seeded RNG (mulberry32) so corpora are reproducible ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;

// ---- Vocabulary ----
const BRANDS = ["NutriGain", "CoreFuel", "MuscleMax", "ProLean", "IronPeak", "VitaForge", "PeakWhey", "TrueGain"];
const FLAVORS = ["Vanilla", "Chocolate", "Strawberry", "Cookies & Cream", "Unflavored", "Banana", "Mocha", "Salted Caramel"];
const PRODUCTS = ["Whey Protein", "Whey Isolate", "Casein Protein", "Plant Protein", "Mass Gainer", "Protein Blend"];

// Weight units the skill + judge understand. value/unit are rendered into the
// Size line and normalized to grams by the judge.
const WEIGHT_UNITS = [
  { unit: "g", mult: 1 }, { unit: "KG", mult: 1000 },
  { unit: "LB", mult: 453.592 }, { unit: "oz", mult: 28.3495 },
];

// Render a per-unit size as a clean "2KG"/"500g"/"5LB" style string.
function renderSize(value, unit) { return `${value}${unit}`; }

let listingSeq = 0;
function makeId() { return String.fromCharCode(65 + (listingSeq++ % 26)); }

// Build one listing with full ground-truth fields + the snapshot field lines.
// opts controls which fields are present (to stress missing-field handling).
function makeListing(o) {
  const id = makeId();
  const brand = o.brand;
  const flavor = o.flavor;
  const sizeRaw = o.sizeRaw;            // e.g. "2KG", "500g (Pack of 2)"
  const sizeValue = o.sizeValue;        // numeric per-unit value
  const sizeUnit = o.sizeUnit;          // "g"|"KG"|"LB"|"oz"
  const proteinValue = o.proteinValue ?? null;
  const proteinUnit = o.proteinUnit ?? (proteinValue == null ? "" : "g");
  const priceUsd = o.priceUsd ?? null;
  const reviewCount = o.reviewCount ?? null;
  const stock = o.stock ?? "in stock";
  const sponsored = o.sponsored ?? false;
  const packCount = o.packCount ?? null;

  const gt = { id, brand, flavor, size_raw: sizeRaw, size_value: sizeValue, size_unit: sizeUnit,
    protein_value: proteinValue, protein_unit: proteinUnit, stock, sponsored };
  if (packCount != null) gt.pack_count = packCount;
  if (priceUsd != null) gt.price_usd = priceUsd;
  if (reviewCount != null) { gt.reviews_raw = `${reviewCount.toLocaleString("en-US")}`; gt.review_count = reviewCount; }

  // Snapshot field lines (mirrors fixture format exactly: 4-space indent).
  const lines = [];
  const titleParts = [brand, pick(PRODUCTS), flavor, sizeRaw.replace(/\s*\(.*\)/, "")];
  lines.push(`[${id}] Title: ${titleParts.join(" ")}`);
  if (o.omit?.includes("brand")) { /* omit Brand line */ } else lines.push(`    Brand: ${brand}`);
  lines.push(`    Flavor: ${flavor}`);
  lines.push(`    Size: ${sizeRaw}`);
  if (proteinValue != null) lines.push(`    Protein per serving: ${proteinValue}${proteinUnit}`);
  if (priceUsd != null) lines.push(`    Price: $${priceUsd.toFixed(2)}`);
  if (reviewCount != null) lines.push(`    Reviews: ${reviewCount.toLocaleString("en-US")}`);
  lines.push(`    Stock: ${stock}`);
  lines.push(`    Sponsored: ${sponsored ? "yes" : "no"}`);

  return { gt, block: lines.join("\n") };
}

// Random per-unit weight as { value, unit, grams }.
function randWeight() {
  const u = pick(WEIGHT_UNITS);
  // values that render cleanly: g 250..2000, KG 1..3, LB 1..10, oz 8..64
  let value;
  if (u.unit === "g") value = pick([250, 500, 750, 908, 1000, 1500, 2000]);
  else if (u.unit === "KG") value = pick([1, 2, 3]);
  else if (u.unit === "LB") value = pick([1, 2, 5, 10]);
  else value = pick([8, 16, 32, 64]);
  const grams = Math.round(value * u.mult);
  return { value, unit: u.unit, grams };
}

// ---- Scenario builders: each returns { constraints, listings, note } --------
// Every builder guarantees its intended verdict BY CONSTRUCTION, then the
// verdict is re-derived from the judge (never hand-written).

function scUniqueMatch() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const target = randWeight();
  const protein = ri(20, 30);
  const full = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: 30 + ri(0, 30), reviewCount: ri(50, 5000), stock: "in stock", sponsored: false });
  // Distractors: same brand+flavor but wrong size and wrong protein.
  const d1w = randWeight();
  const d1 = makeListing({ brand, flavor, sizeRaw: renderSize(d1w.value, d1w.unit),
    sizeValue: d1w.value, sizeUnit: d1w.unit, proteinValue: protein,
    priceUsd: 28 + ri(0, 30), reviewCount: ri(50, 5000) });
  const d2 = makeListing({ brand, flavor: pick(FLAVORS), sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: 28 + ri(0, 30), reviewCount: ri(50, 5000) });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: target.grams },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [full, d1, d2],
    note: "Exactly one listing satisfies all constraints; the others each fail one." };
}

function scTiebreakPrice() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const target = randWeight(); const protein = ri(20, 30);
  const cheap = 25 + ri(0, 15); const dear = cheap + 3 + ri(0, 10);
  const a = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: dear, reviewCount: ri(100, 5000), sponsored: false });
  const b = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: cheap, reviewCount: ri(100, 5000), sponsored: false });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: target.grams },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [a, b],
    note: "Two organic full matches at different prices — judge must pick the cheaper (position-bias trap)." };
}

function scTiebreakReviews() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const target = randWeight(); const protein = ri(20, 30);
  const price = 30 + ri(0, 20);
  const lo = ri(100, 900); const hi = lo + 500 + ri(0, 3000);
  const a = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: price, reviewCount: lo, sponsored: false });
  const b = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: price, reviewCount: hi, sponsored: false });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: target.grams },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [a, b],
    note: "Two organic full matches at the SAME price — judge tie-breaks on higher review count." };
}

function scSponsoredPref() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const target = randWeight(); const protein = ri(20, 30);
  const price = 30 + ri(0, 20);
  const sponsored = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: price - 2, reviewCount: ri(1000, 9000), sponsored: true, stock: "in stock" });
  const organic = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: price, reviewCount: ri(100, 900), sponsored: false, stock: "in stock" });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: target.grams },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [sponsored, organic],
    note: "Sponsored match is cheaper+more reviewed, but an organic full match exists — judge prefers organic." };
}

function scNoMatch() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const target = randWeight(); const protein = ri(20, 30);
  // All listings miss at least one constraint (wrong flavor, wrong size, wrong protein).
  const d1 = makeListing({ brand, flavor: pick(FLAVORS), sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein, priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  const d2w = randWeight();
  const d2 = makeListing({ brand, flavor, sizeRaw: renderSize(d2w.value, d2w.unit),
    sizeValue: d2w.value, sizeUnit: d2w.unit, proteinValue: protein, priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  const d3 = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein + 10, priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: target.grams },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [d1, d2, d3],
    note: "No listing satisfies all constraints — correct answer is reformulate, no selection." };
}

function scOosFullMatch() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const target = randWeight(); const protein = ri(20, 30);
  const a = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000), stock: "out of stock", sponsored: false });
  const d1w = randWeight();
  const d1 = makeListing({ brand, flavor, sizeRaw: renderSize(d1w.value, d1w.unit),
    sizeValue: d1w.value, sizeUnit: d1w.unit, proteinValue: protein, priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: target.grams },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [a, d1],
    note: "A full match exists but is out of stock — action reformulate, matched_constraints reports the full count." };
}

function scMultipack() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const per = randWeight(); const pack = pick([2, 3, 4]); const protein = ri(20, 30);
  const totalG = per.grams * pack;
  // The multipack listing is the ONLY one whose TOTAL size hits the target.
  const multi = makeListing({ brand, flavor, sizeRaw: `${renderSize(per.value, per.unit)} (Pack of ${pack})`,
    sizeValue: per.value, sizeUnit: per.unit, proteinValue: protein, packCount: pack,
    priceUsd: 40 + ri(0, 40), reviewCount: ri(100, 5000) });
  // Single-unit listing at the per-unit size (total too small).
  const single = makeListing({ brand, flavor, sizeRaw: renderSize(per.value, per.unit),
    sizeValue: per.value, sizeUnit: per.unit, proteinValue: protein,
    priceUsd: 25 + ri(0, 20), reviewCount: ri(100, 5000) });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: totalG },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [single, multi],
    note: "Target size is only reachable via the multipack's TOTAL (per-unit x pack). Code parses pack from size_raw." };
}

function scUnitMix() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const protein = ri(20, 30);
  // Target expressed via one unit, the matching listing rendered in ANOTHER unit.
  const targetU = pick(WEIGHT_UNITS); const matchU = pick(WEIGHT_UNITS.filter(u => u.unit !== targetU.unit));
  // pick a gram target that renders cleanly in BOTH units to avoid tolerance issues
  const grams = pick([454, 907, 1000, 2000, 2268]);
  const tVal = Math.round((grams / targetU.mult) * 10) / 10;
  const mVal = Math.round((grams / matchU.mult) * 10) / 10;
  const match = makeListing({ brand, flavor, sizeRaw: renderSize(mVal, matchU.unit),
    sizeValue: mVal, sizeUnit: matchU.unit, proteinValue: protein,
    priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  const d1 = makeListing({ brand, flavor, sizeRaw: renderSize(mVal + 1, matchU.unit),
    sizeValue: mVal + 1, sizeUnit: matchU.unit, proteinValue: protein, priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: grams },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [d1, match],
    note: "The match is expressed in a different unit than a near-miss — judge must normalize units before comparing." };
}

function scProteinMg() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const target = randWeight(); const proteinG = ri(20, 30);
  // Match renders protein in MILLIGRAMS (e.g. 24000mg = 24g); distractor in g.
  const match = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: proteinG * 1000, proteinUnit: "mg",
    priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  const d1 = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: proteinG, proteinUnit: "g",
    priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: target.grams },
    { kind: "protein_g", value: proteinG },
    { kind: "brand", value: brand },
  ];
  // BOTH normalize to proteinG — to keep a unique winner make the distractor wrong elsewhere.
  const d2 = makeListing({ brand, flavor: pick(FLAVORS), sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: proteinG, proteinUnit: "g",
    priceUsd: 30 + ri(0, 20), reviewCount: ri(100, 5000) });
  return { constraints, listings: [match, d2, d1],
    note: "Match lists protein in mg; judge normalizes mg->g. Note both match and d1 normalize equal, so price/reviews tie-break applies." };
}

function scMissingReviews() {
  const brand = pick(BRANDS), flavor = pick(FLAVORS);
  const target = randWeight(); const protein = ri(20, 30);
  const price = 30 + ri(0, 20);
  // One full match HAS reviews, the other has none. Known beats unknown.
  const withReviews = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: price, reviewCount: ri(100, 5000), sponsored: false });
  const noReviews = makeListing({ brand, flavor, sizeRaw: renderSize(target.value, target.unit),
    sizeValue: target.value, sizeUnit: target.unit, proteinValue: protein,
    priceUsd: price, reviewCount: null, sponsored: false });
  const constraints = [
    { kind: "flavor", value: flavor.toLowerCase() },
    { kind: "size_g", value: target.grams },
    { kind: "protein_g", value: protein },
    { kind: "brand", value: brand },
  ];
  return { constraints, listings: [noReviews, withReviews],
    note: "Same-price tie where one listing has no Reviews line — the listing WITH evidence must win." };
}

const BUILDERS = [
  { key: "unique-match", fn: scUniqueMatch },
  { key: "tiebreak-price", fn: scTiebreakPrice },
  { key: "tiebreak-reviews", fn: scTiebreakReviews },
  { key: "sponsored-pref", fn: scSponsoredPref },
  { key: "no-match", fn: scNoMatch },
  { key: "oos-full-match", fn: scOosFullMatch },
  { key: "multipack", fn: scMultipack },
  { key: "unit-mix", fn: scUnitMix },
  { key: "protein-mg", fn: scProteinMg },
  { key: "missing-reviews", fn: scMissingReviews },
];

// ---- Generate, derive ground truth from the judge, and SELF-VERIFY ---------
fs.mkdirSync(OUT, { recursive: true });
const manifest = [];
let made = 0, guard = 0;
// Guarantee coverage: at least 2 of each scenario, then fill the rest randomly.
const queue = [];
for (const b of BUILDERS) { queue.push(b, b); }
while (queue.length < COUNT) queue.push(pick(BUILDERS));

for (const b of queue.slice(0, COUNT)) {
  guard++;
  listingSeq = 0; // reset ids per task
  const { constraints, listings, note } = b.fn();
  const gts = listings.map((l) => l.gt);
  // Oracle-consistent verdict: what the judge says on a PERFECT transcription.
  const verdict = judgeSearch(constraints, gts);
  // Build the query string ONCE. buildQuery() calls pick() internally, so calling
  // it twice yields two different random products (snapshot vs top-level query).
  const queryStr = buildQuery(constraints);
  const snapshot = "=== SEARCH QUERY ===\n" + queryStr +
    "\n\n=== RESULTS ===\n" + listings.map((l) => l.block).join("\n\n");
  const id = `rand-${made + 1}-${b.key}`;
  const task = {
    id,
    note: `RANDOMIZED (${b.key}, seed ${SEED}): ${note}`,
    query: queryStr,
    constraints,
    snapshot,
    ground_truth_listings: gts,
    ground_truth: verdict,
    scoring: { weights: { action: 0.45, selected_listing: 0.35, matched_constraints: 0.05, transcription: 0.15 } },
    explanation: note,
  };
  // Self-verify: re-run the judge on the stored listings and assert equality.
  const recheck = judgeSearch(constraints, task.ground_truth_listings);
  if (JSON.stringify(recheck) !== JSON.stringify(verdict)) {
    console.error(`!! self-verify FAILED for ${id} — skipping`);
    continue;
  }
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(task, null, 2));
  manifest.push({ id, scenario: b.key, action: verdict.action, selected: verdict.selected_listing });
  made++;
}

function buildQuery(constraints) {
  const bits = [];
  for (const c of constraints) {
    if (c.kind === "flavor") bits.push(c.value);
    if (c.kind === "brand") bits.push(c.value);
    if (c.kind === "size_g") bits.push(`${c.value}g`);
    if (c.kind === "protein_g") bits.push(`${c.value}g protein`);
  }
  return `${pick(PRODUCTS)} ${bits.join(" ")}`;
}

fs.writeFileSync(path.join(OUT, "_manifest.json"), JSON.stringify({ seed: SEED, count: made, generated: new Date().toISOString(), tasks: manifest }, null, 2));
console.log(`Generated ${made} randomized tasks (seed=${SEED}) into ${path.relative(__dirname, OUT)}/`);
console.log(`By scenario: ${JSON.stringify(manifest.reduce((a, m) => (a[m.scenario] = (a[m.scenario] || 0) + 1, a), {}))}`);
console.log(`Verdicts: stop=${manifest.filter(m => m.action === "stop").length} reformulate=${manifest.filter(m => m.action === "reformulate").length}`);
