import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ENDPOINT = "http://127.0.0.1:8080/v1/chat/completions";
async function call(messages, maxTokens = 2000) {
  const t0 = Date.now();
  const resp = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3.8-9b", messages, max_tokens: maxTokens, temperature: 0.0 }) });
  const data = await resp.json();
  return { text: data.choices?.[0]?.message?.content || "", ms: Date.now() - t0 };
}

const messages = [
  { role: "system", content: "You are an expert Node.js performance engineer. Output exactly one ```js code block with an exported function." },
  { role: "user", content: `Write an optimized \`export function optimize(items, maxBytes)\` (MUST have the export keyword) for this hot loop:

for (const item of items) {
  const bytes = Buffer.byteLength(JSON.stringify(item));
  if (bytesAccum + bytes > maxBytes) { overflow = true; break; }
  events.push(item); bytesAccum += bytes;
}
return { events, bytes: bytesAccum, overflow };

Requirements:
- EXACT same result: same kept items (by reference, same order), same byte totals (each kept item contributes Buffer.byteLength(JSON.stringify(item))), same overflow semantics (stop at first item that would exceed).
- Must be FASTER than JSON.stringify per item. Consider: these CDP trace items are plain objects with ASCII-only strings. A custom recursive size-only walker that computes JSON's exact serialized byte length WITHOUT allocating the full string per item is the known win here: JSON.stringify output for an object with ASCII string values has a byte length you can compute character-by-character without building the string — count chars + quotes + structural chars, handling JSON's string escapes.
- Note Buffer.byteLength(JSON.stringify(x)) for ASCII strings equals the string length, since JSON.stringify escapes non-ASCII and control chars as \\uXXXX.

Output ONLY the \`\`\`js block.` },
];

for (let attempt = 1; attempt <= 3; attempt++) {
  const { text, ms } = await call(messages);
  console.log(`\n=== ATTEMPT ${attempt} (${(ms/1000).toFixed(1)}s) ===`);
  const m = text.match(/```(?:js|javascript)?\n([\s\S]*?)```/);
  if (!m) { console.log("no code block:", text.slice(0, 300)); break; }
  let code = m[1];
  if (!code.includes("export function") && !code.includes("export const")) code = code.replace("function optimize", "export function optimize");
  writeFileSync("bench/candidate.mjs", code);
  let out;
  try { out = execSync("node bench/bench-trace-accounting.mjs 50000 5 bench/candidate.mjs", { encoding: "utf8", timeout: 120000 }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  console.log(out.split("\n").filter(l => l.includes("current") || l.includes("optimized") || l.includes("SPEEDUP") || l.includes("Error") || l.includes("error")).join("\n") || out.slice(0, 800));
  const ok = out.includes("CORRECT: YES");
  const sp = out.match(/SPEEDUP: ([\d.]+)x/);
  if (ok && sp && parseFloat(sp[1]) >= 1.5) { console.log(`*** REAL SPEEDUP ${sp[1]}x on attempt ${attempt} ***`); break; }
  messages.push({ role: "assistant", content: text });
  messages.push({ role: "user", content: `Output from the benchmark run:\n${out.slice(0, 1000)}\n${ok ? "Correct but not fast enough yet." : "It failed or produced wrong results — the export keyword is required and byte totals must be exact."} Fix and output the corrected \`\`\`js block only.` });
}
