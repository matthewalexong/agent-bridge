// model-client.mjs — shared model endpoint access for panel brains.
//
// Reads the model block from ~/.hermes/config.yaml (or
// HERMES_BRAIN_CONFIG_FILE override for tests) and exposes one ask()
// that speaks either anthropic-mode (/v1/messages) or openai-mode
// (/chat/completions) depending on api_mode. No yaml dependency.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function readHermesModel() {
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

// ask(messages, { system, maxTokens }) -> string reply text.
// messages: [{role, content}]. Anthropic-mode gets the thinking block
// disabled (this is a fast relay; reasoning burns the token budget and
// caused real "model returned no text" failures) with a bare-retry
// fallback for endpoints that reject the param.
export async function ask(messages, { system = "", maxTokens = 4096, cfg = null } = {}) {
  const m = cfg ?? readHermesModel();
  if ((m.api_mode || "").includes("anthropic")) {
    const body = {
      model: m.default,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      system,
      messages,
    };
    const doFetch = () => fetch(m.base_url.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": m.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    let res = await doFetch();
    if (res.status === 400 && body.thinking) {
      delete body.thinking;
      res = await doFetch();
    }
    if (!res.ok) throw new Error(`model endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const reply = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text).join("\n").trim();
    if (!reply) {
      const kinds = (data.content || []).map((b) => b.type).join(",") || "empty";
      throw new Error(`model returned no text (blocks: ${kinds})`);
    }
    return reply;
  }
  // OpenAI-compatible mode
  const res = await fetch(m.base_url.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${m.api_key}`,
    },
    body: JSON.stringify({
      model: m.default,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`model endpoint ${res.status}`);
  const data = await res.json();
  const reply = (data.choices?.[0]?.message?.content || "").trim();
  if (!reply) throw new Error("model returned no text");
  return reply;
}
