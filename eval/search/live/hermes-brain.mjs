#!/usr/bin/env node
// hermes-brain.mjs — panel reply brain using the model THIS Hermes instance
// is configured with. Reads ~/.hermes/config.yaml live on every call, so the
// panel always answers with "whatever the model is set to."
//
// Contract (matches panel-watcher --handler-cmd):
//   stdin  = user message text
//   stdout = reply text
//   exit 0 = success; non-zero = failure (watcher posts an error notice)
//
// Supports both anthropic-mode (/v1/messages) and openai-mode
// (/v1/chat/completions) providers based on config.yaml's api_mode.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Read the model block from Hermes config (no yaml dependency) ---
// HERMES_BRAIN_CONFIG_FILE overrides the config path for tests, so a mock
// endpoint can be exercised without touching the real Hermes config.
function readHermesModel() {
  const cfgPath = process.env.HERMES_BRAIN_CONFIG_FILE
    || join(homedir(), ".hermes", "config.yaml");
  const lines = readFileSync(cfgPath, "utf8").split("\n");
  const model = {};
  let inBlock = false;
  for (const line of lines) {
    if (/^model:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (line.length && !/^\s/.test(line)) break; // next top-level key
      const m = line.match(/^\s{2}(\w+):\s*(.+)$/);
      if (m) model[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (!model.base_url || !model.api_key) {
    throw new Error("could not read model block from ~/.hermes/config.yaml");
  }
  return model;
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) { console.error("hermes-brain: empty message"); process.exit(1); }

  const cfg = readHermesModel();
  const system = "You are Hermes, the agent connected to the user's Chrome via Agent Bridge. You are chatting in the browser's side panel. Answer concisely and helpfully in plain text (markdown is not rendered). Keep replies short unless asked for detail.";

  if ((cfg.api_mode || "").includes("anthropic")) {
    const body = {
      model: cfg.default,
      // Generous budget: on reasoning models the "thinking" block can
      // consume most of max_tokens, leaving NO text block at all. 600 was
      // too small and caused real "model returned no text" failures on
      // longer queries.
      max_tokens: 4096,
      // This panel brain is a fast chat relay, not a reasoning task.
      // Reasoning blocks add seconds of latency and burn the token budget;
      // disable them if the endpoint supports it (ignored otherwise).
      thinking: { type: "disabled" },
      system,
      messages: [{ role: "user", content: text }],
    };
    let res = await fetch(cfg.base_url.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    // Fallback: some endpoints reject the thinking param with 400 — retry bare.
    if (res.status === 400 && body.thinking) {
      delete body.thinking;
      res = await fetch(cfg.base_url.replace(/\/+$/, "") + "/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
    }
    if (!res.ok) throw new Error(`model endpoint ${res.status}`);
    const data = await res.json();
    const reply = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text).join("\n").trim();
    if (!reply) {
      const kinds = (data.content || []).map((b) => b.type).join(",") || "empty";
      throw new Error(`model returned no text (blocks: ${kinds})`);
    }
    process.stdout.write(reply);
  } else {
    // OpenAI-compatible mode
    const res = await fetch(cfg.base_url.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify({
        model: cfg.default,
        max_tokens: 600,
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`model endpoint ${res.status}`);
    const data = await res.json();
    const reply = (data.choices?.[0]?.message?.content || "").trim();
    if (!reply) throw new Error("model returned no text");
    process.stdout.write(reply);
  }
}

main().catch((e) => { console.error(`hermes-brain: ${e.message}`); process.exit(1); });
