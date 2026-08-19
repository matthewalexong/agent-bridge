// Local model worker: calls the llama.cpp server, extracts code, tracks tokens.
const ENDPOINT = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1/chat/completions";
const MODEL = process.env.LOCAL_LLM_MODEL || "gemma-4-E2B-it";

export async function localCall(messages, { maxTokens = 2000, temperature = 0.0 } = {}) {
  const t0 = Date.now();
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }),
  });
  if (!resp.ok) throw new Error(`local model HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return {
    text: data.choices?.[0]?.message?.content || "",
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    ms: Date.now() - t0,
    model: MODEL,
    tier: "local",
  };
}

export function extractCodeBlock(text) {
  // Language-agnostic: accepts ```js / ```markdown / ```md / bare fences.
  const m = text.match(/```(?:js|javascript|mjs|markdown|md)?\n([\s\S]*?)```/);
  if (m) return m[1];
  // Truncated response: opening fence but no closer (gateway token cap) — take the rest.
  const open = text.match(/```(?:js|javascript|mjs|markdown|md)?\n/);
  if (open) return text.slice(open.index + open[0].length);
  return null;
}

export async function healthCheck() {
  try {
    const resp = await fetch((process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080").replace(/\/v1.*$/, "") + "/health");
    return resp.ok;
  } catch { return false; }
}
