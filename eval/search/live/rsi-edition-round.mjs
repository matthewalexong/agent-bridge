// rsi-edition-round.mjs — RSI loop driver for the edition-decoy failure.
// Usage: node eval/search/live/rsi-edition-round.mjs [--skill <path>] [--runs N]
// Runs the real hermes-brain against the frozen black-bottle task, judges the
// envelope with edition-judge (deterministic), prints PASS/FAIL + failures.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeEditionDecoy } from "../lib/edition-judge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const skillFile = arg("skill", join(root, "eval/search/skills/panel-chat-skill-v2.md"));
const runs = Number(arg("runs", 1));
const task = JSON.parse(readFileSync(join(root, "eval/search/correction-corpus/black-bottle-task.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(root, "eval/search/live/captures", task.fixture), "utf8"));

const prior = task.transcript.slice(0, -1); // all but the last user message
const finalMsg = task.transcript[task.transcript.length - 1].text;

function runBrain() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "eval/search/live/hermes-brain.mjs")], {
      env: {
        ...process.env,
        AB_SKILL_FILE: skillFile,
        AB_TRANSCRIPT_JSON: JSON.stringify(prior),
        AB_FIXTURE: join(root, "eval/search/live/captures", task.fixture),
        AB_EMIT_ENVELOPE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", reject);
    child.stdin.write(finalMsg);
    child.stdin.end();
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 120_000);
  });
}

let passCount = 0;
for (let run = 1; run <= runs; run++) {
  const t0 = Date.now();
  const { code, out, err } = await runBrain();
  const ms = Date.now() - t0;
  if (code !== 0) {
    console.log(`RUN ${run}: BRAIN FAILED (exit ${code}) ${ms}ms\n  stderr: ${err.slice(0, 300)}`);
    continue;
  }
  let envelope;
  try { envelope = JSON.parse(out); }
  catch { console.log(`RUN ${run}: ENVELOPE PARSE FAIL ${ms}ms\n  out: ${out.slice(0, 300)}`); continue; }
  const verdict = judgeEditionDecoy(envelope, fixture, task.spec);
  if (verdict.pass) passCount++;
  console.log(`RUN ${run}: ${verdict.pass ? "PASS" : "FAIL"} ${ms}ms`);
  console.log(`  answer: ${(envelope.answer || "").slice(0, 220)}`);
  console.log(`  citations: ${JSON.stringify(envelope.citations)}`);
  for (const f of verdict.failures) console.log(`  ✗ ${f}`);
}
console.log(`\nRESULT: ${passCount}/${runs} pass (skill: ${skillFile})`);
