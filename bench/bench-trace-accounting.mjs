#!/usr/bin/env node
// Benchmark: the tracing event-accounting loop from lib/cdp-analysis.mjs (lines 248-258).
// Current implementation serializes EVERY trace item with JSON.stringify just to
// measure its byte size — this is the hot path when collecting Chrome traces.

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

// --- CURRENT implementation (verbatim semantics from cdp-analysis.mjs) ---
function currentLoop(items) {
  const state = { trace: { events: [], bytes: 0, overflow: false } };
  for (const item of items || []) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (state.trace.bytes + bytes > MAX_ARTIFACT_BYTES) {
      state.trace.overflow = true;
      break;
    }
    state.trace.events.push(item);
    state.trace.bytes += bytes;
  }
  return state.trace;
}

// --- Realistic Chrome trace events (cat=devtools.timeline style) ---
function makeItems(n) {
  const cats = ["devtools.timeline", "v8", "blink.user_timing", "loading"];
  const names = ["FunctionCall", "EvaluateScript", "ParseHTML", "Layout", "RecalculateStyles",
                 "UpdateLayoutTree", "Paint", "Commit", "TimerFire", "XHRReadyStateChange"];
  const items = new Array(n);
  for (let i = 0; i < n; i++) {
    items[i] = {
      pid: 12345, tid: 259, ts: 100000000 + i * 17,
      ph: "X", cat: cats[i % cats.length], name: names[i % names.length],
      dur: 50 + (i % 900),
      args: {
        data: {
          scriptName: "https://example.com/static/app.chunk." + (i % 7) + ".js",
          lineNumber: i % 500, columnNumber: i % 120,
          url: "https://example.com/page?session=abc" + (i % 1000),
          stackTrace: [
            { functionName: "render", scriptId: "12", url: "https://example.com/app.js", lineNumber: 100 + (i % 50), columnNumber: 12 },
            { functionName: "commit", scriptId: "12", url: "https://example.com/app.js", lineNumber: 240, columnNumber: 4 },
          ],
        },
      },
    };
  }
  return items;
}

const N = parseInt(process.argv[2] || "50000", 10);
const RUNS = parseInt(process.argv[3] || "5", 10);

// Load candidate if provided (must export function optimize(items, MAX_BYTES))
let candidate = null;
if (process.argv[4]) {
  const { resolve } = await import("node:path");
  candidate = (await import(resolve(process.argv[4]))).optimize;
}

const items = makeItems(N);

// Warmup + timed runs
function bench(fn, label) {
  fn(items); // warmup
  let best = Infinity, total = 0, lastResult;
  for (let r = 0; r < RUNS; r++) {
    const t0 = process.hrtime.bigint();
    lastResult = fn(items);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    total += ms;
    if (ms < best) best = ms;
  }
  console.log(`${label.padEnd(10)} n=${N}  best=${best.toFixed(1)}ms  avg=${(total / RUNS).toFixed(1)}ms  events=${lastResult.events.length}  bytes=${lastResult.bytes}  overflow=${lastResult.overflow}`);
  return { best, lastResult };
}

const base = bench(currentLoop, "current");

if (candidate) {
  const cand = bench((xs) => candidate(xs, MAX_ARTIFACT_BYTES), "optimized");
  // Correctness check against current
  const ok =
    cand.lastResult.events.length === base.lastResult.events.length &&
    cand.lastResult.bytes === base.lastResult.bytes &&
    cand.lastResult.overflow === base.lastResult.overflow &&
    cand.lastResult.events[0] === base.lastResult.events[0] && // same refs, same order
    cand.lastResult.events[cand.lastResult.events.length - 1] === base.lastResult.events[base.lastResult.events.length - 1];
  console.log(`\nSPEEDUP: ${(base.best / cand.best).toFixed(2)}x   CORRECT: ${ok ? "YES" : "*** NO — MISMATCH ***"}`);
  if (!ok) {
    console.log("  current:", base.lastResult.events.length, base.lastResult.bytes, base.lastResult.overflow);
    console.log("  candidate:", cand.lastResult.events.length, cand.lastResult.bytes, cand.lastResult.overflow);
    process.exit(1);
  }
}
