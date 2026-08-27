#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { loadOrCreateAuthState } from "../lib/auth-token.mjs";
import { runtimeFile } from "../lib/config.mjs";

const REQUEST = "Find me a thorough current market map of 128GB or more local AI machines with unified, shared, or coherent CPU-GPU memory for running local LLMs. Cover Apple Silicon, AMD Ryzen AI Max or Strix Halo, and NVIDIA GB10 or Grace Blackwell—including AMD's own Ryzen AI Halo Developer Platform, ASUS Ascent GX10, and DGX Spark exact offers. Show 4–5 distinct exact configurations across price points when possible. For every suggestion, verify the exact configuration, current in-stock availability or near-term delivery, current item price, seller, and provide a clickable exact product link. Do not call unknown availability in stock, and do not stop after Apple options.";
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
  const combined = `${replies.map((entry) => entry.text).join("\n")}\n${links.map((link) => `${link.title} ${link.price || ""} ${link.seller || ""} ${link.availability || ""}`).join("\n")}`;
  const checks = {
    final_status_cleared: state.status == null,
    visible_agent_update: replies.length > 0,
    four_exact_product_links: links.length >= 4,
    every_card_in_stock: links.length >= 4 && links.every((link) => /^in stock$/i.test(String(link.availability || ""))),
    every_card_has_price: links.length >= 4 && links.every((link) => /\d/.test(String(link.price || ""))),
    every_card_has_seller: links.length >= 4 && links.every((link) => String(link.seller || "").trim()),
    memory_requirement_visible: /128\s*GB|256\s*GB|512\s*GB/i.test(combined),
    amd_lane_visible: /AMD|Ryzen AI Max|Strix Halo/i.test(combined),
    amd_halo_developer_platform_visible: /AMD(?:'s own)?\s+Ryzen AI Halo Developer Platform/i.test(combined),
    nvidia_lane_visible: /NVIDIA|GB10|Grace Blackwell/i.test(combined),
    asus_gx10_visible: /ASUS\s+(?:Ascent\s+)?GX10/i.test(combined),
    dgx_spark_visible: /DGX\s+Spark/i.test(combined),
    apple_lane_accounted_for: /Apple|Mac Studio|Apple lane/i.test(combined),
    no_unknown_stock_card: links.every((link) => !/unknown|unverified/i.test(String(link.availability || ""))),
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
