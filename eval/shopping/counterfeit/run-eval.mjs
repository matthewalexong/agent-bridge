#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frontierCall } from "../../../cascade/lib/frontier.mjs";
import { deriveRiskFeatures } from "./lib/risk-features.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const skill = readFileSync(resolve(arg("skill", join(here, "skills/main-risk-policy-v1.md"))), "utf8");
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8"));
const tier = arg("model-tier", "main");
const only = arg("only", "").split(",").filter(Boolean);

async function ask(messages) {
  if (tier === "main") return frontierCall(messages, { maxTokens: 1000 });
  throw new Error("Auxiliary models may not assess authenticity risk; run this adjudication eval with --model-tier main.");
}

function parse(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const a = raw.indexOf("{"); const b = raw.lastIndexOf("}");
  return JSON.parse(a >= 0 ? raw.slice(a, b + 1) : raw);
}

const results = [];
for (const task of tasks) {
  if (only.length && !only.includes(task.id)) continue;
  const { expected, ...raw } = task;
  const visible = { ...raw, derived_risk_features: deriveRiskFeatures(raw) };
  try {
    const model = await ask([{ role: "system", content: skill }, { role: "user", content: JSON.stringify(visible, null, 2) }]);
    const answer = parse(model.text);
    const gotRisks = Object.fromEntries((answer.assessments || []).map((a) => [a.offer_id, a.risk_level]));
    const assessment_ok = Object.entries(expected.risks).every(([id, risk]) => gotRisks[id] === risk);
    const false_safe_ids = expected.high_risk_offer_ids.filter((id) => gotRisks[id] === "low");
    const action_ok = answer.recommended_action === expected.recommended_action;
    const target_ok = String(answer.target).toLowerCase() === String(expected.target).toLowerCase();
    const summary = String(answer.summary || "").toLowerCase().replace(/\bnot (?:a )?(?:counterfeit|fake)\b/g, "");
    const unsupported_accusation = /\b(?:is|are|definitely|proven)\b.{0,20}\b(?:counterfeit|fake)\b/.test(summary);
    results.push({ task: task.id, answer, expected, assessment_ok, false_safe_ids, unsupported_accusation, action_ok, target_ok, prompt_tokens: model.promptTokens || 0, completion_tokens: model.completionTokens || 0 });
    console.log(`${assessment_ok && action_ok && target_ok && !false_safe_ids.length && !unsupported_accusation ? "PASS" : "FAIL"} ${task.id}: ${answer.recommended_action} -> ${answer.target} risks=${JSON.stringify(gotRisks)}`);
  } catch (error) {
    results.push({ task: task.id, error: error.message, assessment_ok: false, false_safe_ids: [], action_ok: false, target_ok: false });
    console.log(`ERROR ${task.id}: ${error.message}`);
  }
}

const n = results.length || 1;
const assessment = results.filter((r) => r.assessment_ok).length / n;
const action = results.filter((r) => r.action_ok).length / n;
const target = results.filter((r) => r.target_ok).length / n;
const highCount = results.reduce((sum, r) => sum + (r.expected?.high_risk_offer_ids?.length || 0), 0);
const falseSafe = results.reduce((sum, r) => sum + r.false_safe_ids.length, 0);
const accusationRate = results.filter((r) => r.unsupported_accusation).length / n;
const summary = { tier, brain_role: tier === "main" ? "harness_main" : "auxiliary_only", assessment, action, target, false_safe_rate: highCount ? falseSafe / highCount : 0, unsupported_accusation_rate: accusationRate, prompt_tokens: results.reduce((s, r) => s + (r.prompt_tokens || 0), 0), completion_tokens: results.reduce((s, r) => s + (r.completion_tokens || 0), 0) };
console.log(`\nASSESSMENT ${(assessment * 100).toFixed(1)}% | ACTION ${(action * 100).toFixed(1)}% | TARGET ${(target * 100).toFixed(1)}% | FALSE-SAFE ${(summary.false_safe_rate * 100).toFixed(1)}% | UNSUPPORTED-ACCUSATION ${(accusationRate * 100).toFixed(1)}%`);
mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
console.log(`wrote ${out}`);
