// Frontier client: escalates to the user's Hermes main model via its configured endpoint.
// Reads endpoint/key/model through `hermes config get` — no hardcoded secrets.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached = null;
function loadConfig() {
  if (cached) return cached;
  const get = (key, optional = false) => {
    try { return execSync(`hermes config get ${key} 2>/dev/null`, { encoding: "utf8" }).trim(); }
    catch (error) { if (optional) return ""; throw error; }
  };
  const provider = get("model.provider", true);
  let apiKey = get("model.api_key", true);
  // Hermes keeps provider credentials in ~/.hermes/.env rather than config.
  // Resolve the current provider's key without printing or persisting it.
  if (!apiKey && provider) {
    try {
      const env = readFileSync(join(homedir(), ".hermes", ".env"), "utf8");
      const keyName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
      const line = env.split(/\r?\n/).find((entry) => entry.startsWith(`${keyName}=`));
      if (line) apiKey = line.slice(keyName.length + 1).trim().replace(/^['"]|['"]$/g, "");
    } catch {}
  }
  const cfg = {
    baseUrl: get("model.base_url"),
    apiKey,
    apiMode: get("model.api_mode", true) || (provider === "xai" ? "openai_chat_completions" : "anthropic_messages"),
    model: get("model.default"),
    provider,
  };
  if (!cfg.baseUrl || !cfg.apiKey) throw new Error("frontier endpoint not configured in hermes config");
  cached = cfg;
  return cfg;
}

export async function frontierCall(messages, { maxTokens = 4000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Shrink budget on retries — large max_tokens has triggered ECONNRESET on the gateway.
      const budget = attempt === 0 ? maxTokens : Math.max(2000, Math.floor(maxTokens / 2));
      return await frontierCallOnce(messages, budget);
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

async function frontierCallOnce(messages, maxTokens) {
  const cfg = loadConfig();
  const t0 = Date.now();
  if (cfg.apiMode.includes("openai")) {
    const base = cfg.baseUrl.replace(/\/$/, "");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, temperature: 0, messages }),
    });
    if (!resp.ok) throw new Error(`frontier HTTP ${resp.status} @ ${url}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || "").trim();
    if (!text) throw new Error("frontier returned no text from OpenAI-compatible endpoint");
    return {
      text,
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      ms: Date.now() - t0,
      model: cfg.model,
      tier: "frontier",
    };
  }
  // Anthropic Messages API shape (config's api_mode=anthropic_messages)
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const rest = messages.filter((m) => m.role !== "system");
  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: rest.map((m) => ({ role: m.role, content: m.content })),
  };
  const base = cfg.baseUrl.replace(/\/$/, "");
  // Some gateways are the messages endpoint themselves; others want /v1/messages appended.
  const candidates = base.endsWith("/v1/messages") || base.endsWith("/messages")
    ? [base]
    : [base + "/v1/messages", base];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        lastErr = new Error(`frontier HTTP ${resp.status} @ ${url}: ${(await resp.text()).slice(0, 200)}`);
        continue;
      }
      const data = await resp.json();
      const blocks = data.content || [];
      let text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      // Reasoning models (e.g. qwen3.8-max on Aliyun) can burn the whole
      // max_tokens budget on internal thinking and emit zero text blocks.
      // Fall back to the thinking content so the escalation tier is never
      // silently empty; if there's nothing at all, treat it as a transient
      // failure the retry loop can recover from.
      if (!text) {
        text = blocks.filter((b) => b.type === "thinking" || b.type === "reasoning")
          .map((b) => b.thinking ?? b.text ?? "").join("\n").trim();
      }
      if (!text) {
        throw new Error(
          `frontier returned no text (stop=${data.stop_reason}, blocks=${blocks.length}, out=${data.usage?.output_tokens}) — likely a reasoning model that spent its whole budget on thinking`
        );
      }
      return {
        text,
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        ms: Date.now() - t0,
        model: cfg.model,
        tier: "frontier",
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("frontier call failed");
}
