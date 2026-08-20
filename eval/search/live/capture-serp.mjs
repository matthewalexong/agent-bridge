#!/usr/bin/env node
// Live SERP capture — Step 1 of the MVP fidelity check.
// Drives the REAL Chrome bridge (user's cookies, real pages), captures a
// snapshot, and runs it through the v6 transcription skill + judge so we can
// see whether the synthetic-tuned pipeline survives contact with reality.
//
// Usage:
//   node eval/search/live/capture-serp.mjs --url "https://www.amazon.com/s?k=whey+protein+isolate" \
//        [--query "whey protein isolate 5lb"] [--max-chars 30000]
//
// Output: eval/search/live/captures/<timestamp>.json with the raw snapshot,
// the Gemma transcription, and the judge verdict (if constraints given).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callBridge } from "../../../lib/bridge-client.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)));
const CAPTURE_DIR = path.join(root, "captures");
fs.mkdirSync(CAPTURE_DIR, { recursive: true });

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg("url");
if (!url) {
  console.error("Usage: capture-serp.mjs --url <search-url> [--query <query>]");
  process.exit(1);
}
const query = arg("query", "");
const maxChars = Number(arg("max-chars", 30000));

// 1. Status check — fail fast with a clear message if the bridge is offline.
let status;
try {
  status = await callBridge("browser.status");
} catch (e) {
  console.error(`BRIDGE OFFLINE (${e.code || e.message}). Load the extension in Chrome and reload it, then retry.`);
  process.exit(2);
}
console.log("bridge status:", JSON.stringify(status));

// 2. Open the search URL in a new tab.
const tab = await callBridge("tabs.create", { url, active: true });
const tabId = tab.tabId ?? tab.id ?? tab.tab?.id;
if (tabId == null) {
  console.error("Could not get tabId from:", JSON.stringify(tab));
  process.exit(3);
}
console.log(`opened tab ${tabId}: ${url}`);

async function closeTab() {
  try {
    await callBridge("tabs.close", { tabId });
    console.log(`closed tab ${tabId}`);
  } catch (e) {
    console.error(`WARN: could not close tab ${tabId}: ${e.message || e}`);
  }
}

try {
  // Give the page time to settle (lazy-loaded results, hydration).
  await new Promise((r) => setTimeout(r, 4000));

  // 3. Snapshot.
  const snap = await callBridge("page.snapshot", { tabId, maxChars });
  const captured = {
    capturedAt: new Date().toISOString(),
    url,
    query,
    title: snap.title,
    textLength: (snap.text || "").length,
    truncated: snap.truncated,
    elementCount: (snap.elements || []).length,
    text: snap.text,
    snapshot: snap.snapshot,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.join(CAPTURE_DIR, `${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(captured, null, 2));
  console.log(`\ncaptured -> ${outFile}`);
  console.log(`  text: ${captured.textLength} chars (truncated=${captured.truncated}), elements: ${captured.elementCount}`);
  console.log(`  first 300 chars of innerText:\n${(captured.text || "").slice(0, 300)}\n`);
  console.log(`  first 300 chars of element snapshot:\n${(captured.snapshot || "").slice(0, 300)}`);
} finally {
  // ALWAYS close the tab we opened — SERP tabs are heavy; leaks accumulate.
  await closeTab();
}
