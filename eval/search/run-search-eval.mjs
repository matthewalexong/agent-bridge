#!/usr/bin/env node
// eval/search/run-search-eval.mjs — extract-then-judge pipeline for search skills.
//
//   Gemma (local, free) TRANSCRIBES listings from a SERP snapshot.
//   lib/search-judge.mjs (pure code) does ALL constraint matching, unit
//   normalization, and the stop/reformulate decision.
//
// Same architecture as eval/run-eval.mjs — the only knob is the skill markdown.
// Usage: node eval/search/run-search-eval.mjs [--skill path/to/skill.md]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeSearch, normalizeWeightG, normalizeProteinG, extractReviewCount } from "./lib/search-judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const skillArg = args.includes("--skill") ? args[args.indexOf("--skill") + 1] : null;
const skillPath = skillArg
  ? path.resolve(skillArg)
  : path.join(__dirname, "skills", "search-transcribe-v1.md");
const SKILL = fs.readFileSync(skillPath, "utf8");
const TEMP = parseFloat(process.env.EVAL_LLM_TEMPERATURE ?? "0");
// REPEATS: Gemma's outputs vary run-to-run even at temperature 0 (GPU
// nondeterminism / sampling). A single pass can fluke — the verifier once
// recorded 100% on a run whose three successors scored 93.7%. With RUNS > 1
// each task is measured N times and scored by the MEDIAN task score, so the
// reported OVERALL reflects the skill's typical behavior, not a lucky draw.
const RUNS = Math.max(1, parseInt(process.env.EVAL_RUNS ?? "1", 10));

// ---- Local model client (llama.cpp OpenAI-compatible endpoint) ----
const URL_ = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1/chat/completions";
const MODEL = process.env.LOCAL_LLM_MODEL || "gemma-4-e2b";

async function localAsk(prompt) {
  // Bounded retry with backoff: on a single-GPU box a request can fail when
  // another client contends on the server (or the server hiccups). Without
  // retry, a transient fetch failure scores the task 0 — and inside the
  // cascade loop that reads as "skill regressed", burning a repair cycle
  // chasing a server blip. Retry transient errors; let true failures throw.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SKILL },
            { role: "user", content: prompt },
          ],
          temperature: TEMP,
          // Output cap: 12 listings x 13 fields runs ~1900+ tokens of JSON. The
          // old 1600 cap truncated long SERPs mid-object (Round 3: long-serp-
          // attention 0%, "no listings array parsed") — a harness bug, not model
          // failure. Gemma serves 4K comfortably; keep headroom for growth.
          max_tokens: 4096,
        }),
      });
      if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
      const data = await res.json();
      return data.choices[0].message.content;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---- Extract the model's JSON (fenced, bare, or embedded) ----
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }
  return null;
}

// ---- Transcription scoring (deterministic field comparison) ----
const normS = (s) => String(s ?? "").trim().toLowerCase();
const isMissing = (v) => v === null || v === undefined || v === "";
const numEq = (a, b, tol = 0.01) =>
  isMissing(a) && isMissing(b)
    ? true // both missing = both transcribed correctly as absent
    : typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const unitEq = (a, b) => normS(a).replace(/s$/, "") === normS(b).replace(/s$/, "");
// Missing text encodings are interchangeable: "" and null both mean "not stated".
// (Ground truth uses "" for a missing unit when the sibling value is null; the
// model may equally write null — both are correct transcriptions.)
const textEq = (a, b) => normS(a) === normS(b);
// Semantic size equality: compare normalized per-unit grams (unit-agnostic),
// matching how the judge consumes the fields. Both-missing is a match.
const sizeEq = (g, w) => {
  const gg = normalizeWeightG(g.size_value, g.size_unit);
  const ww = normalizeWeightG(w.size_value, w.size_unit);
  if (gg == null && ww == null) return true;
  if (gg == null || ww == null) return false;
  return Math.abs(gg - ww) <= Math.max(2, ww * 0.005);
};
// size_raw is compared SEMANTICALLY, not as raw strings: its only load-bearing
// content is (a) the size number+unit and (b) the pack note — code parses the
// pack multiplier out of it. Gemma may spell units out ("grams" vs "g") or
// dictate the "Size:" label; none of that changes what the parser extracts.
const sizeRawEq = (a, b) => {
  const canon = (s) => {
    let x = normS(s).replace(/^size:\s*/, "");
    x = x.replace(/\b(pack\s+of)\b/g, "pack").replace(/[()]/g, " ");
    // Canonical unit spellings, INCLUDING units attached to the number ("2000g").
    x = x.replace(/(\d)\s*(kilograms?|kg)\b/g, "$1 kg").replace(/(\d)\s*(pounds?|lbs?)\b/g, "$1 lb");
    x = x.replace(/(\d)\s*(ounces?|oz)\b/g, "$1 oz").replace(/(\d)\s*(grams?|g)\b/g, "$1 g");
    return x.replace(/\s+/g, " ").trim();
  };
  return canon(a) === canon(b);
};

