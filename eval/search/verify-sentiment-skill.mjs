#!/usr/bin/env node
// eval/search/verify-sentiment-skill.mjs — verifier for the sentiment-routing skill.
// Runs the sentiment corpus with the candidate skill and gates on a threshold.
// Mirrors verify-search-skill.mjs shape; the cascade calls this with the
// candidate skill path and expects "OVERALL: NN.N%" on stdout plus exit 0/1.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const skillIdx = args.indexOf("--skill");
const skillPath = skillIdx >= 0 ? path.resolve(args[skillIdx + 1]) : null;
if (!skillPath) {
  console.error("usage: verify-sentiment-skill.mjs --skill <path-to-skill.md>");
  process.exit(2);
}

const RUNS = process.env.EVAL_RUNS ?? "3";
const THRESHOLD = parseFloat(process.env.VERIFY_THRESHOLD ?? "100");

try {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, "run-sentiment-eval.mjs"), "--skill", skillPath],
    {
      encoding: "utf8",
      timeout: 1800000,
      maxBuffer: 16 * 1024 * 1024,
      cwd: path.join(__dirname, "..", ".."),
      env: { ...process.env, EVAL_RUNS: RUNS },
    }
  );
  process.stdout.write(out);
  const m = out.match(/OVERALL:\s*([\d.]+)%/);
  if (!m) {
    console.error("VERIFY FAIL: could not parse OVERALL from eval output");
    process.exit(1);
  }
  const score = parseFloat(m[1]);
  if (score >= THRESHOLD) {
    console.log(`VERIFY PASS: ${score}% >= ${THRESHOLD}%`);
    process.exit(0);
  }
  console.log(`VERIFY FAIL: ${score}% < ${THRESHOLD}%`);
  process.exit(1);
} catch (e) {
  if (e.stdout) process.stdout.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  console.error(`VERIFY ERROR: ${String(e.message).slice(0, 300)}`);
  process.exit(1);
}
