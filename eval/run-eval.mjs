#!/usr/bin/env node
// eval/run-eval.mjs — extract-then-judge pipeline (final architecture)
//
//   Gemma (local, free) extracts raw FACTS from the page snapshot.
//   judge.mjs (pure code, free) derives economics + the misleading verdict.
//   The deterministic scorer compares the full answer to ground truth.
//
// The model is NEVER asked to judge. Judgment lives entirely in code.
// So the ONLY lever that can move the score is the extraction skill file.
//
// Usage:  node eval/run-eval.mjs [--skill path] [--task id] [--model name]
//
// THE RULE: the scorer, ground truth, and judge are the exam. Only the skill
// file may change to raise the score.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge } from "./lib/judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENDPOINT = process.env.EVAL_LLM_ENDPOINT || "http://127.0.0.1:8080/v1";
const MODEL = process.env.EVAL_LLM_MODEL || "gemma-4-E2B-it";
const TEMPERATURE = process.env.EVAL_LLM_TEMPERATURE !== undefined ? parseFloat(process.env.EVAL_LLM_TEMPERATURE) : 0;
const SEED = process.env.EVAL_LLM_SEED !== undefined ? parseInt(process.env.EVAL_LLM_SEED, 10) : undefined;

// ---- arg parsing --------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const skillPath = arg("--skill", path.join(__dirname, "skills", "extract-facts-v1.md"));
const recordedSkillPath = path.relative(path.dirname(__dirname), path.resolve(skillPath)).split(path.sep).join("/");

// ---- load inputs --------------------------------------------------------
const skillText = fs.readFileSync(skillPath, "utf8");
const tasksDir = path.join(__dirname, "tasks");
let taskFiles = fs.readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
const taskArg = arg("--task", null);
if (taskArg) {
  taskFiles = taskFiles.filter(
    (f) => f.includes(taskArg) || f === taskArg || f === taskArg + ".json"
  );
}
if (taskFiles.length === 0) {
  console.error(`No task files matched (taskArg=${taskArg})`);
  process.exit(2);
}

// ---- llm call -----------------------------------------------------------
async function ask(prompt) {
  const t0 = Date.now();
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: TEMPERATURE,
      ...(SEED !== undefined ? { seed: SEED } : {}),
      max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content ?? "";
  return { text, ms: Date.now() - t0, tokens: j.usage?.total_tokens ?? 0 };
}

// ---- tolerant JSON extraction -------------------------------------------
function extractJson(text) {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---- scoring with partial credit ----------------------------------------
function scoreNumeric(answered, expected, tolerancePct) {
  if (typeof answered !== "number" || !isFinite(answered)) return 0;
  if (expected === 0) return answered === 0 ? 1 : 0;
  const relErr = Math.abs(answered - expected) / Math.abs(expected);
  if (relErr <= tolerancePct / 100 + 1e-9) return 1;
  const credit = Math.max(0, 1 - (relErr - tolerancePct / 100) / (3 * (tolerancePct / 100 || 0.05)));
  return credit;
}

// Which fields the MODEL is responsible for (extraction) vs what CODE derives.
const FACT_FIELDS = new Set([
  "price_usd", "headline_protein_g", "protein_per_scoop_g",
  "scoops_per_serving", "servings_per_container", "net_weight_g",
]);

function scoreTask(answer, task) {
  const gt = task.ground_truth;
  const { weights, tolerance_pct } = task.scoring;
  const fields = Object.keys(weights);
  const perField = {};
  let total = 0;

  for (const field of fields) {
    const w = weights[field];
    let credit = 0;
    let source; // "model" or "code" — where the value came from
    if (field === "misleading_claim") {
      credit = answer[field] === gt[field] ? 1 : 0;
      source = "code";
    } else {
      credit = scoreNumeric(answer[field], gt[field], tolerance_pct[field] ?? 0.02);
      source = FACT_FIELDS.has(field) ? "model" : "code";
    }
    perField[field] = {
      credit: Math.round(credit * 100) / 100,
      weighted: Math.round(credit * w * 1000) / 1000,
      expected: gt[field], got: answer[field], source,
    };
    total += credit * w;
  }

  const exp = String(answer.explanation ?? "").toLowerCase();
  const keywords = gt.required_explanation_keywords ?? [];
  const missing = keywords.filter((k) => !exp.includes(String(k).toLowerCase()));

  return { total: Math.round(total * 1000) / 1000, perField, missing_keywords: missing };
}

// ---- main ---------------------------------------------------------------
async function main() {
  console.log(`Endpoint: ${ENDPOINT}  Model: ${MODEL}  temp=${TEMPERATURE}`);
  console.log(`Skill: ${skillPath}\n`);

  const results = [];
  for (const file of taskFiles) {
    const task = JSON.parse(fs.readFileSync(path.join(tasksDir, file), "utf8"));
    const prompt = `${skillText}\n\n## Product page snapshot\n\n${task.snapshot}\n`;
    let entry = { task: task.id, file };
    try {
      const { text, ms, tokens } = await ask(prompt);
      const facts = extractJson(text);
      entry.ms = ms;
      entry.tokens = tokens;
      if (!facts) {
        entry.error = "UNPARSEABLE_FACTS";
        entry.score = 0;
        entry.raw = text.slice(0, 400);
      } else {
        // THE JUDGMENT LAYER — deterministic code, not the model
        const derived = judge(facts);
        const answer = { ...facts, ...derived };
        entry.facts = facts;
        entry.derived = derived;
        entry.score = scoreTask(answer, task);
        entry.answer = answer;
      }
    } catch (e) {
      entry.error = String(e);
      entry.score = 0;
    }
    results.push(entry);

    // print per-task report
    console.log(`━━━ ${task.id} ━━━`);
    if (entry.error) {
      console.log(`  ERROR: ${entry.error}`);
      if (entry.raw) console.log(`  raw: ${entry.raw.slice(0, 200)}`);
    } else {
      console.log(`  TOTAL SCORE: ${(entry.score.total * 100).toFixed(1)}%  (${entry.ms}ms, ${entry.tokens} tok)`);
      for (const [f, d] of Object.entries(entry.score.perField)) {
        const mark = d.credit >= 1 ? "✓" : d.credit > 0 ? "~" : "✗";
        const src = d.source === "model" ? "M" : "C";
        console.log(`    ${mark} [${src}] ${f}: credit=${d.credit} (expected ${d.expected}, got ${d.got})`);
      }
      if (entry.score.missing_keywords.length) {
        console.log(`    ⚠ explanation missing keywords: ${entry.score.missing_keywords.join(", ")}`);
      }
      console.log(`    explanation: ${String(entry.answer.explanation ?? "").slice(0, 150)}`);
    }
    console.log();
  }

  const overall = results.reduce((s, r) => s + (r.score?.total ?? 0), 0) / results.length;
  console.log(`═══ OVERALL: ${(overall * 100).toFixed(1)}% across ${results.length} task(s) ═══`);

  const resultsDir = path.join(__dirname, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(resultsDir, `${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), skillPath: recordedSkillPath, model: MODEL, overall, results }, null, 2));
  console.log(`saved: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
