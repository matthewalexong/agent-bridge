#!/usr/bin/env node
// probe-brain.mjs — replicate hermes-brain.mjs EXACTLY (same config parser,
// same fetch) with the message that failed in the panel, and dump the raw
// response shape so we see why there was no text block.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function readHermesModel() {
  const cfgPath = join(homedir(), ".hermes", "config.yaml");
  const lines = readFileSync(cfgPath, "utf8").split("\n");
  const model = {};
  let inBlock = false;
  for (const line of lines) {
    if (/^model:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (line.length && !/^\s/.test(line)) break;
      const m = line.match(/^\s{2}(\w+):\s*(.+)$/);
      if (m) model[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (!model.base_url || !model.api_key) throw new Error("could not read model block");
  return model;
}

const text = process.argv[2] || "what's the cheapest protein powder on amazon?";
const cfg = readHermesModel();
console.error("endpoint:", cfg.base_url, "model:", cfg.default, "mode:", cfg.api_mode);

const system = "You are Hermes, the agent connected to the user's Chrome via Agent Bridge. You are chatting in the browser's side panel. Answer concisely and helpfully in plain text (markdown is not rendered). Keep replies short unless asked for detail.";

const res = await fetch(cfg.base_url.replace(/\/+$/, "") + "/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": cfg.api_key,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: cfg.default,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content: text }],
  }),
  signal: AbortSignal.timeout(45_000),
});
const data = await res.json().catch(() => ({}));
console.log("HTTP", res.status);
console.log("RAW:", JSON.stringify(data, null, 2).slice(0, 3000));
const textBlocks = (data.content || []).filter((b) => b.type === "text");
const reply = textBlocks.map((b) => b.text).join("\n").trim();
console.log("\n--- VERDICT ---");
console.log("content block types:", (data.content || []).map((b) => b.type));
console.log("has text:", Boolean(reply));
console.log("stop_reason:", data.stop_reason);
console.log("extracted reply:", JSON.stringify(reply.slice(0, 300)));
