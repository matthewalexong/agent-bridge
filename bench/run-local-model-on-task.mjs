#!/usr/bin/env node
// Sends the REAL agent-bridge optimization task to the local Qwen3.8-9B,
// extracts its candidate, runs it through bench-trace-accounting.mjs
// (correctness + speed), and on failure feeds the error back for retry.
import { readFileSync, writeFileSync } from "node:fs";

const ENDPOINT = "http://127.0.0.1:8080/v1/chat/completions";

async function call(messages, maxTokens = 1400) {
  const t0 = Date.now();
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3.8-9b", messages, max_tokens: maxTokens, temperature: 0.0 }),
  });
  const data = await resp.json();
  return { text: data.choices?.[0]?.message?.content || "", ms: Date.now() - t0 };
}

const hotCode = readFileSync(new URL("../lib/cdp-analysis.mjs", import.meta.url), "utf8")
  .split("\n").slice(247, 258).join("\n");

const task = `You are optimizing a hot path in a Chrome DevTools Protocol trace collector (Node.js ESM).

CURRENT CODE (the hot loop, runs for every Tracing.dataCollected event):

\`\`\`js
if (event.method === "Tracing.dataCollected" && state.trace && targetKey(event.source?.sessionId) === state.trace.targetKey) {
  for (const item of params.value || []) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (state.trace.bytes + bytes > MAX_ARTIFACT_BYTES) {
      state.trace.overflow = true;
      break;
    }
    state.trace.events.push(item);
    state.trace.bytes += bytes;
  }
}
\`\`\`

PROBLEM: JSON.stringify(item) serializes every trace item purely to measure its byte size. With 50k+ events this dominates CPU.

TASK: Write a function \`optimize(items, maxBytes)\` that reproduces this loop's EXACT observable behavior but faster:
- Returns { events, bytes, overflow }
- events = the items kept (same object references, same order), pushed until the running byte total would exceed maxBytes
- bytes = sum of sizes of kept events, EXACTLY matching Buffer.byteLength(JSON.stringify(item)) for each kept item
- overflow = true if any item was skipped due to the limit

The byte count MUST be exact (down to the byte), because downstream code reports artifact sizes. You may pre-size or estimate as long as the final reported total equals the sum of Buffer.byteLength(JSON.stringify(item)) over kept items.

Output ONLY a single \`\`\`js code block exporting optimize:
export function optimize(items, maxBytes) { ... }`;

const messages = [
  { role: "system", content: "You are an expert Node.js performance engineer. Precise, no hand-waving. Output code only when asked." },
  { role: "user", content: task },
];

const { execSync } = await import("node:child_process");

for (let attempt = 1; attempt <= 3; attempt++) {
  const { text, ms } = await call(messages);
  console.log(`\n=== ATTEMPT ${attempt} (${(ms / 1000).toFixed(1)}s, ${text.length} chars) ===`);
  const m = text.match(/```js\n([\s\S]*?)```/) || text.match(/```javascript\n([\s\S]*?)```/) || text.match(/```\n([\s\S]*?)```/);
  if (!m) { console.log("No code block found. Raw:", text.slice(0, 300)); break; }

  writeFileSync(new URL("candidate.mjs", import.meta.url), m[1]);
  let out;
  try {
    out = execSync("node bench/bench-trace-accounting.mjs 50000 5 bench/candidate.mjs", { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 120000 });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  console.log(out);
  if (out.includes("CORRECT: YES")) {
    console.log(`*** SUCCESS on attempt ${attempt} ***`);
    break;
  }
  messages.push({ role: "assistant", content: text });
  messages.push({ role: "user", content: `That attempt FAILED. Bench output:\n${out.slice(0, 800)}\n\nFix it. Remember: byte totals must EXACTLY equal the sum of Buffer.byteLength(JSON.stringify(item)) over kept items.` });
}
