#!/usr/bin/env node
// eval-correction.mjs — deterministic evaluator for the panel-chat correction skill.
//
// Runs every corpus task through the REAL hermes-brain.mjs (spawned as a child
// process, stdin/stdout contract — never mocked), scores the envelope with the
// deterministic correction-judge, median-of-N per task.
//
// Usage:
//   node eval/search/eval-correction.mjs [--skill <file>] [--runs N] [--tasks id1,id2]
//
// Env:
//   AB_MODEL_CONFIG — passed to the brain as HERMES_BRAIN_CONFIG_FILE
//                     (defaults to the real ~/.hermes/config.yaml = production model)
//   EVAL_TEMPERATURE is NOT used — model-client has fixed settings.
//
// Output: JSON on stdout {score, per_task:[{id, median, runs:[score...], failures:[...]}]}
// Failures carry field-level detail (which check, what the envelope said, ground truth).

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeCorrection } from "./lib/correction-judge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES = join(__dirname, "live", "captures");
const BRAIN = join(__dirname, "live", "hermes-brain.mjs");

// --- CLI parsing ---
const argv = process.argv.slice(2);
function argFlag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const SKILL_FILE = argFlag("--skill", join(__dirname, "skills", "panel-chat-skill-v1.md"));
const RUNS = parseInt(argFlag("--runs", process.env.EVAL_RUNS || "3"), 10);
const TASK_FILTER = argFlag("--tasks", "") ? argFlag("--tasks", "").split(",").map(s => s.trim()) : null;

const corpus = JSON.parse(readFileSync(join(__dirname, "correction-corpus", "tasks.json"), "utf8"));

// --- Run the real brain once on one task; returns {envelopeJson, stderr, exitCode} ---
function runBrain(task, skillFile, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      AB_TRANSCRIPT_JSON: JSON.stringify(task.transcript),
      AB_FIXTURE: join(CAPTURES, task.fixture),
      AB_SKILL_FILE: skillFile,
      AB_EMIT_ENVELOPE: "1",
    };
    if (process.env.AB_MODEL_CONFIG) env.HERMES_BRAIN_CONFIG_FILE = process.env.AB_MODEL_CONFIG;
    const child = spawn("node", [BRAIN], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, exitCode: code });
    });
    // spawn + write + explicit end — never promisify(execFile) with input
    // (it never closes stdin; handler hangs until timeout).
    child.stdin.write(task.current);
    child.stdin.end();
  });
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function evalTask(task, skillFile, runs) {
  const runScores = [];
  const failures = [];
  const fixture = JSON.parse(readFileSync(join(CAPTURES, task.fixture), "utf8"));
  for (let r = 0; r < runs; r++) {
    const res = await runBrain(task, skillFile);
    let verdict;
    if (res.exitCode !== 0) {
      verdict = { score: 0, checks: [{ check: "brain_exit", pass: false, detail: `brain exited ${res.exitCode}: ${res.stderr.slice(-200)}` }] };
    } else {
      verdict = judgeCorrection(task, res.stdout, fixture);
    }
    runScores.push(verdict.score);
    if (verdict.score < 1 && r === 0) {
      // Field-level failure detail from the first failing run (enough signal
      // for the factory; repeating per-run triples the payload for no gain).
      for (const c of verdict.checks.filter((c) => !c.pass)) {
        failures.push({
          run: r, check: c.check, detail: c.detail,
          envelope: verdict.envelope ? {
            correction_detected: verdict.envelope.correction_detected,
            prior_claim: verdict.envelope.prior_claim ?? null,
            searches: verdict.envelope.searches ?? [],
            citations: verdict.envelope.citations ?? [],
            products_found: verdict.envelope.products_found ?? [],
            answer: (verdict.envelope.answer || "").slice(0, 300),
          } : null,
          ground_truth: task.ground_truth,
        });
      }
    }
  }
  return { id: task.id, median: median(runScores), runs: runScores, failures };
}

async function main() {
  const started = Date.now();
  const tasks = TASK_FILTER ? corpus.tasks.filter((t) => TASK_FILTER.includes(t.id)) : corpus.tasks;
  const results = [];
  for (const task of tasks) {
    process.stderr.write(`[eval] ${task.id} (${RUNS} runs)... `);
    const r = await evalTask(task, SKILL_FILE, RUNS);
    process.stderr.write(`median ${r.median.toFixed(2)}\n`);
    results.push(r);
  }
  const overall = results.reduce((a, r) => a + r.median, 0) / results.length;
  const out = {
    skill: SKILL_FILE,
    overall: Number(overall.toFixed(4)),
    per_task: results,
    elapsed_s: Math.round((Date.now() - started) / 1000),
  };
  process.stdout.write(JSON.stringify(out, null, 1));
}

main().catch((e) => { console.error(`eval-correction: ${e.message}`); process.exit(1); });
