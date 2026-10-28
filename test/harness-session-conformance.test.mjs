import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveHarnessSession,
  listHarnessSessions,
  loadHarnessSession,
  promptHarnessSession,
  renameHarnessSession,
  titleFromUserPrompt,
} from "../lib/harness-sessions.mjs";

function ok(value) {
  return { ok: true, async json() { return { result: { ok: true, value } }; } };
}

function createSyntheticHarness() {
  const requests = [];
  const sessions = [
    {
      sessionId: "session-active",
      updatedAt: "2026-08-28T04:00:00.000Z",
      running: true,
      blank: false,
      cwd: "/work/agent-bridge",
      projections: { values: { title: "Audit Agent Bridge sessions" } },
    },
    {
      sessionId: "session-untitled",
      updatedAt: "2026-08-28T03:00:00.000Z",
      running: false,
      blank: false,
      cwd: "/work/agent-bridge/packages/browser",
    },
    {
      sessionId: "session-archived",
      updatedAt: "2026-08-28T02:00:00.000Z",
      running: false,
      blank: false,
      cwd: "/work/agent-bridge",
    },
    {
      sessionId: "session-child",
      updatedAt: "2026-08-28T01:00:00.000Z",
      running: false,
      blank: false,
      cwd: "/work/agent-bridge",
      parentSessionId: "session-active",
      origin: "subagent",
    },
    {
      sessionId: "session-other-workspace",
      updatedAt: "2026-08-28T00:00:00.000Z",
      running: false,
      blank: false,
      cwd: "/private/customer",
    },
    {
      sessionId: "session-blank",
      updatedAt: "2026-08-27T23:00:00.000Z",
      running: false,
      blank: true,
      cwd: "/work/agent-bridge",
    },
  ];
  const events = [
    {
      event: {
        type: "user/message",
        seq: 1,
        time: "2026-08-28T04:01:00.000Z",
        data: { source: { kind: "user" }, content: [{ type: "text", text: "Open the session dashboard" }] },
      },
    },
    {
      event: {
        type: "assistant/message",
        seq: 2,
        time: "2026-08-28T04:02:00.000Z",
        data: {
          message: {
            content: [
              { type: "reasoning", text: "private chain of thought" },
              { type: "tool-call", name: "browser_snapshot", arguments: { tabId: 7 } },
              { type: "text", text: "Loaded the dashboard." },
            ],
          },
        },
      },
    },
    {
      event: {
        type: "tool/result",
        seq: 3,
        time: "2026-08-28T04:03:00.000Z",
        data: { content: [{ type: "text", text: "private browser result" }] },
      },
    },
    {
      event: {
        type: "user/message",
        seq: 4,
        time: "2026-08-28T04:04:00.000Z",
        data: { source: { kind: "system" }, content: [{ type: "text", text: "hidden system prompt" }] },
      },
    },
  ];

  return {
    requests,
    env: { AB_HARNESS_SESSION_CWD: "/work/agent-bridge" },
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.method === "session.list") return ok({ items: sessions });
      if (request.method === "workspace.list") return ok({ archivedSessionIds: ["session-archived"] });
      if (request.method === "session.history") return ok({ hasMore: false, events });
      if (request.method === "session.prompt") return ok({ accepted: true });
      if (request.method === "session.rename") return ok({ title: request.payload.title });
      if (request.method === "workspace.archiveSession") return ok({ archivedSessionIds: [request.payload.sessionId] });
      throw new Error(`unexpected method ${request.method}`);
    },
  };
}

test("harness session conformance keeps the picker lightweight and scoped", async () => {
  const harness = createSyntheticHarness();
  const sessions = await listHarnessSessions(harness);
  assert.deepEqual(sessions.map((session) => session.id), ["session-active", "session-untitled"]);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ["id", "running", "title", "updatedAt"]);
  assert.equal(sessions[0].title, "Audit Agent Bridge sessions");
  assert.equal(sessions[1].title, "browser");
  assert.equal(JSON.stringify(sessions).includes("private"), false);
});

test("harness session conformance loads only display-safe transcript text", async () => {
  const harness = createSyntheticHarness();
  const loaded = await loadHarnessSession("session-active", harness);
  assert.deepEqual(loaded.transcript.map((entry) => [entry.role, entry.text]), [
    ["user", "Open the session dashboard"],
    ["agent", "Loaded the dashboard."],
  ]);
  assert.equal(JSON.stringify(loaded).includes("private chain of thought"), false);
  assert.equal(JSON.stringify(loaded).includes("private browser result"), false);
  assert.equal(JSON.stringify(loaded).includes("hidden system prompt"), false);
});

test("harness session conformance resumes, renames, and archives exact session ids", async () => {
  const harness = createSyntheticHarness();
  assert.equal(
    titleFromUserPrompt("  Validate   Agent Bridge session behavior before exposing it to another harness. Then continue."),
    "Validate Agent Bridge session behavior before exposing it to another…",
  );

  await promptHarnessSession("session-active", "Continue with the selected harness session", harness);
  await renameHarnessSession("session-active", "  Browser   conformance  ", harness);
  const archived = await archiveHarnessSession("session-active", harness);

  assert.deepEqual(
    harness.requests.map((request) => [request.method, request.payload.sessionId]),
    [
      ["session.prompt", "session-active"],
      ["session.rename", "session-active"],
      ["workspace.archiveSession", "session-active"],
    ],
  );
  assert.deepEqual(harness.requests[0].payload.content, [{ type: "text", text: "Continue with the selected harness session" }]);
  assert.equal("transcript" in harness.requests[0].payload, false);
  assert.equal(harness.requests[1].payload.title, "Browser conformance");
  assert.deepEqual(archived, { sessionId: "session-active", archived: true });
});
