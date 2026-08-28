#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import process from "node:process";
import {
  loadOrCreateAuthState,
  renewAuthState,
  writePrivateJsonAtomic,
} from "../lib/auth-token.mjs";
import { bridgeDirectory, DEFAULT_TIMEOUT_MS, runtimeFile } from "../lib/config.mjs";
import { resolvePanelWebhookUrl } from "../lib/shopping-model.mjs";
import { sanitizeConversationId } from "../lib/panel-conversation.mjs";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";
import { createDeepSeekHarnessSessionAdapter } from "../lib/harness-sessions.mjs";
import { harnessSessionAdapterInfo } from "../lib/harness-session-contract.mjs";

const BRIDGE_VERSION = "0.9.1";

let authState = await loadOrCreateAuthState();
const pending = new Map();
const eventBuffer = [];
const eventWaiters = new Set();
let nextRequestId = 1;
let eventSequence = 0;
let extensionVersion = "0.0.0";
let previousTabs = null;
let cleanedUp = false;
let runtimeIdentity = null;
let harnessSessionAdapter = null;
let latestPanelTurnKey = null;

// The launcher runs the host with stderr unattached, so also persist a
// bounded log file — otherwise forward/status failures are invisible.
// (fs helpers come from the hoisted imports in the webhook section below.)
const HOST_LOG_FILE = join(bridgeDirectory(), "host.log");
function log(message) {
  const line = `[chrome-agent-bridge] ${message}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(HOST_LOG_FILE, new Date().toISOString() + " " + line);
    if (statSync(HOST_LOG_FILE).size > 512 * 1024) {
      // Trim to the last 256KB by rewriting once (rare).
      writeFileSync(HOST_LOG_FILE, readFileSync(HOST_LOG_FILE, "utf8").slice(-256 * 1024));
    }
  } catch { /* logging must never break the bridge */ }
}

function sendNative(value) {
  process.stdout.write(encodeNativeMessage(value));
}

function serializeError(error, fallbackCode = "bridge_error") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isAuthorized(header, expectedToken) {
  const prefix = "Bearer ";
  const provided = typeof header === "string" && header.startsWith(prefix)
    ? header.slice(prefix.length)
    : "";
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function publicAuthState() {
  return {
    token: authState.token,
    createdAt: authState.createdAt,
    rotatedAt: authState.rotatedAt,
  };
}

function publicAuthMetadata() {
  return {
    available: true,
    createdAt: authState.createdAt,
    rotatedAt: authState.rotatedAt,
  };
}

async function handleAuthRequest(message) {
  if (typeof message.id !== "string") return;
  try {
    if (message.action === "renew") {
      authState = await renewAuthState();
    } else if (message.action === "status") {
      authState = await loadOrCreateAuthState();
      sendNative({ type: "auth.response", id: message.id, ok: true, result: publicAuthMetadata() });
      return;
    } else if (message.action !== "get") {
      const error = new Error(`Unsupported auth action: ${message.action}`);
      error.code = "auth_action_invalid";
      throw error;
    } else authState = await loadOrCreateAuthState();
    sendNative({ type: "auth.response", id: message.id, ok: true, result: publicAuthState() });
  } catch (error) {
    sendNative({ type: "auth.response", id: message.id, ok: false, error: serializeError(error) });
  }
}

function forwardToExtension(method, params) {
  const id = String(nextRequestId++);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      const error = new Error(`Extension request timed out: ${method}`);
      error.code = "extension_timeout";
      reject(error);
    }, DEFAULT_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timeout });
    sendNative({ type: "request", id, method, params });
  });
}

function eventTabId(event) {
  return event?.data?.tabId ?? event?.data?.id ?? event?.data?.tab?.id;
}

function eventResult(afterSequence, tabId) {
  const earliestSequence = eventBuffer[0]?.sequence ?? eventSequence + 1;
  const events = eventBuffer.filter(
    (event) => event.sequence > afterSequence && (tabId == null || eventTabId(event) === tabId),
  );
  return {
    cursor: eventSequence,
    events,
    truncated: afterSequence < earliestSequence - 1,
  };
}

function pollParameters(params) {
  const afterSequence = Number(params?.afterSequence ?? 0);
  const timeoutMs = Number(params?.timeoutMs ?? 10_000);
  const tabId = params?.tabId == null ? undefined : Number(params.tabId);
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    const error = new Error("afterSequence must be a non-negative integer");
    error.code = "invalid_request";
    throw error;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 25_000) {
    const error = new Error("timeoutMs must be an integer from 0 to 25000");
    error.code = "invalid_request";
    throw error;
  }
  if (tabId != null && (!Number.isInteger(tabId) || tabId < 0)) {
    const error = new Error("tabId must be a non-negative integer when provided");
    error.code = "invalid_request";
    throw error;
  }
  return { afterSequence, timeoutMs, tabId };
}

function supportsPushedEvents() {
  const [major, minor] = extensionVersion.split(".").map(Number);
  return major > 0 || minor >= 2;
}

function waitForPushedEvents(afterSequence, timeoutMs, tabId) {

  const current = eventResult(afterSequence, tabId);
  if (current.events.length > 0 || timeoutMs === 0) return Promise.resolve(current);
  return new Promise((resolve) => {
    const waiter = { afterSequence, tabId, resolve };
    waiter.timeout = setTimeout(() => {
      eventWaiters.delete(waiter);
      resolve(eventResult(afterSequence, tabId));
    }, timeoutMs);
    eventWaiters.add(waiter);
  });
}

function tabChanged(before, after) {
  return (
    before.active !== after.active ||
    before.title !== after.title ||
    before.url !== after.url ||
    before.windowId !== after.windowId
  );
}

async function refreshTabSnapshot() {
  const tabs = await forwardToExtension("tabs.list", {});
  const currentTabs = new Map(tabs.map((tab) => [tab.id, tab]));
  if (previousTabs == null) {
    previousTabs = currentTabs;
    return;
  }

  for (const [tabId, tab] of currentTabs) {
    const previous = previousTabs.get(tabId);
    if (previous == null) recordEvent("tab.created", tab);
    else if (tabChanged(previous, tab)) {
      recordEvent("tab.updated", { tabId, tab, previousTab: previous, source: "snapshot" });
    }
  }
  for (const [tabId, tab] of previousTabs) {
    if (!currentTabs.has(tabId)) recordEvent("tab.removed", { tabId, tab, source: "snapshot" });
  }
  previousTabs = currentTabs;
}

async function pollSnapshotEvents(afterSequence, timeoutMs, tabId) {
  const deadline = Date.now() + timeoutMs;
  await refreshTabSnapshot();
  let current = eventResult(afterSequence, tabId);
  if (current.events.length > 0 || timeoutMs === 0) return current;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    await refreshTabSnapshot();
    current = eventResult(afterSequence, tabId);
    if (current.events.length > 0) return current;
  }
  return eventResult(afterSequence, tabId);
}

function pollEvents(params) {
  const { afterSequence, timeoutMs, tabId } = pollParameters(params);
  return supportsPushedEvents()
    ? waitForPushedEvents(afterSequence, timeoutMs, tabId)
    : pollSnapshotEvents(afterSequence, timeoutMs, tabId);
}

function recordEvent(event, data) {
  eventSequence += 1;
  eventBuffer.push({ sequence: eventSequence, event, data, observedAt: new Date().toISOString() });
  if (eventBuffer.length > 500) eventBuffer.splice(0, eventBuffer.length - 500);
  for (const waiter of [...eventWaiters]) {
    const result = eventResult(waiter.afterSequence, waiter.tabId);
    if (result.events.length === 0) continue;
    eventWaiters.delete(waiter);
    clearTimeout(waiter.timeout);
    waiter.resolve(result);
  }
  // Direct panel → harness wiring: user messages typed in the side panel are
  // forwarded to the active harness so a real agent turn handles them
  // (replacing the standalone panel-watcher daemon). Fire-and-forget: a
  // webhook failure must never break the event loop.
  if (event === "panel.message" && data?.role === "user") {
    latestPanelTurnKey = data.messageId || data.conversationId || `${Date.now()}`;
    if (data.harnessSession) void forwardPanelMessageToHarnessSession(data);
    else void forwardPanelMessageToHarness(data);
  }
  if (event === "panel.close" && data?.conversationId && !data.harnessSession) {
    void endPanelConversation(data.conversationId);
  }
  if (event === "panel.sessions.list") void publishHarnessSessions(data?.requestId);
  if (event === "panel.session.select" && data?.sessionId) void publishHarnessSession(data.sessionId, data?.requestId);
  if (event === "panel.session.archive" && data?.sessionId) void archivePanelHarnessSession(data.sessionId, data?.requestId);
  if (event === "panel.session.rename" && data?.sessionId) void renamePanelHarnessSession(data.sessionId, data?.title, data?.requestId);
}

async function publishHarnessSessions(requestId) {
  try {
    const sessions = await harnessSessionAdapter.listSessions();
    await forwardToExtension("panel.sessions.update", { requestId, sessions, adapter: harnessSessionAdapterInfo(harnessSessionAdapter) });
    log(`harness sessions: published ${sessions.length} session${sessions.length === 1 ? "" : "s"}`);
  } catch (error) {
    log(`harness sessions: list failed (${error?.message ?? error})`);
    await forwardToExtension("panel.sessions.update", { requestId, sessions: [], adapter: harnessSessionAdapterInfo(harnessSessionAdapter), error: "Previous sessions are unavailable right now." }).catch(() => {});
  }
}

async function publishHarnessSession(sessionId, requestId) {
  try {
    const loaded = await harnessSessionAdapter.loadSession(sessionId);
    await forwardToExtension("panel.session.loaded", { requestId, ...loaded });
  } catch (error) {
    log(`harness sessions: load failed (${error?.message ?? error})`);
    await forwardToExtension("panel.session.loaded", { requestId, sessionId, error: "That session could not be loaded." }).catch(() => {});
  }
}

async function archivePanelHarnessSession(sessionId, requestId) {
  try {
    const result = await harnessSessionAdapter.archiveSession(sessionId);
    if (!result.archived) throw new Error("Harness did not confirm that the session was archived");
    await forwardToExtension("panel.session.archived", { requestId, sessionId });
    await publishHarnessSessions();
  } catch (error) {
    log(`harness sessions: archive failed (${error?.message ?? error})`);
    await forwardToExtension("panel.session.archived", { requestId, sessionId, error: "That session could not be removed from the list." }).catch(() => {});
  }
}

async function renamePanelHarnessSession(sessionId, title, requestId) {
  try {
    const renamed = await harnessSessionAdapter.renameSession(sessionId, title);
    await forwardToExtension("panel.session.renamed", { requestId, ...renamed });
  } catch (error) {
    log(`harness sessions: rename failed (${error?.message ?? error})`);
    await forwardToExtension("panel.session.renamed", { requestId, sessionId, error: "That session could not be renamed." }).catch(() => {});
  }
}

async function forwardPanelMessageToHarnessSession(data) {
  try {
    const sessionId = sanitizeConversationId(data.conversationId);
    if (!sessionId) return;
    await harnessSessionAdapter.resumeSession(sessionId, typeof data.text === "string" ? data.text : "");
    log(`panel→harness: queued prompt in ${sessionId}`);
    scheduleHarnessSessionCatalogSync();
    monitorHarnessTurn(sessionId, data.messageId || data.conversationId);
  } catch (error) {
    log(`panel→harness: prompt failed (${error?.message ?? error})`);
    pushPanelStatus(null, { persist: false });
    void forwardToExtension("panel.post", { text: "I couldn't resume that harness session. Please choose another session or start a new one.", links: [] }).catch(() => {});
  }
}

// --- Harness webhook forwarder --------------------------------------------
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// In the bundled workspace layout the repository is a child of the harness
// workspace and panel-created sessions live in its dedicated `panel` project.
// Deployments can point this adapter at any other project folder.
const DEFAULT_HARNESS_SESSION_CWD = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "panel",
);
const HARNESS_SESSION_CWD = process.env.AB_HARNESS_SESSION_CWD
  || DEFAULT_HARNESS_SESSION_CWD;
harnessSessionAdapter = createDeepSeekHarnessSessionAdapter({
  env: { ...process.env, AB_HARNESS_SESSION_CWD: HARNESS_SESSION_CWD },
});

function panelWebhookUrl() {
  return resolvePanelWebhookUrl(process.env);
}
const HARNESS_WEBHOOK_SECRET_FILE = join(bridgeDirectory(), "webhook-secret");
// Per-host-instance nonce. Extension restarts reset the panel message
// counter to panel_1; without this nonce the gateway's idempotency cache
// (1h TTL) would silently drop every early-ID message after a restart as
// a "duplicate delivery".
const HOST_INSTANCE = crypto.randomBytes(4).toString("hex");

function readWebhookSecret() {
  try {
    return readFileSync(HARNESS_WEBHOOK_SECRET_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

async function postToHarnessWebhook(payload, deliveryId) {
  const secret = readWebhookSecret();
  if (!secret) {
    log("panel→harness: webhook secret missing — skipping forward");
    return null;
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const response = await fetch(panelWebhookUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature-v2": signature,
      "x-webhook-timestamp": timestamp,
      "x-request-id": deliveryId,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  const status = response.status;
  const text = (await response.text()).slice(0, 200);
  return { status, text };
}

const sessionCatalogSyncTimers = new Set();
const activeHarnessTurnMonitors = new Map();
const HARNESS_TURN_POLL_MS = Math.max(250, Math.min(10_000, Number(process.env.AB_HARNESS_TURN_POLL_MS) || 2_000));
const HARNESS_TURN_MAX_POLLS = Math.max(2, Math.ceil((20 * 60 * 1000) / HARNESS_TURN_POLL_MS));

function scheduleHarnessSessionCatalogSync() {
  // Session creation/resume is asynchronous after acknowledgement. Refresh a
  // few times at bounded intervals so the picker observes the committed title,
  // activity timestamp, and running state without polling forever.
  // A new accepted turn supersedes the remaining refreshes from the previous
  // one, so every message gets a prompt first refresh without unbounded timers.
  for (const timer of sessionCatalogSyncTimers) clearTimeout(timer);
  sessionCatalogSyncTimers.clear();
  for (const delay of [250, 1_000, 3_000]) {
    const timer = setTimeout(() => {
      sessionCatalogSyncTimers.delete(timer);
      void publishHarnessSessions();
    }, delay);
    timer.unref?.();
    sessionCatalogSyncTimers.add(timer);
  }
}

function monitorHarnessTurn(sessionId, turnKey) {
  const previous = activeHarnessTurnMonitors.get(sessionId);
  if (previous?.timer) clearTimeout(previous.timer);
  const state = { generation: (previous?.generation || 0) + 1, polls: 0, sawRunning: false, timer: null };
  activeHarnessTurnMonitors.set(sessionId, state);

  const poll = async () => {
    if (activeHarnessTurnMonitors.get(sessionId) !== state) return;
    state.polls += 1;
    try {
      const sessions = await harnessSessionAdapter.listSessions();
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (session?.running) state.sawRunning = true;
      // Two consecutive observations allow very short turns to settle even if
      // the adapter never exposes a visible running=true transition.
      if (session && !session.running && (state.sawRunning || state.polls >= 2)) {
        activeHarnessTurnMonitors.delete(sessionId);
        if (latestPanelTurnKey === turnKey) pushPanelStatus(null, { persist: false });
        scheduleHarnessSessionCatalogSync();
        return;
      }
    } catch (error) {
      log(`panel→harness: lifecycle poll failed (${error?.message ?? error})`);
    }
    if (state.polls >= HARNESS_TURN_MAX_POLLS) {
      activeHarnessTurnMonitors.delete(sessionId);
      if (latestPanelTurnKey === turnKey) pushPanelStatus(null, { persist: false });
      return;
    }
    state.timer = setTimeout(poll, HARNESS_TURN_POLL_MS);
    state.timer.unref?.();
  };
  void poll();
}

async function forwardPanelMessageToHarness(data) {
  try {
    const conversationId = sanitizeConversationId(data.conversationId);
    const deliveryId = data.messageId
      ? `${HOST_INSTANCE}:${data.messageId}`
      : `${HOST_INSTANCE}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await postToHarnessWebhook({
      event_type: "panel.message",
      text: typeof data.text === "string" ? data.text : "",
      messageId: data.messageId ?? null,
      conversation_id: conversationId,
      resume: Boolean(data.resume && conversationId),
      observedAt: new Date().toISOString(),
    }, deliveryId);
    if (!result) return;
    log(`panel→harness: forwarded (HTTP ${result.status}) ${result.text}`);
    if (result.status >= 200 && result.status < 300 && result.text.includes('"accepted"')) {
      let harnessSessionId = null;
      try { harnessSessionId = sanitizeConversationId(JSON.parse(result.text)?.sessionId); } catch {}
      if (!data.resume) {
        if (harnessSessionId) {
          const fallbackTitle = harnessSessionAdapter.titleFromPrompt(data.text);
          let title = fallbackTitle;
          try {
            title = (await harnessSessionAdapter.renameSession(harnessSessionId, fallbackTitle)).title;
          } catch (error) {
            log(`panel→harness: automatic title failed (${error?.message ?? error})`);
          }
          await forwardToExtension("panel.session.started", {
            sessionId: harnessSessionId,
            title,
            updatedAt: new Date().toISOString(),
            running: true,
          }).catch(() => {});
        }
      }
      scheduleHarnessSessionCatalogSync();
      if (harnessSessionId) monitorHarnessTurn(harnessSessionId, data.messageId || data.conversationId);
    }
  } catch (error) {
    log(`panel→harness: forward failed (${error?.message ?? error})`);
  }
}

