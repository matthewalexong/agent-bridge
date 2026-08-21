#!/usr/bin/env node
// eval/search/run-sentiment-eval.mjs — subjective-attribute search eval.
//
// The model's job (reasoning, trained via the skill):
//   1. Decide whether the query is OBJECTIVE (answerable from labels: price,
//      size, nutrition) or SUBJECTIVE (only answerable from reviews/sentiment:
//      durability, comfort, longevity, "built to last", ...).
//   2. If subjective: classify each candidate's reviews for THAT attribute and
//      cite evidence. If objective: answer from labels WITHOUT citing reviews.
// Code judges everything deterministically (lib/sentiment-judge.mjs).
//
// Usage: node eval/search/run-sentiment-eval.mjs [--skill path/to/skill.md]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gradeTask } from "./lib/sentiment-judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const skillArg = args.includes("--skill") ? args[args.indexOf("--skill") + 1] : null;
const skillPath = skillArg
  ? path.resolve(skillArg)
  : path.join(__dirname, "skills", "sentiment-routing-v1.md");
const SKILL = fs.readFileSync(skillPath, "utf8");
const TEMP = parseFloat(process.env.EVAL_LLM_TEMPERATURE ?? "0");
const RUNS = Math.max(1, parseInt(process.env.EVAL_RUNS ?? "1", 10));

const URL_ = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1/chat/completions";
const MODEL = process.env.LOCAL_LLM_MODEL || "gemma-4-e2b";

async function localAsk(prompt) {
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
          max_tokens: 600,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error("empty completion");
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function formatPrompt(task) {
  const lines = task.candidates.map((c) => {
    const bits = [`[${c.id}] ${c.title}`];
    if (c.price_usd != null) bits.push(`Price: $${c.price_usd.toFixed(2)}`);
    if (c.size_value != null) bits.push(`Size: ${c.size_value}${c.size_unit ?? "g"}`);
    if (c.protein_per_serving_g != null) bits.push(`Protein/serving: ${c.protein_per_serving_g}g`);
    if (Array.isArray(c.reviews) && c.reviews.length) {
      bits.push(`Reviews:\n${c.reviews.map((r) => `  - ${r}`).join("\n")}`);
    } else {
      bits.push(`Reviews: (none available)`);
    }
    return bits.join("\n");
  });
  return [
    `=== USER QUERY ===`,
    task.query,
    ``,
    `=== CANDIDATE LISTINGS ===`,
    ...lines,
  ].join("\n");
}

async function runTask(task) {
  const runScores = [];
  const details = [];
  for (let r = 0; r < RUNS; r++) {
    let verdict;
    try {
      const out = await localAsk(formatPrompt(task));
      const parsed = parseJson(out);
      verdict = parsed ? gradeTask(task, parsed) : { score: 0, reason: "no JSON parsed" };
    } catch (e) {
      verdict = { score: 0, reason: `ERROR: ${String(e.message).slice(0, 200)}` };
    }
    runScores.push(verdict.score);
    details.push(verdict);
  }
  runScores.sort((a, b) => a - b);
  const median = runScores[Math.floor(runScores.length / 2)];
  return { task: task.id, score: median, runs: runScores, details };
}

const taskDir = path.join(__dirname, "tasks-sentiment");
const tasks = fs.readdirSync(taskDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(taskDir, f), "utf8")));

const results = [];
for (const task of tasks) {
  const t0 = Date.now();
  const r = await runTask(task);
  const mark = r.score >= 100 ? "✓" : "✗";
  console.log(`${mark} ${task.id}: ${r.score.toFixed(0)}% [runs: ${r.runs.join("/")}]  (${Date.now() - t0}ms)`);
  if (r.score < 100) {
    for (const d of r.details) {
      const fails = (d.checks || []).filter((c) => !c.ok);
      for (const f of fails) {
        console.log(`    ✗ ${f.field}: got=${JSON.stringify(f.got)} expected=${JSON.stringify(f.expected)}`);
      }
      if (d.reason) console.log(`    ✗ ${d.reason}`);
    }
  }
  results.push(r);
}

const overall = results.reduce((s, r) => s + r.score, 0) / results.length;
console.log(`\nOVERALL: ${overall.toFixed(1)}%  (${results.length} tasks, ${RUNS} run(s) each)`);
