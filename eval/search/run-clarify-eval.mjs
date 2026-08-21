#!/usr/bin/env node
// eval/search/run-clarify-eval.mjs — the clarify-answer half of the conversation loop.
//
//   The clarify judge (lib/clarify-judge.mjs, pure code) decides WHEN to ask.
//   This runner measures the other half: given the question we asked and the
//   user's free-text reply, can the model map the reply onto one candidate
//   listing? Code judges the selection deterministically.
//
// The ONLY knob is the skill markdown (the clarify-answer prompt). Same
// extract-then-judge shape as run-search-eval.mjs.
// Usage: node eval/search/run-clarify-eval.mjs [--skill path/to/skill.md]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWeightG, extractReviewCount, totalSizeG } from "./lib/search-judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const skillArg = args.includes("--skill") ? args[args.indexOf("--skill") + 1] : null;
const skillPath = skillArg
  ? path.resolve(skillArg)
  : path.join(__dirname, "skills", "clarify-answer-v1.md");
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
          max_tokens: 200,
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

// ---- The deterministic judge for a clarify answer ------------------------
// Code decides: did the model pick the right listing (or correctly refuse)?
// No LLM anywhere in judging.
function judgeAnswer(task, parsed) {
  const expected = task.expected;
  if (!parsed || typeof parsed !== "object") {
    return { score: 0, reason: "no JSON parsed from model output" };
  }
  const got = parsed.action === "select"
    ? { action: "select", listing_id: parsed.listing_id }
    : { action: "ask_again" };
  if (got.action !== expected.action) {
    return { score: 0, reason: `action got=${got.action} expected=${expected.action}` };
  }
  if (expected.action === "select" && got.listing_id !== expected.listing_id) {
    return { score: 0, reason: `listing_id got=${got.listing_id} expected=${expected.listing_id}` };
  }
  return { score: 1, reason: "ok" };
}

function formatPrompt(task) {
  const lines = task.candidates.map((c) => {
    const bits = [`[${c.id}]`];
    if (c.flavor) bits.push(`Flavor: ${c.flavor}`);
    if (c.size_value != null) bits.push(`Size: ${c.size_value}${c.size_unit ?? ""}`);
    if (c.price_usd != null) bits.push(`Price: $${c.price_usd.toFixed(2)}`);
    const rv = extractReviewCount(c.reviews_raw);
    if (rv != null) bits.push(`Reviews: ${rv.toLocaleString()}`);
    bits.push(`Stock: ${c.stock ?? "in stock"}`);
    return bits.join(" | ");
  });
  return [
    `=== CLARIFYING QUESTION ASKED ===`,
    task.question,
    ``,
    `=== CANDIDATE LISTINGS ===`,
    ...lines,
    ``,
    `=== USER REPLY ===`,
    task.reply,
  ].join("\n");
}

async function runTask(task) {
  const runScores = [];
  for (let r = 0; r < RUNS; r++) {
    let verdict;
    try {
      const out = await localAsk(formatPrompt(task));
      verdict = judgeAnswer(task, parseJson(out));
    } catch (e) {
      verdict = { score: 0, reason: `ERROR: ${String(e.message).slice(0, 200)}` };
    }
    runScores.push(verdict.score);
  }
  runScores.sort((a, b) => a - b);
  const median = runScores[Math.floor(runScores.length / 2)];
  return { task: task.id, score: median, runs: runScores };
}

const taskDir = path.join(__dirname, "tasks-clarify");
const tasks = fs.readdirSync(taskDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(taskDir, f), "utf8")));

const results = [];
for (const task of tasks) {
  const t0 = Date.now();
  const r = await runTask(task);
  const mark = r.score >= 1 ? "✓" : "✗";
  console.log(`${mark} ${task.id}: ${(r.score * 100).toFixed(0)}% [runs: ${r.runs.join("/")}]  (${Date.now() - t0}ms)`);
  results.push(r);
}

const overall = results.reduce((s, r) => s + r.score, 0) / results.length;
console.log(`\nOVERALL: ${(overall * 100).toFixed(1)}%  (${results.length} tasks, ${RUNS} run(s) each)`);