async function endPanelConversation(conversationId) {
  const id = sanitizeConversationId(conversationId);
  if (!id) return;
  try {
    const deliveryId = `${HOST_INSTANCE}:end-${id}-${Date.now()}`;
    const result = await postToHarnessWebhook({
      event_type: "panel.message",
      conversation_id: id,
      end: true,
      observedAt: new Date().toISOString(),
    }, deliveryId);
    if (result) log(`panel→harness: ended ${id} (HTTP ${result.status}) ${result.text}`);
  } catch (error) {
    log(`panel→harness: end failed (${error?.message ?? error})`);
  }
}

// --- Panel status push ------------------------------------------------------
// Progress text in the panel is authored by the connected agent through the
// browser_panel_status MCP tool; the host only forwards clears (e.g. when a
// harness resume fails). No harness-specific log or model source lives here.
function pushPanelStatus(text, options = {}) {
  void forwardToExtension("panel.status", { text, ...options })
    .then(() => log(`panel.status pushed: ${text == null ? "(cleared)" : String(text).slice(0, 80)}`))
    .catch((error) => {
      log(`panel.status push failed (${error?.message ?? error})`);
    });
}

function handleExtensionMessage(message) {
  if (message?.type === "auth.request") {
    void handleAuthRequest(message);
    return;
  }
  if (message?.type === "hello") {
    extensionVersion = typeof message.extensionVersion === "string" ? message.extensionVersion : "0.0.0";
    sendNative({ type: "hello", ok: true, host: "chrome-agent-bridge", version: BRIDGE_VERSION });
    return;
  }
  if (message?.type === "event" && typeof message.event === "string") {
    recordEvent(message.event, message.data ?? {});
    return;
  }
  if (message?.type !== "response" || typeof message.id !== "string") return;

  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timeout);

  if (message.ok === true) request.resolve(message.result);
  else {
    const error = new Error(message?.error?.message || "Chrome extension request failed");
    error.code = message?.error?.code || "extension_error";
    request.reject(error);
  }
}

