#!/usr/bin/env node
// eval/search/verify-clarify-skill.mjs — verifier for the clarify-answer skill.
// Runs the full clarify corpus with the candidate skill and gates on a
// threshold. Mirrors verify-search-skill.mjs semantics: prints per-task scores
// and a final verdict line; exits non-zero below threshold so the cascade
// verifier treats it as FAIL and feeds the failures back to the model.
//
// Usage: node eval/search/verify-clarify-skill.mjs <candidate-skill.md> [threshold]
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidatePath = process.argv[2];
const threshold = parseFloat(process.argv[3] ?? "0.98");
if (!candidatePath) {
  console.error("usage: verify-clarify-skill.mjs <skill.md> [threshold]");
  process.exit(2);
}

const runner = path.join(__dirname, "run-clarify-eval.mjs");
let out;
try {
  out = execSync(
    `EVAL_LLM_TEMPERATURE=0 EVAL_RUNS=3 node ${JSON.stringify(runner)} --skill ${JSON.stringify(candidatePath)}`,
    { encoding: "utf8", timeout: 1800000, maxBuffer: 16 * 1024 * 1024 }
  );
} catch (e) {
  const msg = ((e.stdout || "") + (e.stderr || "")) || String(e.message);
  console.log(msg);
  console.log("\nVERIFY: FAIL (eval errored)");
  process.exit(1);
}
console.log(out);
const m = out.match(/OVERALL:\s*([\d.]+)%/);
if (!m) {
  console.log("\nVERIFY: FAIL (no OVERALL score found)");
  process.exit(1);
}
const score = parseFloat(m[1]) / 100;
if (score >= threshold) {
  console.log(`\nVERIFY: PASS (${(score * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}%)`);
  process.exit(0);
}
console.log(`\nVERIFY: FAIL (${(score * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}%)`);
process.exit(1);
