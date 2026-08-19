#!/usr/bin/env node
// eval/verify-skill.mjs — the deterministic verifier for the skill-improvement task.
// Runs the extract-then-judge pipeline with a candidate skill and demands a
// threshold score. NO LLM judgment anywhere: Gemma extracts, code scores.
// Usage: node eval/verify-skill.mjs <skill-file> [threshold]
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillFile = process.argv[2];
const threshold = parseFloat(process.argv[3] || "0.98");
if (!skillFile || !fs.existsSync(skillFile)) {
  console.error(`skill file not found: ${skillFile}`);
  process.exit(1);
}

// Reject degenerate candidates up front (cheap guard, saves an LLM pass)
const text = fs.readFileSync(skillFile, "utf8");
if (text.length < 200) { console.error("skill too short"); process.exit(1); }
// Anti-hardcoding: the skill must be generic — no corpus task ids, no product names,
// no task-specific numbers (908g container, 1250G formula, 22.5 servings, etc.)
const forbidden = [
  "two-scoop", "container-weight", "honest-control", "metric-weight", "fractional-servings", "headline-vs-panel",
  "MASSO", "IronPeak", "GreenFuel", "NightCasein", "Titan Whey", "Pure Whey Concentrate", "NitroFuel",
  "1250G PROTEIN", "22.5 servings", "908g", "908 g", "908G", "25000 MG",
];
for (const f of forbidden) {
  if (text.toLowerCase().includes(f.toLowerCase())) {
    console.error(`skill hardcodes corpus detail "${f}" — no hardcoding allowed`);
    process.exit(1);
  }
}

try {
  const out = execSync(
    `EVAL_LLM_TEMPERATURE=0 node ${JSON.stringify(path.join(__dirname, "run-eval.mjs"))} --skill ${JSON.stringify(skillFile)}`,
    { encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024, cwd: path.join(__dirname, "..") }
  );
  const m = out.match(/OVERALL:\s*([\d.]+)%/);
  if (!m) { console.error("could not parse OVERALL from eval output:\n" + out.slice(-800)); process.exit(1); }
  const overall = parseFloat(m[1]) / 100;
  console.log(out.split("\n").filter((l) => /TOTAL SCORE|OVERALL/.test(l)).join("\n"));
  if (overall >= threshold) {
    console.log(`PASS: overall ${(overall * 100).toFixed(1)}% >= threshold ${(threshold * 100).toFixed(0)}%`);
  } else {
    console.error(`FAIL: overall ${(overall * 100).toFixed(1)}% < threshold ${(threshold * 100).toFixed(0)}%`);
    process.exit(1);
  }
} catch (e) {
  console.error("VERIFIER FAILURE:\n" + ((e.stdout || "") + (e.stderr || "")).slice(-1500));
  process.exit(1);
}
