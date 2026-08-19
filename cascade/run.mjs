#!/usr/bin/env node
// Cascade CLI: run token-frugal improvement tasks against real agent-bridge code.
// Usage: node cascade/run.mjs [--task <id>] [--list]
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cascade } from "./lib/cascade.mjs";
import { makeVerifier } from "./lib/verifier.mjs";
import { Ledger } from "./lib/ledger.mjs";
import { healthCheck } from "./lib/local-worker.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const ledger = new Ledger(path.join(root, "ledger.jsonl"));

// ---------------- Task definitions (real agent-bridge targets) ----------------

// ---------------- Generic skill-improvement task factory ----------------
// Both recursive skill tasks (TASK 4 protein extraction, TASK 5 search
// transcription) share one shape: a versioned skill markdown is the ONLY knob,
// a deterministic extract-then-judge eval is the ONLY judge. The factory gives
// each domain: compounding versions, live-grounded prompts, score-gated skip,
// anti-hardcoding verifier, and append-only persistence of the winner.
const repoRoot = path.join(root, "..");

// Run the domain's eval once against a skill. Returns { score, failures }.
//
// TRUST RULE: the parsed OVERALL score is the ONLY gate signal. A task that crashes
// during scoring prints "ERROR:" with NO ✗ lines, so gating on "no ✗ lines" would
// treat a crash as a perfect score. ERROR lines are included so the model sees crashes.
// ROBUSTNESS: EVAL_RUNS=3 so a runner that supports repeated-measurement median
// scoring (search eval) is not fooled by a temp-0 fluke. Runners that ignore
// EVAL_RUNS (protein eval) are unaffected by the extra env var.
function baselineSkillResult(skillPath, evalRunner) {
  let out;
  try {
    out = execSync(
      `EVAL_LLM_TEMPERATURE=0 EVAL_RUNS=3 node ${JSON.stringify(evalRunner)} --skill ${JSON.stringify(skillPath)}`,
      { encoding: "utf8", timeout: 600000, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (e) {
    return { score: 0, failures: `baseline eval errored: ${((e.stderr || e.stdout || e.message) + "").slice(0, 600)}` };
  }
  const m = out.match(/OVERALL:\s*([\d.]+)%/);
  const score = m ? parseFloat(m[1]) / 100 : 0;
  const failures = out.split("\n")
    .filter(l => l.includes("✗") || l.includes("ERROR:"))
    .map(l => l.trim())
    .slice(0, 12)
    .join("\n");
  return { score, failures: failures || "(none captured)" };
}

function makeSkillVerifier(verifierScript, candidatePath, threshold = 0.98) {
  return async function verify(markdown) {
    if (!markdown || markdown.trim().length < 200) {
      return { pass: false, report: "candidate too short / not a skill document" };
    }
    if (!/^#\s/m.test(markdown)) {
      return { pass: false, report: "candidate is not markdown (no # heading)" };
    }
    try {
      fs.writeFileSync(candidatePath, markdown);
      const out = execSync(
        `node ${JSON.stringify(verifierScript)} ${JSON.stringify(candidatePath)} ${threshold}`,
        { encoding: "utf8", timeout: 700000, maxBuffer: 8 * 1024 * 1024 }
      );
      return { pass: true, report: out.trim() };
    } catch (e) {
      const msg = ((e.stdout || "") + (e.stderr || "")) || String(e.message);
      return { pass: false, report: msg.slice(-1200) };
    } finally {
      try { fs.unlinkSync(candidatePath); } catch {}
    }
  };
}

// Build one recursive skill-improvement task for a domain.
// All heavy work (baseline eval) is LAZY — computed only when the task is
// actually selected, so --list and other tasks cost nothing.
function makeSkillTask({ id, skillDir, skillPattern, versionedName, evalRunner, verifierScript, candidateName, kindLabel }) {
  const dir = path.join(repoRoot, ...skillDir);
  let cached = null;
  const setup = () => {
    if (cached) return cached;
    const versions = fs.readdirSync(dir)
      .map(f => f.match(skillPattern))
      .filter(Boolean)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    if (!versions.length) throw new Error(`no versioned skills found in ${dir}`);
    const best = { name: versions[0][0], path: path.join(dir, versions[0][0]), version: Number(versions[0][1]) };
    const baseline = baselineSkillResult(best.path, evalRunner);
    cached = { best, baseline, text: fs.readFileSync(best.path, "utf8") };
    return cached;
  };
  return {
    id,
    get skip() { return setup().baseline.score >= 0.99; },
    get skipReason() {
      const { best, baseline } = setup();
      return `current best (${best.name}) scores ${(baseline.score * 100).toFixed(1)}% — no headroom to improve. Add harder tasks to the corpus first.`;
    },
    system: `You are an expert at writing precise ${kindLabel} instructions for a small language model. Output exactly one \`\`\`markdown code block containing the complete revised skill document. No prose outside it.`,
    get prompt() {
      const { best, baseline, text } = setup();
      return `Below is the CURRENT BEST ${kindLabel} skill (v${best.version}) used by a small language model.

CURRENT SKILL:
\`\`\`markdown
${text}
\`\`\`

MEASURED FAILURES from a live run of the deterministic eval against this exact skill (baseline score: ${(baseline.score * 100).toFixed(1)}%):
${baseline.failures}

TASK: Revise the skill to fix those specific failures. Rules:
- Preserve the existing output format and keys. You may ADD a new field ONLY when a measured failure names a field that the current skill never asks the model to emit (e.g. a missing "pack_count"). Do not rename or drop existing keys.
- If a listing prints a multiplier/bundle note (e.g. "(Pack of N)", "N-pack", "bundle of N"), the skill must instruct the model to transcribe the PER-UNIT size exactly as printed AND report the multiplier as a separate integer field — never multiply, fold, or total the sizes yourself; downstream code does all arithmetic.
- Make the SMALLEST targeted change that addresses the measured failures. Do not rewrite the whole document.
- The skill must stay generic: no task-specific numbers, product names, brand names, or listing IDs.

If verification fails again, the verifier will show you the exact per-task scores AND the exact failing field(s) with got/expected values. Read them and fix the specific field that is wrong.

Return the complete revised skill as one \`\`\`markdown block.`;
    },
    maxTokens: 1600,
    verify: makeSkillVerifier(verifierScript, path.join(dir, candidateName), 0.98),
    persist: (code) => {
      const { best } = setup();
      const dest = path.join(dir, versionedName(best.version + 1));
      fs.writeFileSync(dest, code);
      console.log(`  persisted winning skill -> ${dest}`);
    },
  };
}

const tasks = {
  // TASK 4: recursively improve the product fact-extraction skill.
  // Gemma improves the instructions Gemma follows; code is the only judge.
  "improve-extract-facts-skill": makeSkillTask({
    id: "improve-extract-facts-skill",
    skillDir: ["eval", "skills"],
    skillPattern: /^extract-facts-v(\d+)\.md$/,
    versionedName: (v) => `extract-facts-v${v}.md`,
    evalRunner: path.join(repoRoot, "eval", "run-eval.mjs"),
    verifierScript: path.join(repoRoot, "eval", "verify-skill.mjs"),
    candidateName: ".candidate-task4.md",
    kindLabel: "extraction",
  }),
  // TASK 5: recursively improve the search-listing transcription skill.
  // The Agent Bridge search skill proper: listing disambiguation and
  // "is this search enough?" — verdicts computed by eval/search/lib/search-judge.mjs.
  "improve-search-transcribe-skill": makeSkillTask({
    id: "improve-search-transcribe-skill",
    skillDir: ["eval", "search", "skills"],
    skillPattern: /^search-transcribe-v(\d+)\.md$/,
    versionedName: (v) => `search-transcribe-v${v}.md`,
    evalRunner: path.join(repoRoot, "eval", "search", "run-search-eval.mjs"),
    verifierScript: path.join(repoRoot, "eval", "search", "verify-search-skill.mjs"),
    candidateName: ".candidate-task5.md",
    kindLabel: "search-result transcription",
  }),
  // TASK 1: pure refactor — well within local capability
  "bounded-error-class": {
    id: "bounded-error-class",
    prompt: `In agent-bridge, lib/binary-analysis.mjs has this helper:

\`\`\`js
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
function bounded(buffer, label = "input") {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > MAX_BINARY_BYTES) {
    const error = new Error(\`\${label} exceeds \${MAX_BINARY_BYTES} bytes\`);
    error.code = "analysis_input_too_large";
    throw error;
  }
  return buffer;
}
\`\`\`

Rewrite it so the error is a proper class: define \`export class AnalysisInputTooLargeError extends Error\` whose constructor takes (label, maxBytes), sets a helpful message (\`\${label} exceeds \${maxBytes} bytes\`), sets \`this.code = "analysis_input_too_large"\`, and sets \`this.name\`. Then keep the same \`export function bounded(buffer, label)\` using that class. Do NOT change the MAX_BINARY_BYTES value or the coercion behavior.`,
    maxTokens: 1200,
    verify: makeVerifier(`
const assert = (await import("node:assert")).default;
const { bounded, AnalysisInputTooLargeError } = candidate;
assert.ok(typeof bounded === "function", "bounded not exported");
assert.ok(typeof AnalysisInputTooLargeError === "function", "error class not exported");
// small input passes through
const small = Buffer.from("hello");
assert.strictEqual(bounded(small), small);
// non-buffer coercion preserved
const coerced = bounded("abc");
assert.ok(Buffer.isBuffer(coerced) && coerced.toString() === "abc");
// oversize throws the right class with the right fields
try {
  bounded(Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.fail("should have thrown");
} catch (e) {
  assert.ok(e instanceof AnalysisInputTooLargeError, "wrong error class: " + e.constructor.name);
  assert.strictEqual(e.code, "analysis_input_too_large");
  assert.ok(/exceeds 8388608 bytes/.test(e.message), "bad message: " + e.message);
  assert.ok(e instanceof Error);
}
// custom label honored
try { bounded(Buffer.alloc(8 * 1024 * 1024 + 1), "whey-corpus"); assert.fail(); }
catch (e) { assert.ok(e.message.startsWith("whey-corpus exceeds"), e.message); }
console.log("bounded-error-class: ALL CHECKS PASS");
`),
  },

  // TASK 2: bounded ring deque — local typically FAILS (perf reasoning), frontier consulted
  "bounded-ring-deque": {
    id: "bounded-ring-deque",
    prompt: `agent-bridge's cdp-analysis.mjs tracks completed requests with a plain array and does \`state.completedRequests.shift()\` when length exceeds 5000 — an O(n) operation per event on a hot path.

Write \`export class BoundedDeque\` — a fixed-capacity FIFO using a preallocated ring buffer:
- \`new BoundedDeque(capacity)\`
- \`.push(item)\` — append; when full, OVERWRITE the oldest slot (the oldest item is dropped). O(1).
- \`.size\` — current count
- \`.toArray()\` — items oldest→newest
- \`.clear()\`
- must hold objects by reference, and toArray() order must be oldest→newest after any number of pushes.
Use a plain Array of capacity slots plus head/count bookkeeping. Do not use shift() or splice().`,
    maxTokens: 1600,
    verify: makeVerifier(`
const assert = (await import("node:assert")).default;
const { BoundedDeque } = candidate;
assert.ok(typeof BoundedDeque === "function", "BoundedDeque not exported");
const d = new BoundedDeque(3);
assert.strictEqual(d.size, 0);
d.push("a"); d.push("b"); d.push("c");
assert.deepStrictEqual(d.toArray(), ["a", "b", "c"]);
d.push("d"); // drops "a"
assert.deepStrictEqual(d.toArray(), ["b", "c", "d"]);
assert.strictEqual(d.size, 3);
d.push("e"); d.push("f");
assert.deepStrictEqual(d.toArray(), ["d", "e", "f"]);
d.clear();
assert.strictEqual(d.size, 0);
assert.deepStrictEqual(d.toArray(), []);
// reference preservation + wraparound stress
const d2 = new BoundedDeque(4);
const objs = [];
for (let i = 0; i < 1000; i++) { const o = { i }; objs.push(o); d2.push(o); }
const arr = d2.toArray();
assert.strictEqual(arr.length, 4);
assert.strictEqual(arr[0], objs[996]);
assert.strictEqual(arr[3], objs[999]);
// capacity 1 edge case
const d3 = new BoundedDeque(1);
d3.push(1); d3.push(2);
assert.deepStrictEqual(d3.toArray(), [2]);
console.log("bounded-ring-deque: ALL CHECKS PASS");
`),
  },

  // TASK 3: trace byte-walker — the exact problem local failed earlier
  "trace-byte-walker": {
    id: "trace-byte-walker",
    frontierMaxTokens: 16000,
    prompt: `Optimize this hot loop from agent-bridge cdp-analysis.mjs (runs for every Tracing.dataCollected event, 50k+ items):

\`\`\`js
for (const item of items) {
  const bytes = Buffer.byteLength(JSON.stringify(item));
  if (bytesAccum + bytes > maxBytes) { overflow = true; break; }
  events.push(item); bytesAccum += bytes;
}
\`\`\`

Write \`export function optimize(items, maxBytes)\` returning \`{ events, bytes, overflow }\` with EXACTLY the same results (same kept refs/order; each kept item contributes exactly Buffer.byteLength(JSON.stringify(item)); overflow semantics: stop at first exceeding item).

The win: JSON.stringify of these CDP items (plain objects/arrays/ASCII strings/numbers) allocates a big string per item purely to measure it. Instead compute the serialized BYTE LENGTH without allocating: walk the structure recursively; for ASCII strings the JSON output length equals the string's char count plus 2 quotes plus escape expansions (JSON.stringify escapes control chars as \\\\uXXXX / \\\\n / \\\\t etc., and ", \\\\); numbers use String(n).length; keys are quoted strings; structural chars , : { } [ ] each count 1. Sum exactly.

You may keep JSON.stringify as a FALLBACK for strings containing non-ASCII (charCodeAt >= 128): Buffer.byteLength(JSON.stringify(s)) — but the fast path must avoid it for pure-ASCII structures.`,
    maxTokens: 2400,
    verify: makeVerifier(`
const assert = (await import("node:assert")).default;
const { optimize } = candidate;
assert.ok(typeof optimize === "function", "optimize not exported");
function makeItems(n) {
  const cats = ["devtools.timeline", "v8", "blink.user_timing", "loading"];
  const names = ["FunctionCall", "EvaluateScript", "ParseHTML", "Layout", "RecalculateStyles"];
  const items = new Array(n);
  for (let i = 0; i < n; i++) items[i] = {
    pid: 12345, tid: 259, ts: 100000000 + i * 17, ph: "X",
    cat: cats[i % 4], name: names[i % 5], dur: 50 + (i % 900),
    args: { data: { scriptName: "https://example.com/app." + (i % 7) + ".js", lineNumber: i % 500,
      url: "https://example.com/page?session=abc" + (i % 1000),
      stack: [{ fn: "render", ln: 100 + (i % 50) }, { fn: "commit", ln: 240 }] } },
  };
  return items;
}
const items = makeItems(20000);
// exact-bytes correctness against the reference implementation
function reference(items, maxBytes) {
  const events = []; let bytes = 0, overflow = false;
  for (const item of items) {
    const b = Buffer.byteLength(JSON.stringify(item));
    if (bytes + b > maxBytes) { overflow = true; break; }
    events.push(item); bytes += b;
  }
  return { events, bytes, overflow };
}
const ref = reference(items, Infinity);
const got = optimize(items, Infinity);
assert.strictEqual(got.bytes, ref.bytes, "byte mismatch: " + got.bytes + " vs " + ref.bytes);
assert.strictEqual(got.events.length, ref.events.length);
assert.strictEqual(got.events[0], ref.events[0]);
assert.strictEqual(got.overflow, false);
// overflow boundary: cut at exactly the same item
const cutBytes = ref.events.slice(0, 500).reduce((s, it) => s + Buffer.byteLength(JSON.stringify(it)), 0) + 1;
const refCut = reference(items, cutBytes);
const gotCut = optimize(items, cutBytes);
assert.strictEqual(gotCut.events.length, refCut.events.length, "overflow cut mismatch");
assert.strictEqual(gotCut.bytes, refCut.bytes);
assert.strictEqual(gotCut.overflow, true);
// strings with escapes must size correctly
const tricky = [{ msg: 'line1\\nline2 "quoted" \\\\backslash', tab: "a\\tb", arr: [1, 2, { nested: "x" }] }];
const tRef = reference(tricky, Infinity);
const tGot = optimize(tricky, Infinity);
assert.strictEqual(tGot.bytes, tRef.bytes, "escape-byte mismatch: " + tGot.bytes + " vs " + tRef.bytes);
// NOTE: no perf gate. Empirically proven (2026-08-18): V8's native JSON.stringify
// beats any pure-JS recursive byte-walker on this workload (~0.42x). The real fix
// for this hot path is architectural (batch accounting / sampling), which is a
// frontier-model design decision, not a local-model rewrite. Correctness only:
console.log("trace-byte-walker: ALL CHECKS PASS (correctness)");
`),
  },
};

// ---------------- Runner ----------------
const args = process.argv.slice(2);
if (args.includes("--list")) {
  console.log("Available tasks:", Object.keys(tasks).join(", "));
  process.exit(0);
}
const selected = args.includes("--task") ? [args[args.indexOf("--task") + 1]] : Object.keys(tasks);

if (!(await healthCheck())) {
  console.error("local model server not reachable at 127.0.0.1:8080 — start it first");
  process.exit(1);
}

console.log(`Running ${selected.length} task(s) through the cascade\n`);
for (const id of selected) {
  const task = tasks[id];
  if (!task) { console.error(`unknown task: ${id}`); continue; }
  if (task.skip) {
    console.log(`━━━ ${id} ━━━`);
    console.log(`  SKIPPED: ${task.skipReason}\n`);
    continue;
  }
  console.log(`━━━ ${id} ━━━`);
  const result = await cascade(task, task.verify, ledger, {
    localAttempts: 3,
    localRepairAttempts: 2,
    onEvent: (e) => {
      if (e.phase === "local-try") console.log(`  [local attempt ${e.attempt}] ${(e.ms / 1000).toFixed(1)}s, ${e.tokens} tok`);
      else if (e.phase === "verify") console.log(`  [verify] ${e.pass ? "PASS ✓" : "FAIL ✗"}`);
      else if (e.phase === "escalate") console.log("  [escalating to frontier — local exhausted]");
      else if (e.phase === "frontier") console.log(`  [frontier consult] ${(e.ms / 1000).toFixed(1)}s, ${e.tokens} tok`);
      else if (e.phase === "verify-frontier") console.log(`  [frontier code verify] ${e.pass ? "PASS ✓" : "FAIL ✗"}`);
      else if (e.phase === "verify-repair") console.log(`  [local repair ${e.repair}] ${e.pass ? "PASS ✓" : "FAIL ✗"}`);
    },
  });
  console.log(`  RESULT: ${result.status}${result.report && result.status !== "unresolved" ? " — " + result.report.split("\n").pop() : ""}`);
  // Persist the winning artifact (skills write to eval/skills/, code tasks can opt in)
  if (result.status !== "unresolved" && result.code && typeof task.persist === "function") {
    task.persist(result.code);
  }
}

ledger.print();
