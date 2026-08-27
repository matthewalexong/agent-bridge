import assert from "node:assert/strict";
import test from "node:test";
import { archiveHarnessSession, listHarnessSessions, loadHarnessSession, promptHarnessSession } from "../lib/harness-sessions.mjs";

function reply(value) {
  return { ok: true, async json() { return { result: { ok: true, value } }; } };
}

test("harness session catalog keeps only resumable top-level context and exposes lightweight metadata", async () => {
  const fetchImpl = async (url) => url.endsWith("/workspace.list")
    ? reply({ archivedSessionIds: ["session-archived"] })
    : reply({ items: [
      { sessionId: "session-shop", updatedAt: 1000, running: false, blank: false, cwd: "/work/shop", projections: { values: { title: "Compare local AI machines" } } },
      { sessionId: "session-archived", updatedAt: 950, running: false, blank: false, cwd: "/work/shop" },
      { sessionId: "session-child", updatedAt: 900, running: false, blank: false, cwd: "/work/shop", parentSessionId: "session-shop", origin: "subagent" },
      { sessionId: "session-blank", updatedAt: 800, running: false, blank: true, cwd: "/work/shop" },
      { sessionId: "session-other", updatedAt: 700, running: true, blank: false, cwd: "/other" },
    ] });
  const sessions = await listHarnessSessions({ env: { AB_HARNESS_SESSION_CWD: "/work" }, fetchImpl });
  assert.deepEqual(sessions.map((session) => session.id), ["session-shop"]);
  assert.equal(sessions[0].title, "Compare local AI machines");
  assert.equal("transcript" in sessions[0], false, "the extension catalog never receives full context");
});

test("removing a session uses the harness archive boundary and requires its acknowledgement", async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return reply({ archivedSessionIds: ["session-shop"] });
  };
  const result = await archiveHarnessSession("session-shop", { fetchImpl });
  assert.equal(request.method, "workspace.archiveSession");
  assert.deepEqual(request.payload, { sessionId: "session-shop" });
  assert.deepEqual(result, { sessionId: "session-shop", archived: true });
});

test("harness history projects display messages without reasoning or tool traffic", async () => {
  const fetchImpl = async () => reply({ hasMore: true, events: [
    { event: { type: "user/message", seq: 1, time: 1000, data: { source: { kind: "user" }, content: [{ type: "text", text: "Find a laptop" }] } } },
    { event: { type: "assistant/message", seq: 2, time: 2000, data: { message: { content: [{ type: "reasoning", text: "private analysis" }, { type: "text", text: "What matters most: price or speed?" }, { type: "tool-call", name: "search" }] } } } },
    { event: { type: "tool/result", seq: 3, time: 3000, data: {} } },
  ] });
  const loaded = await loadHarnessSession("session-shop", { fetchImpl });
  assert.deepEqual(loaded.transcript.map((entry) => [entry.role, entry.text]), [
    ["user", "Find a laptop"],
    ["agent", "What matters most: price or speed?"],
  ]);
  assert.equal(JSON.stringify(loaded).includes("private analysis"), false);
  assert.equal(loaded.hasMore, true);
});

test("resuming sends the next message to the selected harness session", async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return reply({ accepted: true });
  };
  await promptHarnessSession("session-shop", "Cheapest first", { fetchImpl });
  assert.equal(request.method, "session.prompt");
  assert.equal(request.payload.sessionId, "session-shop");
  assert.equal(request.payload.content[0].text, "Cheapest first");
});
