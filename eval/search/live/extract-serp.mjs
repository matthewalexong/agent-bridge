#!/usr/bin/env node
// Deterministic SERP extraction driver — stage 1 of the MVP pipeline.
// Injects extract-serp.js into a live Amazon SERP via the bridge's raw CDP
// channel and returns structured listings. No LLM anywhere in this path.
//
// Usage (CLI):
//   node eval/search/live/extract-serp.mjs [--url <serp-url>]
// Import:
//   import { extractSerp } from "./extract-serp.mjs";
//
// The tab is ALWAYS closed, on every exit path.

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

async function closeTab(tabId, label = "[extract]") {
  if (tabId == null) return;
  try {
    await callBridge("tabs.close", { tabId });
    console.error(`${label} closed tab ${tabId}`);
  } catch (e) {
    console.error(`${label} WARN: could not close tab ${tabId}: ${e.message || e}`);
  }
}

// Core: open SERP, extract, close. Returns { listings, resultCount, url }.
export async function extractSerp(url, label = "[extract]") {
  console.error(`${label} opening ${url}`);
  const tab = await callBridge("tabs.create", { url });
  const tabId = tab.tabId ?? tab.id;
  console.error(`${label} tab ${tabId}, waiting for page settle...`);

  try {
    await new Promise((r) => setTimeout(r, 3500));

    const attach = await callBridge("raw.attach", { tabId, captureEvents: false });
    const sessionId = attach.sessionId || attach.rawSessionId;
    if (!sessionId) throw new Error(`no sessionId in attach result: ${JSON.stringify(attach)}`);

    const evalRes = await callBridge("raw.send", {
      sessionId,
      method: "Runtime.evaluate",
      params: { expression: EXTRACT_JS, returnByValue: true },
    });
    await callBridge("raw.detach", { sessionId });

    const inner = evalRes?.result?.result?.value ?? evalRes?.result?.value ?? evalRes?.value;
    if (!inner) throw new Error(`extractor returned nothing: ${JSON.stringify(evalRes).slice(0, 500)}`);
    return inner;
  } finally {
    // ALWAYS close the tab we opened — Amazon tabs are heavy and leaks
    // accumulate across runs and can exhaust memory.
    await closeTab(tabId, label);
  }
}

// CLI entry only.
if (process.argv[1] && process.argv[1].endsWith("extract-serp.mjs")) {
  const url = arg("url", "https://www.amazon.com/s?k=whey+protein+isolate+5lb");
  extractSerp(url).then((inner) => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(join(__dirname, "captures"), { recursive: true });
    const outPath = join(__dirname, "captures", `extract-${ts}.json`);
    writeFileSync(outPath, JSON.stringify({ capturedAt: new Date().toISOString(), url, listings: inner }, null, 2));
    console.error(`[extract] wrote ${outPath}`);
    console.log(JSON.stringify({ url, count: inner?.listings?.length ?? (Array.isArray(inner) ? inner.length : null), outPath }, null, 2));
  }).catch((e) => {
    console.error("FATAL:", e.message || e);
    process.exit(1);
  });
}
