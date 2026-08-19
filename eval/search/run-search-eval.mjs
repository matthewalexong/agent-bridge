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
import { judgeSearch, normalizeWeightG, normalizeProteinG } from "./lib/search-judge.mjs";

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
      max_tokens: 1600,
    }),
  });
  if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
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
      ["size_value", () => numEq(g.size_value, w.size_value)],
      ["size_unit", () => unitEq(g.size_unit, w.size_unit)],
      ["protein_value", () => numEq(g.protein_value, w.protein_value)],
      ["protein_unit", () => unitEq(g.protein_unit, w.protein_unit)],
      ["stock", () => textEq(g.stock, w.stock)],
      ["sponsored", () => Boolean(g.sponsored) === Boolean(w.sponsored)],
      // pack_count is optional on old-corpus listings; absent ≡ 1. Only scored
      // when the ground truth states it, and null/missing ≡ 1 as well.
      ...("pack_count" in w ? [["pack_count", () => numEq(g.pack_count ?? 1, w.pack_count)]] : []),
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
const taskFiles = fs.readdirSync(taskDir).filter((f) => f.endsWith(".json")).sort();
const results = [];
const medianOf = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

for (const f of taskFiles) {
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, f), "utf8"));
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
