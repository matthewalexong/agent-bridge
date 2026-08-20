#!/usr/bin/env node
// Deterministic SERP extraction driver — the production path that replaces
// LLM transcription. Injects extract-serp.js into a live Amazon SERP via the
// bridge's raw CDP channel and returns structured listings.
//
// Usage:
//   node eval/search/live/extract-serp.mjs [--url <serp-url>] [--max-tokens 0]
//
// Output: JSON listings on stdout + a capture file in captures/.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callBridge } from "../../../lib/bridge-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTRACT_JS = readFileSync(join(__dirname, "extract-serp.js"), "utf8");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const url = arg("url", "https://www.amazon.com/s?k=whey+protein+isolate+5lb");

// Module-scope so signal handlers can still clean up.
let activeTabId = null;

async function closeTab(tabId) {
  if (tabId == null) return;
  try {
    await callBridge("tabs.close", { tabId });
    console.error(`[extract] closed tab ${tabId}`);
  } catch (e) {
    console.error(`[extract] WARN: could not close tab ${tabId}: ${e.message || e}`);
  }
}

// If we're killed mid-run (Ctrl-C, timeout kill), still close the tab before dying.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.error(`[extract] received ${sig}, cleaning up tab...`);
    await closeTab(activeTabId);
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

async function main() {
  // 1. Open the SERP in a fresh tab.
  console.error(`[extract] opening ${url}`);
  const tab = await callBridge("tabs.create", { url });
  const tabId = tab.tabId ?? tab.id;
  activeTabId = tabId;
  console.error(`[extract] tab ${tabId}, waiting for page settle...`);

  try {
    // 2. Wait for results to render (Amazon lazy-loads below the fold).
    await new Promise((r) => setTimeout(r, 3500));

    // 3. Attach a raw CDP session to the tab.
    console.error(`[extract] attaching CDP...`);
    const attach = await callBridge("raw.attach", { tabId, captureEvents: false });
    const sessionId = attach.sessionId || attach.rawSessionId;
    if (!sessionId) throw new Error(`no sessionId in attach result: ${JSON.stringify(attach)}`);

    // 4. Evaluate the extraction script.
    console.error(`[extract] evaluating DOM extractor...`);
    const evalRes = await callBridge("raw.send", {
      sessionId,
      method: "Runtime.evaluate",
      params: {
        expression: EXTRACT_JS, // self-contained IIFE; its completion value is the result
        returnByValue: true,
      },
    });

    // 5. Detach.
    await callBridge("raw.detach", { sessionId });

    // 6. Unwrap the CDP result.
    const inner = evalRes?.result?.result?.value ?? evalRes?.result?.value ?? evalRes?.value;
    if (!inner) {
      console.error("[extract] FAILED — raw response:");
      console.error(JSON.stringify(evalRes, null, 2).slice(0, 2000));
      process.exitCode = 1;
      return;
    }

    // 7. Persist.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(join(__dirname, "captures"), { recursive: true });
    const outPath = join(__dirname, "captures", `extract-${ts}.json`);
    writeFileSync(outPath, JSON.stringify({ capturedAt: new Date().toISOString(), url, listings: inner }, null, 2));

    console.error(`[extract] wrote ${outPath}`);
    console.log(JSON.stringify({ url, tabId, count: Array.isArray(inner) ? inner.length : null, outPath }, null, 2));
    console.error(`[extract] sample:`);
    console.error(JSON.stringify(Array.isArray(inner) ? inner.slice(0, 3) : inner, null, 2).slice(0, 3000));
  } finally {
    // ALWAYS close the tab we opened — Amazon tabs are heavy and leaks
    // accumulate across runs and can exhaust memory.
    await closeTab(tabId);
    activeTabId = null;
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message || e);
  process.exit(1);
});