function scoreTranscription(got, want) {
  // want = ground_truth_listings (authoritative). Compare listing-by-listing by id.
  // Returns { fraction, fieldFailures } — fieldFailures names the EXACT field and
  // values, so the improvement loop's feedback points at the precise gap.
  const gotById = new Map((Array.isArray(got) ? got : []).map((l) => [String(l?.id ?? "").toUpperCase(), l]));
  let total = 0, ok = 0;
  const fieldFailures = [];
  for (const w of want) {
    const g = gotById.get(String(w.id).toUpperCase()) || {};
    const fields = [
      ["brand", () => textEq(g.brand, w.brand)],
      ["flavor", () => textEq(g.flavor, w.flavor)],
      // size_value+size_unit are scored SEMANTICALLY (total grams), never
      // verbatim: the judge normalizes units before matching, so "1KG" and
      // "1000g" are the same fact — Gemma normalizes eagerly and reliably
      // (it cannot reliably be told NOT to). The verbatim source of truth is
      // size_raw, which is scored separately.
      ["size_value", () => sizeEq(g, w)],
      ["size_unit", () => true], // covered by size_value's semantic check
      ["protein_value", () => numEq(g.protein_value, w.protein_value)],
      ["protein_unit", () => unitEq(g.protein_unit, w.protein_unit)],
      ["stock", () => textEq(g.stock, w.stock)],
      ["sponsored", () => Boolean(g.sponsored) === Boolean(w.sponsored)],
      // size_raw is the LOAD-BEARING field: the judge parses pack multipliers
      // out of it in code (Gemma transcribes pack_count unreliably ~50% of the
      // time). Verbatim dictation is what the architecture depends on.
      ...("size_raw" in w ? [["size_raw", () => sizeRawEq(g.size_raw, w.size_raw)]] : []),
      // reviews_raw is the LOAD-BEARING reviews field (mirror of size_raw): the
      // judge parses the review number out of it in code, because Gemma
      // transcribes review_count unreliably (selective attention). Verbatim
      // dictation of the "Reviews:" line is what the architecture depends on.
      ...("reviews_raw" in w ? [["reviews_raw", () => {
        // Semantic compare on the parsed number, like sizeRawEq: a copied
        // "Reviews:" prefix or thousands comma must not fail the field.
        return extractReviewCount(g.reviews_raw) === extractReviewCount(w.reviews_raw);
      }]] : []),
      // price_usd is scored only on tasks whose ground truth states it (older
      // corpus tasks predate it). The judge uses it to tie-break between
      // equally-qualifying matches, so a missing/wrong price can flip picks.
      ...("price_usd" in w ? [["price_usd", () => numEq(g.price_usd, w.price_usd)]] : []),
      // review_count is scored via the same code-parsed path the judge uses:
      // the model's verbatim reviews_raw (or, failing that, its review_count)
      // must parse to the expected number. Comma-formatted counts ("2,310")
      // and a copied "Reviews:" prefix are both fine — only the digits matter.
      // Absent Reviews line must stay null: a fabricated count fails here.
      ...("review_count" in w ? [["review_count", () => {
        const got = extractReviewCount(g.reviews_raw) ?? extractReviewCount(g.review_count) ?? (typeof g.review_count === "number" && isFinite(g.review_count) ? g.review_count : null);
        const want = extractReviewCount(w.review_count) ?? w.review_count;
        return got === want; // null === null passes; any mismatch fails
      }]] : []),
      // pack_count is NOT scored: it is a best-effort fallback for the judge.
      // The code-parsed pack from size_raw wins, so demanding pack_count from
      // the model would penalize the correct architecture.
    ];
    for (const [name, check] of fields) {
      total++;
      const pass = check();
      if (pass) ok++;
      else fieldFailures.push(`listing ${w.id} field ${name}: got ${JSON.stringify(g[name] ?? null)}, expected ${JSON.stringify(w[name])}`);
    }
  }
  return { fraction: total ? ok / total : 0, fieldFailures };
}

