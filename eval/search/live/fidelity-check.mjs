#!/usr/bin/env node
// Live-fidelity harness — Step 1 of the MVP check.
// Runs the EXACT production pipeline (v6 skill prompt -> local Gemma -> judge)
// on a REAL captured SERP (raw innerText from the user's Chrome), and reports:
//   1. Whether Gemma can transcribe real messy page text into parseable listings
//   2. Whether the judge reaches a sane verdict on that transcription
// There is NO ground truth here — that's the point. We eyeball fidelity.
//
// Usage:
//   node eval/search/live/fidelity-check.mjs --capture eval/search/live/captures/<file>.json \
//        --constraints '[{"kind":"size_g","value":2268}]' [--runs 1] [--max-chars 30000]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeSearch } from "../lib/search-judge.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const captureFile = arg("capture");
if (!captureFile) {
  console.error("Usage: fidelity-check.mjs --capture <file> --constraints <json>");
  process.exit(1);
}
const constraints = JSON.parse(arg("constraints", "[]"));
const RUNS = Math.max(1, parseInt(arg("runs", "1"), 10));
const maxChars = Number(arg("max-chars", 30000));
// Real SERPs carry ~48 listings x ~200 tokens each = ~9,600 tokens of JSON.
// The eval's 4096 cap truncates mid-object; size it for production SERPs.
const MAX_TOKENS = Number(arg("max-tokens", 12288));

const SKILL = fs.readFileSync(path.join(root, "..", "skills", "search-transcribe-v6.md"), "utf8");
const capture = JSON.parse(fs.readFileSync(path.resolve(captureFile), "utf8"));

// The production agent sees raw innerText (the `text` field) plus the refs
// snapshot. For transcription fidelity the text is what matters — truncate it
// the same way the capture script did, so we test exactly what ships.
const snapshot = (capture.text || "").slice(0, maxChars);
const prompt = `Query: ${capture.query}\n\n${snapshot}`;

const URL_ = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1/chat/completions";
const MODEL = process.env.LOCAL_LLM_MODEL || "gemma-4-e2b";
const TEMP = 0;

async function localAsk(p) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SKILL },
            { role: "user", content: p },
          ],
          temperature: TEMP,
          max_tokens: MAX_TOKENS,
        }),
      });
      if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
      return (await res.json()).choices[0].message.content;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
}

function extractJson(raw) {
  // Strip markdown fences. The opening fence may exist WITHOUT a closing one
  // if the token cap truncated output mid-JSON, so strip the leader always
  // and only trim at a closing fence if one is present.
  let s = raw.replace(/^\s*```(?:json)?\s*/i, "");
  const closeIdx = s.lastIndexOf("```");
  if (closeIdx >= 0) s = s.slice(0, closeIdx);
  s = s.trim();
  try { return JSON.parse(s); } catch {}
  // Repair truncated output: drop the trailing incomplete object, then close
  // whatever brackets remain.
  let t = s;
  const openObj = t.lastIndexOf("{");
  if (openObj >= 0) t = t.slice(0, openObj).replace(/,\s*$/, "");
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let repaired = t;
  while (stack.length) {
    const top = stack.pop();
    repaired += top === "{" ? "}" : "]";
  }
  try { return JSON.parse(repaired); } catch {}
  return null;
}

console.log(`capture: ${captureFile}`);
console.log(`query: ${capture.query} | constraints: ${JSON.stringify(constraints)}`);
console.log(`snapshot: ${snapshot.length} chars (of ${capture.textLength} captured)\n`);

for (let r = 0; r < RUNS; r++) {
  const t0 = Date.now();
  const raw = await localAsk(prompt);
  const parsed = extractJson(raw);
  const listings = parsed?.listings ?? parsed;
  console.log(`--- run ${r + 1}/${RUNS} (${Date.now() - t0}ms) ---`);
  if (!Array.isArray(listings)) {
    console.log("FAILED TO PARSE LISTINGS. Raw model output:");
    console.log(raw.slice(0, 1500));
    continue;
  }
  console.log(`parsed ${listings.length} listings:`);
  for (const l of listings) {
    console.log(`  [${l.id}] ${l.title} | brand=${l.brand} | size=${l.size_raw ?? l.size} | price=$${l.price_usd} | reviews=${l.reviews_raw ?? l.review_count} | sponsored=${l.sponsored} | stock=${l.stock ?? "?"}`);
  }
  const verdict = judgeSearch(constraints, listings);
  console.log(`\nVERDICT: action=${verdict.action} selected=${verdict.selected_listing ?? "none"} matched=${verdict.matched_constraints}/${constraints.length}`);
  console.log();
}
