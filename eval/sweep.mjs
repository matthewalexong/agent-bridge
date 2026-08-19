#!/usr/bin/env node
// eval/sweep.mjs — one-knob-at-a-time sweep harness (Layer 0 pilot)
//
// Idea (Karpathy-style): dial ONE knob, keep everything else identical,
// re-run the eval many times, keep only deterministic scorer output.
// No LLM judges anything — the sweep produces raw tables; interpretation
// is a separate (frontier) step.
//
// Usage:
//   node eval/sweep.mjs --knob temperature --values 0,0.3,0.7 --runs 6
//   node eval/sweep.mjs --knob prompt --variants v1,v2 --runs 6
//   node eval/sweep.mjs --knob repeats --runs 10        (same prompt, same settings)
//
// Writes results to eval/results/sweep-<knob>-<ts>.json and prints a table.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL = path.join(__dirname, "run-eval.mjs");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] ?? "true", i++;
  }
  return args;
}

// Shell out to run-eval.mjs via execSync and parse the OVERALL line
import { execSync } from "node:child_process";

function evalOnce(opts) {
  const cmd = ["node", JSON.stringify(EVAL)];
  if (opts.skill) cmd.push("--skill", JSON.stringify(opts.skill));
  const env = { ...process.env };
  if (opts.temperature !== undefined) env.EVAL_LLM_TEMPERATURE = String(opts.temperature);
  if (opts.seed !== undefined) env.EVAL_LLM_SEED = String(opts.seed);
  const out = execSync(cmd.join(" "), { env, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  // parse the final OVERALL line: "═══ OVERALL: 83.3% across 3 task(s) ═══"
  const m = out.match(/OVERALL:\s*([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

function main() {
  const args = parseArgs(process.argv);
  const runs = parseInt(args.runs || "5", 10);
  const knob = args.knob || "repeats";

  // Build the list of (label, opts) cells to test
  const cells = [];
  if (knob === "temperature") {
    for (const t of (args.values || "0,0.3,0.7").split(",")) {
      cells.push({ label: `temp=${t}`, opts: { temperature: parseFloat(t) } });
    }
  } else if (knob === "prompt") {
    for (const v of (args.variants || "").split(",").filter(Boolean)) {
      const p = path.join(__dirname, "skills", v.endsWith(".md") ? v : `${v}.md`);
      cells.push({ label: v, opts: { skill: p } });
    }
  } else if (knob === "repeats") {
    // same everything; test pure variance
    for (let i = 0; i < 1; i++) cells.push({ label: "baseline", opts: {} });
  }

  console.log(`=== sweep: knob=${knob}, ${runs} runs per cell ===`);
  const results = [];
  for (const cell of cells) {
    const scores = [];
    for (let r = 0; r < runs; r++) {
      const s = evalOnce(cell.opts);
      scores.push(s);
      process.stdout.write(`  ${cell.label} run ${r + 1}/${runs}: ${s}%\n`);
    }
    const mean = scores.reduce((a, b) => a + b, 0) / runs;
    const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / runs);
    const min = Math.min(...scores), max = Math.max(...scores);
    results.push({ cell: cell.label, scores, mean: +mean.toFixed(2), std: +std.toFixed(2), min, max });
    console.log(`  -> ${cell.label}: mean=${mean.toFixed(2)} std=${std.toFixed(2)} range=[${min},${max}]\n`);
  }

  // save
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(__dirname, "results", `sweep-${knob}-${ts}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ knob, runs, cells: results }, null, 2));
  console.log(`saved -> ${outPath}`);

  // summary table
  console.log(`\n=== SUMMARY (knob: ${knob}) ===`);
  for (const r of results) {
    console.log(`${r.cell.padEnd(18)} mean=${String(r.mean).padStart(6)}  std=${String(r.std).padStart(5)}  range=[${r.min}..${r.max}]`);
  }
}

main();
