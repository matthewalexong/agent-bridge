import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_SESSION_CAPABILITIES as CAPABILITY,
  HARNESS_SESSION_CONTRACT_VERSION,
  harnessSessionAdapterInfo,
  supportsHarnessSessionCapability,
  validateHarnessSessionAdapter,
} from "../lib/harness-session-contract.mjs";
import {
  answerHarnessQuestion,
  createDeepSeekHarnessSessionAdapter,
  formatHarnessQuestion,
  waitForHarnessQuestion,
} from "../lib/harness-sessions.mjs";

const requiredCapabilities = [
  CAPABILITY.CREATE,
  CAPABILITY.LIST,
  CAPABILITY.LOAD_DISPLAY_TRANSCRIPT,
  CAPABILITY.RESUME,
  CAPABILITY.TITLE_FROM_PROMPT,
];

function minimalAdapter(overrides = {}) {
  return {
    contractVersion: HARNESS_SESSION_CONTRACT_VERSION,
    id: "fixture-harness",
    displayName: "Fixture Harness",
    capabilities: requiredCapabilities,
    async createSession() { return { sessionId: "session-created" }; },
    async listSessions() { return []; },
    async loadSession(sessionId) { return { sessionId, transcript: [], hasMore: false }; },
    async resumeSession() { return { accepted: true }; },
    titleFromPrompt() { return "Fixture session"; },
    ...overrides,
  };
}

function reply(value) {
  return { ok: true, async json() { return { result: { ok: true, value } }; } };
}

test("the v2 contract accepts a minimal provider-neutral harness adapter", () => {
  const adapter = validateHarnessSessionAdapter(minimalAdapter());
  assert.deepEqual(harnessSessionAdapterInfo(adapter), {
    contractVersion: 2,
    id: "fixture-harness",
    displayName: "Fixture Harness",
    capabilities: [...requiredCapabilities].sort(),
  });
  assert.equal(supportsHarnessSessionCapability(adapter, CAPABILITY.RESUME), true);
  assert.equal(supportsHarnessSessionCapability(adapter, CAPABILITY.RENAME), false);
});

test("capability declarations and callable methods must match exactly", () => {
  assert.throws(
    () => validateHarnessSessionAdapter(minimalAdapter({ capabilities: requiredCapabilities.filter((value) => value !== CAPABILITY.RESUME) })),
    /missing required capability: sessions\.resume:v1/,
  );
  assert.throws(
    () => validateHarnessSessionAdapter(minimalAdapter({ capabilities: [...requiredCapabilities, CAPABILITY.RENAME] })),
    /sessions\.rename:v1 requires renameSession/,
  );
  assert.throws(
    () => validateHarnessSessionAdapter(minimalAdapter({ renameSession() {} })),
    /renameSession\(\) must not be exposed/,
  );
  assert.throws(
    () => validateHarnessSessionAdapter(minimalAdapter({ capabilities: [...requiredCapabilities, "sessions.delete:v1"] })),
    /Unknown harness session capability/,
  );
});

