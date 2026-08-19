// Blind frontier adjudication of the randomized search-eval corpus.
//
// PURPOSE: the ground truth in tasks-random/*.json is produced by our own judge
// code (search-judge.mjs). This script tests whether an independent frontier
// model, shown ONLY the query + constraints + snapshot (never the judge's
// verdict), arrives at the same decision. High agreement = judge policy
// externally validated. Disagreements are triaged: judge bug vs. generator
// ambiguity vs. frontier error.
//
// VOCABULARY BRIDGE: the judge emits action "stop" (= buy the selected listing)
// or "reformulate". The frontier is asked in plain language ("buy" / "reformulate")
// and its answer is mapped back onto the judge vocabulary before comparison.
// Listing identity: the judge selects by listing LETTER (A, B, ...); the frontier
// is given 0-based indexes and we convert.
//
// USAGE: node eval/search/adjudicate-random.mjs [--n 15] [--seed 7]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frontierCall } from "../../cascade/lib/frontier.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const taskDir = path.join(root, "tasks-random");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
}
const N = parseInt(arg("--n", "15"), 10);
const SEED = parseInt(arg("--seed", "7"), 10);

// Deterministic seeded shuffle (mulberry32).
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const files = fs.readdirSync(taskDir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
const tasks = files.map((f) => {
  const t = JSON.parse(fs.readFileSync(path.join(taskDir, f), "utf8"));
  t.__file = f;
  return t;
});

// Stratified sample: one of each scenario type first, then fill to N.
const byType = new Map();
// Scenario type lives in the filename: rand-N-<scenario>.json (there is no
// top-level `scenario` field). Parse it so stratification actually covers
// every scenario type instead of collapsing into one bucket.
for (const t of tasks) {
  const m = /rand-\d+-(.+)\.json$/.exec(t.__file ?? "");
  t.scenario = m ? m[1] : "unknown";
  const k = t.scenario;
  if (!byType.has(k)) byType.set(k, []);
  byType.get(k).push(t);
}
const r = rng(SEED);
const sample = [];
for (const list of byType.values()) sample.push(list[Math.floor(r() * list.length)]);
const remaining = tasks.filter((t) => !sample.includes(t)).sort(() => r() - 0.5);
while (sample.length < Math.min(N, tasks.length)) sample.push(remaining.pop());

console.log(`Adjudicating ${sample.length} tasks (${byType.size} scenario types), seed ${SEED}\n`);

// Human-readable constraint rendering. task.constraints are OBJECTS of shape
// { kind, value, unit? } — rendering them as strings was the bug that made the
// frontier judge blindfolded (it saw "[object Object]").
function describeConstraint(c) {
  if (typeof c === "string") return c;
  switch (c.kind) {
    case "flavor": return `flavor must be "${c.value}"`;
    case "size_g": return `package size ${c.value} g (total, not per-serving; multipacks count their TOTAL)`;
    case "protein_g": return `${c.value} g protein per serving`;
    case "brand": return `brand is "${c.value}"`;
    default: return JSON.stringify(c);
  }
}

const results = [];
for (const task of sample) {
  // Snapshot letters: [A], [B], ... — tell the frontier the listing letters so
  // its answer maps cleanly onto the judge's selected_listing letters.
  const prompt = `You are an expert e-commerce purchasing agent. A user asked:

"${task.query}"

Constraints (from the user):
${task.constraints.map((c) => `- ${describeConstraint(c)}`).join("\n")}

You ran a product search. Here is the COMPLETE result set — every listing the search returned, exactly as displayed:

${task.snapshot}

Decide what to do next. Choose ONE action:
- BUY: one listing is the best choice for the user's request.
- REFORMULATE: no listing satisfies all constraints, or the best candidate has a fatal problem (e.g. out of stock when nothing else matches), so the right move is to change the search rather than buy.

Reason carefully, checking each listing against each constraint. Unit conversions: 1 lb = 453.59 g, 1 oz = 28.35 g, 1 kg = 1000 g. When a size is given per serving for a multipack, multiply by the pack count to get total package size. Then output EXACTLY one line of JSON, no other text after it:
{"action":"buy","listing":"<letter, e.g. B>"}   or   {"action":"reformulate","listing":null}

Rules:
- If multiple listings satisfy everything, prefer genuine organic results over sponsored duplicates, then the lowest price, then the better-reviewed one.
- A listing that is out of stock can never be the BUY choice.
- Do not invent listings or attributes not present in the snapshot.`;

  let frontierVerdict = null;
  let raw = "";
  let ms = 0;
  let tokens = null;
  try {
    const t0 = Date.now();
    const resp = await frontierCall(
      [{ role: "user", content: prompt }],
      { maxTokens: 8000 }
    );
    ms = Date.now() - t0;
    raw = resp.text;
    tokens = resp.completionTokens;
    // Parse the LAST JSON-looking line from the response (code-first: no model needed).
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/\{.*"action".*\}/);
      if (m) {
        try { frontierVerdict = JSON.parse(m[0]); break; } catch {}
      }
    }
  } catch (e) {
    frontierVerdict = { action: "error", listing: null, error: String(e).slice(0, 200) };
  }

  // --- Map judge vocabulary onto the frontier's vocabulary -----------------
  // judge "stop" + selected_listing letter  ->  buy(letter)
  // judge "reformulate"                     ->  reformulate
  const gt = task.ground_truth;
  const expectedAction = gt.action === "stop" ? "buy" : "reformulate";
  const expectedListing = gt.selected_listing ?? null;

  const gotAction = frontierVerdict?.action;
  const gotListing = (gotAction === "buy" ? String(frontierVerdict?.listing ?? "") : null);

  const agreeAction = gotAction === expectedAction;
  const agreeListing = expectedAction !== "buy" || gotListing === expectedListing;
  const agree = agreeAction && agreeListing;

  results.push({
    id: task.id, scenario: task.scenario,
    expectedAction, expectedListing,
    gotAction, gotListing, agree, agreeAction, agreeListing, ms, outTokens: tokens,
    note: task.note,
    tail: raw.split("\n").slice(-3).join(" | ").slice(0, 400),
  });
  const mark = agree ? "✓" : "✗";
  const exp = expectedAction === "buy" ? `buy[${expectedListing}]` : expectedAction;
  const got = gotAction === "buy" ? `buy[${gotListing}]` : String(gotAction);
  console.log(`${mark} ${task.id} (${task.scenario}): judge=${exp} frontier=${got}  ${(ms / 1000).toFixed(1)}s`);
  if (!agree) {
    console.log(`    note: ${task.note}`);
    console.log(`    frontier tail: ${results[results.length - 1].tail}`);
  }
}

const agreed = results.filter((r) => r.agree).length;
const total = results.length;
console.log(`\n══════════════════════════════════════`);
console.log(`AGREEMENT: ${agreed}/${total} (${(100 * agreed / total).toFixed(1)}%)`);
const actionOnly = results.filter((r) => r.agreeAction).length;
console.log(`Action-only agreement: ${actionOnly}/${total} (${(100 * actionOnly / total).toFixed(1)}%)`);
console.log(`Disagreements: ${results.filter((r) => !r.agree).map((r) => r.id).join(", ") || "none"}`);
console.log(`══════════════════════════════════════`);

// Machine-readable detail for triage — one file per seed so runs never
// overwrite each other's evidence (a blind pass is worthless if only the
// last seed survives on disk).
const detailPath = path.join(root, `adjudication-results-seed${SEED}.json`);
fs.writeFileSync(detailPath, JSON.stringify({ seed: SEED, n: total, agreed, results }, null, 2));
console.log(`Detail written to ${path.relative(root, detailPath)}`);
