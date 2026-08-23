#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frontierCall } from "../../cascade/lib/frontier.mjs";
import { judgePurchase } from "./lib/purchase-judge.mjs";
import { finalizePurchaseDecision, preparePurchaseDecision } from "./lib/purchase-controller.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const skillPath = resolve(arg("skill", join(here, "skills/purchase-decision-v1.md")));
const taskDir = resolve(arg("task-dir", join(here, "tasks")));
const runs = Math.max(1, Number(arg("runs", "1")));
const modelTier = arg("model-tier", process.env.SHOPPING_EVAL_MODEL_TIER || "frontier");
const only = arg("only", "").split(",").filter(Boolean);
const skill = readFileSync(skillPath, "utf8");

async function modelCall(messages) {
  if (!["frontier", "main"].includes(modelTier)) throw new Error("Auxiliary models may not make purchase decisions; use --model-tier frontier.");
  return frontierCall(messages, { maxTokens: 1800 });
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  try { return JSON.parse(raw); } catch {}
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(raw.slice(a, b + 1));
  throw new Error("no JSON object in model response");
}

const files = readdirSync(taskDir).filter((f) => f.endsWith(".json")).sort();
const results = [];
for (const file of files) {
  const task = JSON.parse(readFileSync(join(taskDir, file), "utf8"));
  if (only.length && !only.includes(task.id)) continue;
  for (let run = 1; run <= runs; run++) {
    const prepared = preparePurchaseDecision(task);
    const visible = {
      user_request: task.user_request,
      required_preference_missing: task.requires_clarification === true,
      requirements: task.requirements,
      objective: task.objective,
      ...prepared,
    };
    try {
      const reply = await modelCall([
        { role: "system", content: skill },
        { role: "user", content: JSON.stringify(visible, null, 2) },
      ]);
      const modelAnswer = parseJson(reply.text);
      const answer = finalizePurchaseDecision(prepared.verified_decision, modelAnswer);
      const verdict = judgePurchase(task, answer);
      results.push({ task: task.id, run, answer, ...verdict });
      console.log(`${verdict.pass ? "PASS" : "FAIL"} ${task.id} run ${run}: ${answer.action} ${answer.selected_offer ?? "-"}`);
      for (const failure of verdict.failures) console.log(`  - ${failure}`);
    } catch (error) {
      results.push({ task: task.id, run, pass: false, error: error.message });
      console.log(`ERROR ${task.id} run ${run}: ${error.message}`);
    }
  }
}

const total = results.length || 1;
const action = results.filter((r) => r.actionOk).length / total;
const selection = results.filter((r) => r.selectionOk).length / total;
const landed = results.filter((r) => r.landedOk).length / total;
const evidence = results.reduce((sum, r) => sum + (r.evidenceScore || 0), 0) / total;
const summary = { skill: skillPath, model_tier: modelTier, runs, tasks: total / runs, action, selection, landed, evidence, gate_pass: action === 1 && selection === 1 };
console.log(`\nACTION ${(action * 100).toFixed(1)}% | SELECTION ${(selection * 100).toFixed(1)}% | LANDED ${(landed * 100).toFixed(1)}% | EVIDENCE ${(evidence * 100).toFixed(1)}%`);
mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
console.log(`wrote ${out}`);
