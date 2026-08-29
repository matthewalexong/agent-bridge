import { basename } from "node:path";
import {
  HARNESS_SESSION_CAPABILITIES,
  HARNESS_SESSION_CONTRACT_VERSION,
  harnessSessionAdapterInfo,
  validateHarnessSessionAdapter,
} from "./harness-session-contract.mjs";

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

function websocketUrl(env = process.env) {
  const url = new URL(`${apiUrl(env)}/events.mux`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function formatHarnessQuestion(interaction) {
  const questions = Array.isArray(interaction?.questions) ? interaction.questions : [];
  const lines = [questions.length > 1 ? "Before I continue, I need a few details:" : "Before I continue, I need one detail:"];
  questions.forEach((question, index) => {
    const heading = String(question?.header || `Question ${index + 1}`).trim();
    lines.push("", `${index + 1}. ${heading}: ${String(question?.question || "").trim()}`);
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length) lines.push(`   Options: ${options.map((option) => option.label).join("; ")}`);
  });
  lines.push("", questions.length > 1 ? "Reply with your choices in the same order." : "Reply with your choice or your own answer.");
  return lines.join("\n");
}

function naturalLanguageAnswers(questions, text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Question response must not be empty");
  return questions.map((question) => {
    const options = Array.isArray(question?.options) ? question.options : [];
    const exact = options.find((option) => normalized.toLowerCase() === String(option?.label || "").trim().toLowerCase());
    return exact
      ? { id: question.id, selected: [exact.label] }
      : { id: question.id, selected: [], custom: normalized };
  });
}

export async function answerHarnessQuestion(interaction, text, { env = process.env, fetchImpl = fetch } = {}) {
  const questions = Array.isArray(interaction?.questions) ? interaction.questions : [];
  if (!interaction?.rpcId || !interaction?.sessionId || questions.length === 0) throw new Error("Harness question is incomplete");
  const response = await fetchImpl(`${apiUrl(env)}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-response",
      rpcId: interaction.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          answer: { answers: naturalLanguageAnswers(questions, text) },
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Harness question API returned HTTP ${response.status}`);
  const receipt = await response.json();
  if (receipt?.accepted !== true) throw new Error(`Harness did not accept the question response (${receipt?.reason || "unknown"})`);
  return { accepted: true };
}

export function waitForHarnessQuestion(sessionId, { env = process.env, WebSocketImpl = globalThis.WebSocket, signal } = {}) {
  if (typeof WebSocketImpl !== "function") return Promise.reject(new Error("WebSocket support is unavailable"));
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(websocketUrl(env));
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try { socket.close(); } catch { /* already closed */ }
      callback(value);
    };
    const onAbort = () => finish(reject, Object.assign(new Error("Harness question wait was cancelled"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    socket.addEventListener("message", (event) => {
      try {
        const envelope = JSON.parse(String(event.data));
        const payload = envelope?.payload;
        if (payload?.type !== "question/requested" || payload.sessionId !== sessionId) return;
        finish(resolve, { rpcId: envelope.rpcId, sessionId, questions: payload.questions });
      } catch { /* malformed frames are ignored like the Harness client */ }
    });
    socket.addEventListener("error", () => finish(reject, new Error("Harness question stream failed")), { once: true });
    socket.addEventListener("close", () => finish(reject, new Error("Harness question stream closed")), { once: true });
  });
}

function sessionTitle(item) {
  const projected = item?.projections?.values?.title;
  if (typeof projected === "string" && projected.trim()) return projected.trim().slice(0, 100);
  if (typeof item?.cwd === "string" && item.cwd.trim()) return basename(item.cwd) || "Previous session";
  return "Previous session";
}

export async function listHarnessSessions(options = {}) {
  const [value, workspace] = await Promise.all([
    callHarness("session.list", {}, options),
    callHarness("workspace.list", {}, options),
  ]);
  const archived = new Set(Array.isArray(workspace?.archivedSessionIds) ? workspace.archivedSessionIds : []);
  const scope = String(options.env?.AB_HARNESS_SESSION_CWD || "").trim();
  return (Array.isArray(value?.items) ? value.items : [])
    .filter((item) => item && !item.blank && !item.parentSessionId && item.origin !== "subagent")
    .filter((item) => !archived.has(item.sessionId))
    .filter((item) => !scope || item.cwd === scope || item.cwd?.startsWith(`${scope}/`))
    .slice(0, MAX_SESSIONS)
    .map((item) => ({
      id: item.sessionId,
      title: sessionTitle(item),
      updatedAt: new Date(item.updatedAt).toISOString(),
      running: Boolean(item.running),
    }));
}

export async function createHarnessSession(options = {}) {
  const cwd = String(options.env?.AB_HARNESS_SESSION_CWD || "").trim();
  let payload = {};
  if (cwd) {
    const listed = await callHarness("workspace.list", {}, options);
    let workspace = Array.isArray(listed?.items) ? listed.items.find((item) => item?.path === cwd) : null;
    if (!workspace) {
      const created = await callHarness("workspace.create", { path: cwd }, options);
      workspace = created?.workspace;
    }
    if (typeof workspace?.workspaceId !== "string" || !workspace.workspaceId.trim()) {
      throw new Error("Harness did not return a workspace ID");
    }
    payload = { workspaceId: workspace.workspaceId };
  }
  const value = await callHarness("session.create", payload, options);
  if (typeof value?.sessionId !== "string" || !value.sessionId.trim()) {
    throw new Error("Harness did not return a session ID");
  }
  return { sessionId: value.sessionId, agentPreset: value.agentPreset };
}

export async function archiveHarnessSession(sessionId, options = {}) {
  const value = await callHarness("workspace.archiveSession", { sessionId }, options);
  return { sessionId, archived: Array.isArray(value?.archivedSessionIds) && value.archivedSessionIds.includes(sessionId) };
}

export function titleFromUserPrompt(value, maxLength = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "New session";
  const sentence = text.match(/^.*?(?:[.!?](?=\s|$)|$)/)?.[0] || text;
  if (sentence.length <= maxLength) return sentence;
  const clipped = sentence.slice(0, Math.max(1, maxLength - 1));
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary >= Math.floor(maxLength / 2) ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}

export async function renameHarnessSession(sessionId, title, options = {}) {
  const normalized = String(title || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!normalized) throw new Error("Session title must not be empty");
  const value = await callHarness("session.rename", { sessionId, title: normalized }, options);
  return { sessionId, title: String(value?.title || normalized).trim().slice(0, 100) };
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

export function createDeepSeekHarnessSessionAdapter(options = {}) {
  return validateHarnessSessionAdapter({
    contractVersion: HARNESS_SESSION_CONTRACT_VERSION,
    id: "deepseek-harness",
    displayName: "DeepSeek Harness",
    capabilities: [
      HARNESS_SESSION_CAPABILITIES.CREATE,
      HARNESS_SESSION_CAPABILITIES.LIST,
      HARNESS_SESSION_CAPABILITIES.LOAD_DISPLAY_TRANSCRIPT,
      HARNESS_SESSION_CAPABILITIES.RESUME,
      HARNESS_SESSION_CAPABILITIES.TITLE_FROM_PROMPT,
      HARNESS_SESSION_CAPABILITIES.RENAME,
      HARNESS_SESSION_CAPABILITIES.ARCHIVE,
      HARNESS_SESSION_CAPABILITIES.INTERACTIVE_QUESTIONS,
    ],
    createSession: () => createHarnessSession(options),
    listSessions: () => listHarnessSessions(options),
    loadSession: (sessionId) => loadHarnessSession(sessionId, options),
    resumeSession: (sessionId, text) => promptHarnessSession(sessionId, text, options),
    titleFromPrompt: (text, maxLength) => titleFromUserPrompt(text, maxLength),
    renameSession: (sessionId, title) => renameHarnessSession(sessionId, title, options),
    archiveSession: (sessionId) => archiveHarnessSession(sessionId, options),
    waitForQuestion: (sessionId, waitOptions = {}) => waitForHarnessQuestion(sessionId, { ...options, ...waitOptions }),
    answerQuestion: (interaction, text) => answerHarnessQuestion(interaction, text, options),
  });
}

export function deepSeekHarnessSessionAdapterInfo() {
  return harnessSessionAdapterInfo(createDeepSeekHarnessSessionAdapter());
}