const decoder = new NativeMessageDecoder();
process.stdin.on("data", (chunk) => {
  try {
    for (const message of decoder.push(chunk)) handleExtensionMessage(message);
  } catch (error) {
    log(`Invalid native message: ${error.message}`);
    process.exitCode = 1;
    void cleanup();
  }
});

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (request.method !== "POST" || request.url !== "/rpc") {
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "Not found" } }));
    return;
  }
  try {
    authState = await loadOrCreateAuthState();
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ ok: false, error: serializeError(error, "auth_file_invalid") }));
    return;
  }
  if (!isAuthorized(request.headers.authorization, authState.token)) {
    response.statusCode = 401;
    response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }));
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) request.destroy();
  });
  request.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      if (typeof payload?.method !== "string" || payload.method.length > 100) {
        const error = new Error("Invalid RPC method");
        error.code = "invalid_request";
        throw error;
      }
      const result =
        payload.method === "events.poll"
          ? await pollEvents(payload.params ?? {})
          : await forwardToExtension(payload.method, payload.params ?? {});
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.statusCode = error?.code === "invalid_request" ? 400 : 502;
      response.end(JSON.stringify({ ok: false, error: serializeError(error) }));
    }
  });
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot resolve bridge address");

  const directory = bridgeDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  runtimeIdentity = {
    schemaVersion: 2,
      host: "127.0.0.1",
      port: address.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
  };
  await writePrivateJsonAtomic(runtimeFile(), runtimeIdentity);
  sendNative({ type: "ready", ok: true, version: BRIDGE_VERSION });
});

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const { reject, timeout } of pending.values()) {
    clearTimeout(timeout);
    reject(new Error("Native host disconnected"));
  }
  pending.clear();
  for (const waiter of eventWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve(eventResult(waiter.afterSequence, waiter.tabId));
  }
  eventWaiters.clear();
  server.close();
  try {
    const current = JSON.parse(await fs.readFile(runtimeFile(), "utf8"));
    if (current?.pid === runtimeIdentity?.pid && current?.port === runtimeIdentity?.port) {
      await fs.unlink(runtimeFile());
    }
  } catch (error) {
    if (error?.code !== "ENOENT") log(`Cleanup warning: ${error.message}`);
  }
}

process.stdin.on("end", () => void cleanup().finally(() => process.exit()));
process.on("SIGTERM", () => void cleanup().finally(() => process.exit()));
process.on("SIGINT", () => void cleanup().finally(() => process.exit()));
