import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("new and resumed panel turns refresh sessions from the configured harness project", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bridge-session-sync-"));
  await fs.writeFile(path.join(bridgeDir, "webhook-secret"), "fixture-secret");
  const projectCwd = path.join(bridgeDir, "Agent Bridge");
  const apiCalls = [];

  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      response.setHeader("content-type", "application/json");
      if (request.url === "/panel-webhook") {
        response.end(JSON.stringify({ accepted: true, sessionId: "session-panel" }));
        return;
      }
      apiCalls.push(body);
      const value = body.method === "session.list"
        ? { items: [{ sessionId: "session-panel", updatedAt: Date.now(), running: false, blank: false, cwd: projectCwd, projections: { values: { title: "Scoped panel session" } } }] }
        : body.method === "workspace.list"
          ? { archivedSessionIds: [] }
          : body.method === "session.rename"
            ? { title: body.payload.title }
            : { accepted: true };
      response.end(JSON.stringify({ result: { ok: true, value } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
      AB_HARNESS_WEBHOOK_URL: `http://127.0.0.1:${port}/panel-webhook`,
      AB_HARNESS_SESSION_API_URL: `http://127.0.0.1:${port}/api`,
      AB_HARNESS_SESSION_CWD: projectCwd,
      AB_HARNESS_TURN_POLL_MS: "250",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(async () => {
    child.kill("SIGTERM");
    server.close();
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  const decoder = new NativeMessageDecoder();
  const messages = [];
  child.stdout.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) {
      messages.push(message);
      if (message.type === "request") {
        child.stdin.write(encodeNativeMessage({ type: "response", id: message.id, ok: true, result: {} }));
      }
    }
  });

  await waitFor(() => messages.find((message) => message.type === "ready"), 2_000, "native host readiness");
  child.stdin.write(encodeNativeMessage({ type: "hello", extensionVersion: "0.9.1" }));
  child.stdin.write(encodeNativeMessage({
    type: "event",
    event: "panel.message",
    data: { role: "user", text: "Create a scoped session", messageId: "panel_1", conversationId: `c${"a".repeat(32)}`, resume: false, harnessSession: false },
  }));

  const started = await waitFor(
    () => messages.find((message) => message.type === "request" && message.method === "panel.session.started"),
    2_000,
    "new session announcement",
  );
  assert.equal(started.params.sessionId, "session-panel");

  const catalog = await waitFor(
    () => messages.find((message) => message.type === "request" && message.method === "panel.sessions.update" && message.params.sessions?.length),
    2_000,
    "project-scoped catalog refresh",
  );
  assert.deepEqual(catalog.params.sessions.map((session) => session.id), ["session-panel"]);
  assert.equal(catalog.params.adapter.displayName, "DeepSeek Harness");
  await waitFor(
    () => messages.find((message) => message.type === "request" && message.method === "panel.status" && message.params.text === null),
    2_000,
    "provider-neutral terminal status clear",
  );

  child.stdin.write(encodeNativeMessage({
    type: "event",
    event: "panel.message",
    data: { role: "user", text: "Resume it", messageId: "panel_2", conversationId: "session-panel", resume: true, harnessSession: true },
  }));
  await waitFor(
    () => apiCalls.find((call) => call.method === "session.prompt" && call.payload.sessionId === "session-panel"),
    2_000,
    "selected session resume",
  );
  await waitFor(
    () => messages.filter((message) => message.type === "request" && message.method === "panel.sessions.update").length >= 2,
    2_000,
    "catalog refresh after resume",
  );
});
