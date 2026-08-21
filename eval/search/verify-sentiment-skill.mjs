#!/usr/bin/env node
// eval/search/verify-sentiment-skill.mjs — verifier for the sentiment-routing skill.
// Same calling convention as verify-search-skill.mjs (the cascade uses
// `node <verifier> <candidatePath> <threshold>` positionally):
//   node verify-sentiment-skill.mjs <skill-file> [threshold-fraction]
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillFile = process.argv[2];
// Threshold is a fraction (0.98) like the search verifier. The sentiment
// corpus is small (8 tasks) and the v2 baseline is already 100%, so demand
// perfection — any regression is a real regression.
const threshold = parseFloat(process.argv[3] || "1.0");
if (!skillFile) {
  console.error("usage: verify-sentiment-skill.mjs <skill-file> [threshold]");
  process.exit(2);
}

const RUNS = process.env.EVAL_RUNS ?? "3";

try {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, "run-sentiment-eval.mjs"), "--skill", skillFile],
    {
      encoding: "utf8",
      timeout: 1800000,
      maxBuffer: 16 * 1024 * 1024,
      cwd: path.join(__dirname, "..", ".."),
      env: { ...process.env, EVAL_RUNS: RUNS },
    }
  );
  const m = out.match(/OVERALL:\s*([\d.]+)%/);
  if (!m) {
    console.error("VERIFY FAIL: could not parse OVERALL from eval output:\n" + out.slice(-1000));
    process.exit(1);
  }
  const score = parseFloat(m[1]) / 100;
  if (score >= threshold) {
    console.log(out.split("\n").filter((l) => /OVERALL/.test(l)).join("\n"));
    console.log(`PASS: overall ${(score * 100).toFixed(1)}% >= threshold ${(threshold * 100).toFixed(0)}%`);
    process.exit(0);
  }
  // Rich feedback on FAIL — the proposal loop needs per-task detail to fix
  // specific fields. (The thrashing bug in the search verifier taught us this.)
  console.error(`FAIL: overall ${(score * 100).toFixed(1)}% < threshold ${(threshold * 100).toFixed(0)}%`);
  console.error("\nPER-TASK FAILURES (fix these specific fields):\n" + out.slice(-4000));
  process.exit(1);
} catch (e) {
  if (e.stdout) console.error("VERIFIER FAILURE:\n" + e.stdout.slice(-1500));
  if (e.stderr) console.error(e.stderr.slice(-500));
  console.error(`VERIFY ERROR: ${String(e.message).slice(0, 300)}`);
  process.exit(1);
}
