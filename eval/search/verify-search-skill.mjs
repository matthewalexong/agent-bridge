#!/usr/bin/env node
// eval/search/verify-search-skill.mjs — deterministic verifier for TASK 5.
// Runs the search extract-then-judge pipeline with a candidate skill and demands
// a threshold score. NO LLM judgment anywhere: Gemma transcribes, code decides.
// Usage: node eval/search/verify-search-skill.mjs <skill-file> [threshold]
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
// Anti-hardcoding: the skill must be generic — no corpus task ids, brands, or
// task-specific strings. (Numbers/units like "2.2LB" are generic measurement
// vocabulary and are allowed; only corpus-unique strings are banned.)
const forbidden = [
  "twin-distractor", "sponsored-twin", "oos-full-match", "mg-protein-distractor",
  "no-match-honest", "mixed-units-size",
  "MuscleMax", "GreenGain", "OptiPure", "CaseinPro", "NitroFuel", "PureFuel",
  "Vanilla Whey Protein Trial Pack", "25000 MG", "Slow-Release Casein",
];
for (const f of forbidden) {
  if (text.toLowerCase().includes(f.toLowerCase())) {
    console.error(`skill hardcodes corpus detail "${f}" — no hardcoding allowed`);
    process.exit(1);
  }
}

try {
  const out = execSync(
    `EVAL_LLM_TEMPERATURE=0 node ${JSON.stringify(path.join(__dirname, "run-search-eval.mjs"))} --skill ${JSON.stringify(skillFile)}`,
    { encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024, cwd: path.join(__dirname, "..", "..") }
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
