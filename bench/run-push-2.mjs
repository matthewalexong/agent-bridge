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
  { role: "system", content: "You are an expert Node.js performance engineer. Think step by step about where the CPU time actually goes before writing code." },
  { role: "user", content: `Your optimize() works but is 1.00x — zero speedup. You just rephrased the loop; JSON.stringify still runs for every item.

Think about WHY this loop is slow and what can be eliminated:
1. The loop's ONLY outputs are: kept items (by reference), the running byte total, and the overflow flag.
2. JSON.stringify does real work: it walks the object graph AND allocates one big string per item. Buffer.byteLength then walks that string AGAIN to count UTF-8 bytes.
3. The trace items are CDP events: plain objects, arrays, numbers, and strings containing only ASCII (URLs, identifiers).

You must keep the EXACT byte semantics: for every kept item, the reported bytes must equal Buffer.byteLength(JSON.stringify(item)).

Ideas to consider (pick what actually helps):
- A hand-written serializer that computes the exact serialized BYTE LENGTH while building the string in one pass, or that sizes without allocating
- Pre-sizing buffers / avoiding intermediate allocations
- Note: you cannot approximate — the total must be exact

Write \`optimize(items, maxBytes)\` returning {events, bytes, overflow} with identical results and real CPU savings. Output ONLY one \`\`\`js code block.` },
];

for (let attempt = 1; attempt <= 3; attempt++) {
  const { text, ms } = await call(messages);
  console.log(`\n=== PUSH ATTEMPT ${attempt} (${(ms/1000).toFixed(1)}s) ===`);
  const m = text.match(/```js\n([\s\S]*?)```/) || text.match(/```javascript\n([\s\S]*?)```/) || text.match(/```\n([\s\S]*?)```/);
  if (!m) { console.log("no code block:", text.slice(0, 400)); break; }
  writeFileSync("bench/candidate.mjs", m[1]);
  let out;
  try { out = execSync("node bench/bench-trace-accounting.mjs 50000 5 bench/candidate.mjs", { encoding: "utf8", timeout: 120000 }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  console.log(out.trim().split("\n").slice(-4).join("\n"));
  const ok = out.includes("CORRECT: YES");
  const speedup = out.match(/SPEEDUP: ([\d.]+)x/);
  if (ok && speedup && parseFloat(speedup[1]) >= 1.5) { console.log(`*** REAL SPEEDUP: ${speedup[1]}x on attempt ${attempt} ***`); break; }
  messages.push({ role: "assistant", content: text });
  messages.push({ role: "user", content: `Result:\n${out.slice(0, 600)}\n${ok ? "Correct but still too slow — find the actual CPU win." : "INCORRECT output — byte totals must match exactly."} Try again.` });
}
