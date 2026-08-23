import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("shopping decision eval scripts reserve policy and authenticity decisions for the main brain", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["eval:shopping"], /--model-tier frontier/);
  assert.equal("eval:shopping-sufficiency:aux-smoke" in packageJson.scripts, false);
  assert.equal("eval:shopping-counterfeit:aux-smoke" in packageJson.scripts, false);

  const purchase = read("eval/shopping/run-purchase-eval.mjs");
  const sufficiency = read("eval/shopping/sufficiency/run-eval.mjs");
  const counterfeit = read("eval/shopping/counterfeit/run-eval.mjs");
  assert.match(purchase, /Auxiliary models may not make purchase decisions/);
  assert.match(sufficiency, /Auxiliary models may not decide shopping research sufficiency/);
  assert.match(counterfeit, /Auxiliary models may not assess authenticity risk/);
  assert.doesNotMatch(purchase, /LOCAL_LLM|Gemma HTTP/);
});

test("shopping runtime architecture is complete with no local model", () => {
  const skill = read("eval/search/skills/panel-chat-skill-v3.md");
  const target = read("eval/shopping/DOSSIER_TARGET.md");
  assert.match(skill, /No Gemma or other local model is a\s+component, lane, scheduler, router, cache, source of truth, or prerequisite/i);
  assert.match(skill, /complete shopping path must behave correctly when no\s+local model is installed, reachable, or configured/i);
  assert.match(skill, /absence or failure must fall back to the same main-brain and deterministic\s+path without changing evidence requirements, decisions, progress, or results/i);
  assert.match(target, /No local model is part of, or required by, the runtime\s+architecture/i);
  assert.match(target, /removing it cannot\s+change orchestration, evidence, state, decisions, progress, or results/i);
  const brain = read("eval/search/live/hermes-brain.mjs");
  const lanes = read("eval/search/live/research-lanes.mjs");
  assert.doesNotMatch(brain + lanes, /LOCAL_LLM|127\.0\.0\.1:8080|local-worker|Gemma HTTP/i);
});
