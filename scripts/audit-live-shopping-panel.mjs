#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { loadOrCreateAuthState } from "../lib/auth-token.mjs";
import { runtimeFile } from "../lib/config.mjs";

const REQUEST = "Find me a thorough current market map of 128GB or more local AI machines with unified, shared, or coherent CPU-GPU memory for running local LLMs. Cover Apple Silicon, AMD Ryzen AI Max or Strix Halo, and NVIDIA GB10 or Grace Blackwell—including representative Ryzen AI Max+ 395 systems, ASUS Ascent GX10, and DGX Spark exact offers. Show 4–5 distinct exact configurations across price points when possible. For every suggestion, verify the exact configuration, current in-stock availability or near-term delivery, current item price, seller, and provide a clickable exact product link. Do not call unknown availability in stock, and do not stop after Apple options.";
const timeoutMs = Number(process.env.AGENT_BRIDGE_AUDIT_TIMEOUT_MS || 12 * 60 * 1000);
const settleMs = 12_000;

const runtime = JSON.parse(await fs.readFile(runtimeFile(), "utf8"));
const auth = await loadOrCreateAuthState();

async function rpc(method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json();
  if (!payload.ok) throw Object.assign(new Error(payload.error?.message || `${method} failed`), { code: payload.error?.code });
  return payload.result;
}

function uniqueProductLinks(entries) {
  const links = entries.flatMap((entry) => Array.isArray(entry.links) ? entry.links : []);
  const byUrl = new Map();
  for (const link of links) {
    let url;
    try { url = new URL(link.url); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (/\/search(?:page)?\b|[?&](?:q|query|search|st)=/i.test(`${url.pathname}${url.search}`)) continue;
    byUrl.set(url.href, link);
  }
  return [...byUrl.values()];
}

function audit(state, userEntry) {
  const start = state.transcript.findIndex((entry) => entry.id === userEntry.id);
  const replies = start >= 0 ? state.transcript.slice(start + 1).filter((entry) => entry.role === "agent") : [];
  const links = uniqueProductLinks(replies);
  const inStockLinks = links.filter((link) => /^in stock$/i.test(String(link.availability || "")));
  const combined = `${replies.map((entry) => entry.text).join("\n")}\n${links.map((link) => `${link.title} ${link.price || ""} ${link.seller || ""} ${link.availability || ""}`).join("\n")}`;
  const appleExactLink = links.some((link) => {
    try {
      const url = new URL(link.url);
      return /(^|\.)apple\.com$/i.test(url.hostname) && /\/shop\/buy-mac\/mac-studio\/[^/?#]+/i.test(url.pathname);
    } catch { return false; }
  });
  const checks = {
    final_status_cleared: state.status == null,
    visible_agent_update: replies.length > 0,
    four_exact_in_stock_product_links: inStockLinks.length >= 4,
    every_in_stock_card_has_price: inStockLinks.length >= 4 && inStockLinks.every((link) => /\d/.test(String(link.price || ""))),
    every_in_stock_card_has_seller: inStockLinks.length >= 4 && inStockLinks.every((link) => String(link.seller || "").trim()),
    memory_requirement_visible: /128\s*GB|256\s*GB|512\s*GB/i.test(combined),
    amd_lane_visible: /AMD|Ryzen AI Max|Strix Halo/i.test(combined),
    amd_strix_halo_ecosystem_explained: /(?:many|multiple|several|a range of).*?(?:Ryzen AI Max\+?\s*395|Strix Halo)|(?:Ryzen AI Max\+?\s*395|Strix Halo).*?(?:many|multiple|several|a range of)/is.test(combined),
    amd_focused_follow_up_offered: /(?:dig|search|compare|find|research).*?(?:cheapest|lower-cost|more|Strix Halo|Ryzen AI Max)/is.test(combined),
    nvidia_lane_visible: /NVIDIA|GB10|Grace Blackwell/i.test(combined),
    asus_gx10_visible: /ASUS\s+(?:Ascent\s+)?GX10/i.test(combined),
    dgx_spark_visible: /DGX\s+Spark/i.test(combined),
    apple_exact_configuration_named: /Mac Studio[\s\S]{0,180}M\d+\s+(?:Max|Ultra)[\s\S]{0,180}128\s*GB/i.test(combined) || /M\d+\s+(?:Max|Ultra)[\s\S]{0,180}Mac Studio[\s\S]{0,180}128\s*GB/i.test(combined),
    apple_concrete_availability_state: /(?:Mac Studio|Apple)[\s\S]{0,240}(?:pre-?order|back-?order|out of stock|unavailable|available starting|in stock|ships? by|delivery by)/i.test(combined),
    apple_exact_configuration_link: appleExactLink,
    no_unknown_in_stock_card: inStockLinks.every((link) => !/unknown|unverified/i.test(String(link.availability || ""))),
  };
  return { passed: Object.values(checks).every(Boolean), checks, links, replies };
}

await rpc("panel.status", { text: "" });
let sent;
try {
  sent = await rpc("panel.send", { text: REQUEST });
} catch (error) {
  if (error.code === "method_not_found") {
    console.error("The loaded extension does not include authenticated panel.send yet. Reload Agent Bridge once, then rerun this audit.");
    process.exit(3);
  }
  throw error;
}

console.log(`Submitted ${sent.entry.id} through the normal panel conversation path.`);
const deadline = Date.now() + timeoutMs;
let lastSignature = "";
let stableSince = Date.now();
let latest;

while (Date.now() < deadline) {
  const state = await rpc("panel.get");
  latest = audit(state, sent.entry);
  const signature = JSON.stringify({ status: state.status, transcript: state.transcript.map((entry) => [entry.id, entry.role, entry.text, entry.links?.length || 0]) });
  if (signature !== lastSignature) {
    lastSignature = signature;
    stableSince = Date.now();
    const status = state.status?.text || "idle";
    console.log(`[${new Date().toISOString()}] ${status}; ${latest.replies.length} agent post(s), ${latest.links.length} exact product link(s)`);
  }
  if (latest.passed) break;
  if (state.status == null && latest.replies.length > 0 && Date.now() - stableSince >= settleMs) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

const report = {
  passed: latest?.passed === true,
  checks: latest?.checks || {},
  products: (latest?.links || []).map(({ title, url, price, seller, availability }) => ({ title, url, price, seller, availability })),
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 2);