// ---- Per-task scoring: weighted verdict components ----
function scoreTask(verdict, gt, t) {
  // t = { fraction, fieldFailures } from scoreTranscription
  const w = { action: 0.45, selected_listing: 0.35, matched_constraints: 0.05, transcription: 0.15 };
  const failures = [];
  const parts = [];

  const actionOk = verdict.action === gt.action;
  parts.push(w.action * (actionOk ? 1 : 0));
  if (!actionOk) failures.push(`action expected ${gt.action} got ${verdict.action}`);

  const selOk = verdict.selected_listing === gt.selected_listing;
  parts.push(w.selected_listing * (selOk ? 1 : 0));
  if (!selOk) failures.push(`selected_listing expected ${gt.selected_listing} got ${verdict.selected_listing}`);

  const metFrac = gt.total_constraints
    ? 1 - Math.abs(verdict.matched_constraints - gt.matched_constraints) / gt.total_constraints
    : 1;
  parts.push(w.matched_constraints * Math.max(0, metFrac));
  if (verdict.matched_constraints !== gt.matched_constraints)
    failures.push(`matched_constraints expected ${gt.matched_constraints} got ${verdict.matched_constraints}`);

  parts.push(w.transcription * t.fraction);
  if (t.fraction < 0.999) {
    failures.push(`transcription ${(t.fraction * 100).toFixed(0)}% of listing fields correct`);
    failures.push(...t.fieldFailures.slice(0, 6));
  }

  return { total: parts.reduce((a, b) => a + b, 0), failures };
}

// ---- Main ----
const taskDir = path.join(__dirname, "tasks");
// Optional --only id1,id2 filter for fast iteration on a subset of tasks
// (e.g. debugging long-serp-attention without re-running the full corpus).
const onlyArg = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const onlyIds = onlyArg ? onlyArg.split(",").map((s) => s.trim()).filter(Boolean) : null;
const taskFiles = fs.readdirSync(taskDir).filter((f) => f.endsWith(".json")).sort();
const results = [];
const medianOf = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

for (const f of taskFiles) {
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, f), "utf8"));
  if (onlyIds && !onlyIds.includes(task.id)) continue;
  const t0 = Date.now();
  console.log(`━━━ ${task.id} ━━━`);
  try {
    const prompt = `Query: ${task.query}\n\n${task.snapshot}`;
    // N measured runs; the task's score is the MEDIAN (robust to flukes).
    // Failures shown come from the WORST run (most informative for the loop).
    const runs = [];
    for (let r = 0; r < RUNS; r++) {
      const raw = await localAsk(prompt);
      const parsed = extractJson(raw);
      const listings = parsed?.listings ?? parsed;
      const tResult = Array.isArray(listings)
        ? scoreTranscription(listings, task.ground_truth_listings)
        : { fraction: 0, fieldFailures: ["no listings array parsed from model output"] };
      // The judge receives the MODEL'S transcription — a bad transcription
      // propagates into a wrong verdict, exactly as it would in production.
      const verdict = judgeSearch(task.constraints, Array.isArray(listings) ? listings : []);
      const score = scoreTask(verdict, task.ground_truth, tResult);
      runs.push({ score: score.total, failures: score.failures, verdict, transcription: tResult.fraction });
    }
    const taskScore = medianOf(runs.map((r) => r.score));
    const worst = runs.reduce((a, b) => (b.score < a.score ? b : a));
    results.push({ task: task.id, score: taskScore, failures: worst.failures, verdict: worst.verdict, transcription: worst.transcription, runs: RUNS });
    const ms = Date.now() - t0;
    const spread = runs.length > 1 ? ` [runs: ${runs.map((r) => (r.score * 100).toFixed(0)).join("/")}]` : "";
    console.log(`  TOTAL SCORE: ${(taskScore * 100).toFixed(1)}%${spread}  (${ms}ms)`);
    for (const fl of worst.failures) console.log(`  ✗ ${fl}`);
  } catch (e) {
    results.push({ task: task.id, score: 0, failures: [`ERROR: ${e.message}`], verdict: null, transcription: 0, runs: RUNS });
    console.log(`  ERROR: ${e.message}`);
  }
}

const overall = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
console.log(`═══ OVERALL: ${(overall * 100).toFixed(1)}% across ${results.length} task(s) ═══`);

// Write results for inspection
const outDir = path.join(__dirname, "results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  JSON.stringify({ when: new Date().toISOString(), skill: path.basename(skillPath), temperature: TEMP, overall, results }, null, 2)
);
process.exit(overall >= 0.98 ? 0 : 1);
