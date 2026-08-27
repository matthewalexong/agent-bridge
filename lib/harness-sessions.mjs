import { basename } from "node:path";

const DEFAULT_API_URL = "http://127.0.0.1:3080/api";
const MAX_SESSIONS = 30;

function apiUrl(env = process.env) {
  return String(env.AB_HARNESS_SESSION_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
}

async function callHarness(method, payload, { env = process.env, fetchImpl = fetch } = {}) {
  const rpcId = `agent-bridge-${crypto.randomUUID()}`;
  const response = await fetchImpl(`${apiUrl(env)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Harness session API returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.result?.ok !== true) {
    const error = new Error(body?.result?.error?.message || "Harness session request failed");
    error.code = body?.result?.error?.code || "harness_session_error";
    throw error;
  }
  return body.result.value;
}

function sessionTitle(item) {
  const projected = item?.projections?.values?.title;
  if (typeof projected === "string" && projected.trim()) return projected.trim().slice(0, 100);
  if (typeof item?.cwd === "string" && item.cwd.trim()) return basename(item.cwd) || "Previous session";
  return "Previous session";
}

export async function listHarnessSessions(options = {}) {
  const value = await callHarness("session.list", {}, options);
  const scope = String(options.env?.AB_HARNESS_SESSION_CWD || "").trim();
  return (Array.isArray(value?.items) ? value.items : [])
    .filter((item) => item && !item.blank && !item.parentSessionId && item.origin !== "subagent")
    .filter((item) => !scope || item.cwd === scope || item.cwd?.startsWith(`${scope}/`))
    .slice(0, MAX_SESSIONS)
    .map((item) => ({
      id: item.sessionId,
      title: sessionTitle(item),
      updatedAt: new Date(item.updatedAt).toISOString(),
      running: Boolean(item.running),
    }));
}

function messageText(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export async function loadHarnessSession(sessionId, options = {}) {
  const value = await callHarness("session.history", { sessionId, maxMessages: 60 }, options);
  const transcript = [];
  for (const item of Array.isArray(value?.events) ? value.events : []) {
    const event = item?.event;
    if (event?.type !== "user/message" && event?.type !== "assistant/message") continue;
    const message = event.type === "user/message" ? event.data : event.data?.message;
    if (event.type === "user/message" && message?.source?.kind !== "user") continue;
    const text = messageText(message);
    if (!text) continue;
    transcript.push({
      id: `harness_${sessionId}_${event.seq}`,
      role: event.type === "user/message" ? "user" : "agent",
      text: text.slice(0, 20_000),
      at: new Date(event.time).toISOString(),
    });
  }
  return { sessionId, transcript: transcript.slice(-100), hasMore: Boolean(value?.hasMore) };
}

export async function promptHarnessSession(sessionId, text, options = {}) {
  return callHarness("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }, options);
}