test("the DeepSeek adapter conforms without making DeepSeek part of the core contract", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, ...request });
    if (request.method === "session.list") return reply({ items: [
      { sessionId: "session-main", updatedAt: 1000, running: false, blank: false, cwd: "/work", projections: { values: { title: "Market landscape" } } },
      { sessionId: "session-child", updatedAt: 900, running: false, blank: false, cwd: "/work", parentSessionId: "session-main", origin: "subagent" },
    ] });
    if (request.method === "session.create") return reply({ sessionId: "session-created", agentPreset: "standard" });
    if (request.method === "workspace.list") return reply({ archivedSessionIds: [], items: [{ workspaceId: "workspace-main", path: "/work", title: "Fixture" }] });
    if (request.method === "session.history") return reply({ hasMore: false, events: [
      { event: { type: "user/message", seq: 1, time: 1000, data: { source: { kind: "user" }, content: [{ type: "text", text: "Map the market" }] } } },
      { event: { type: "assistant/message", seq: 2, time: 2000, data: { message: { content: [{ type: "reasoning", text: "private chain" }, { type: "text", text: "Which value tier matters most?" }, { type: "tool-call", name: "search" }] } } } },
      { event: { type: "tool/result", seq: 3, time: 3000, data: { secret: "fixture-only" } } },
    ] });
    if (request.method === "session.prompt") return reply({ accepted: true });
    if (request.method === "session.rename") return reply({ title: request.payload.title });
    if (request.method === "workspace.archiveSession") return reply({ archivedSessionIds: [request.payload.sessionId] });
    throw new Error(`Unexpected fixture call: ${request.method}`);
  };
  const adapter = createDeepSeekHarnessSessionAdapter({
    env: { AB_HARNESS_SESSION_CWD: "/work", AB_HARNESS_SESSION_API_URL: "http://fixture.invalid/api" },
    fetchImpl,
  });

  const info = harnessSessionAdapterInfo(adapter);
  assert.equal(info.id, "deepseek-harness");
  assert.equal(supportsHarnessSessionCapability(info, CAPABILITY.RENAME), true);
  assert.equal(supportsHarnessSessionCapability(info, CAPABILITY.ARCHIVE), true);
  assert.equal(supportsHarnessSessionCapability(info, CAPABILITY.PIN), false);

  assert.deepEqual(await adapter.createSession(), { sessionId: "session-created", agentPreset: "standard" });
  assert.deepEqual(calls.at(-1).payload, { workspaceId: "workspace-main" });

  const sessions = await adapter.listSessions();
  assert.deepEqual(sessions, [{ id: "session-main", title: "Market landscape", updatedAt: "1970-01-01T00:00:01.000Z", running: false }]);
  assert.equal(JSON.stringify(sessions).includes("reasoning"), false);

  const loaded = await adapter.loadSession("session-main");
  assert.deepEqual(loaded.transcript.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Map the market" },
    { role: "agent", text: "Which value tier matters most?" },
  ]);
  assert.equal(JSON.stringify(loaded).includes("private chain"), false);
  assert.equal(JSON.stringify(loaded).includes("fixture-only"), false);

  await adapter.resumeSession("session-main", "Cheapest viable options");
  assert.deepEqual(calls.at(-1).payload, {
    sessionId: "session-main",
    mode: "queue",
    content: [{ type: "text", text: "Cheapest viable options" }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  assert.equal(adapter.titleFromPrompt("  Compare   current options. Then rank them."), "Compare current options.");
  assert.deepEqual(await adapter.renameSession("session-main", "  Current   options "), { sessionId: "session-main", title: "Current options" });
  assert.deepEqual(await adapter.archiveSession("session-main"), { sessionId: "session-main", archived: true });
});

test("interactive harness questions are rendered and answered through the canonical response channel", async () => {
  const interaction = {
    rpcId: "question-rpc-1",
    sessionId: "session-question-1",
    questions: [
      { id: "kind", header: "Product type", question: "Desktop or laptop?", options: [{ label: "Desktop" }, { label: "Laptop" }] },
      { id: "budget", header: "Budget", question: "What is your budget?", options: [] },
    ],
  };
  const rendered = formatHarnessQuestion(interaction);
  assert.match(rendered, /1\. Product type: Desktop or laptop\?/);
  assert.match(rendered, /Reply with your choices in the same order\./);

  let request;
  await answerHarnessQuestion(interaction, "Desktop, around $3,500", {
    env: { AB_HARNESS_SESSION_API_URL: "http://127.0.0.1:9999/api" },
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ accepted: true }) };
    },
  });
  assert.equal(request.url, "http://127.0.0.1:9999/api/respond");
  assert.equal(request.body.type, "client-response");
  assert.equal(request.body.rpcId, interaction.rpcId);
  assert.deepEqual(request.body.result.value.answer.answers, [
    { id: "kind", selected: [], custom: "Desktop, around $3,500" },
    { id: "budget", selected: [], custom: "Desktop, around $3,500" },
  ]);
});

test("the question watcher filters the Harness event stream to the selected session", async () => {
  class FakeWebSocket {
    listeners = new Map();
    constructor() {
      queueMicrotask(() => {
        this.emit("message", { data: JSON.stringify({ rpcId: "other", payload: { type: "question/requested", sessionId: "session-other", questions: [] } }) });
        this.emit("message", { data: JSON.stringify({ rpcId: "wanted", payload: { type: "question/requested", sessionId: "session-wanted", questions: [{ id: "q", question: "Which one?" }] } }) });
      });
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener() {}
    close() {}
    emit(type, event) { this.listeners.get(type)?.(event); }
  }
  const question = await waitForHarnessQuestion("session-wanted", {
    env: { AB_HARNESS_SESSION_API_URL: "http://127.0.0.1:9999/api" },
    WebSocketImpl: FakeWebSocket,
  });
  assert.equal(question.rpcId, "wanted");
  assert.equal(question.questions[0].id, "q");
});
