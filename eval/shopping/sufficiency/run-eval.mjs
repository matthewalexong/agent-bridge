#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frontierCall } from "../../../cascade/lib/frontier.mjs";
import { deriveSufficiencyFeatures } from "./lib/state-features.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const skill = readFileSync(resolve(arg("skill", join(here, "skills/search-sufficiency-v1.md"))), "utf8");
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8"));
const runs = Math.max(1, Number(arg("runs", "1")));
// Shopping sufficiency is a main-brain decision. Auxiliary models may format
// already-returned fields elsewhere, but may not select this action or target.
const tier = arg("model-tier", "main");
const only = arg("only", "").split(",").filter(Boolean);

async function ask(messages) {
  if (tier === "main" || tier === "frontier") return frontierCall(messages, { maxTokens: 800 });
  throw new Error("Auxiliary models may not decide shopping research sufficiency; use --model-tier main.");
}

function parse(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const a = raw.indexOf("{"); const b = raw.lastIndexOf("}");
  return JSON.parse(a >= 0 ? raw.slice(a, b + 1) : raw);
}

const results = [];
for (const task of tasks) for (let run = 1; run <= runs; run++) {
  if (only.length && !only.includes(task.id)) continue;
  const { expected, ...rawState } = task;
  const visible = { ...rawState, derived_state: deriveSufficiencyFeatures(rawState) };
  try {
    const modelResult = await ask([{ role: "system", content: skill }, { role: "user", content: JSON.stringify(visible, null, 2) }]);
    const answer = parse(modelResult.text);
    const action_ok = answer.action === expected.action;
    const target_ok = String(answer.target).toLowerCase() === String(expected.target).toLowerCase();
    results.push({ task: task.id, run, answer, expected, action_ok, target_ok, prompt_tokens: modelResult.promptTokens || 0, completion_tokens: modelResult.completionTokens || 0 });
    console.log(`${action_ok && target_ok ? "PASS" : "FAIL"} ${task.id}: ${answer.action} -> ${answer.target}`);
  } catch (error) {
    results.push({ task: task.id, run, error: error.message, action_ok: false, target_ok: false });
    console.log(`ERROR ${task.id}: ${error.message}`);
  }
}
const action = results.filter((r) => r.action_ok).length / results.length;
const target = results.filter((r) => r.target_ok).length / results.length;
const promptTokens = results.reduce((sum, r) => sum + (r.prompt_tokens || 0), 0);
const completionTokens = results.reduce((sum, r) => sum + (r.completion_tokens || 0), 0);
console.log(`\nACTION ${(action * 100).toFixed(1)}% | TARGET ${(target * 100).toFixed(1)}%`);
mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ summary: { tier, brain_role: tier === "main" || tier === "frontier" ? "harness_main" : "auxiliary_only", runs, action, target, prompt_tokens: promptTokens, completion_tokens: completionTokens }, results }, null, 2));
console.log(`wrote ${out}`);
