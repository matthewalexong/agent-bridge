// E2E proof of the live "thinking" chain:
// user sends panel message -> host forwards to webhook -> host starts
// tailing the gateway log -> pushes panel.status updates (broadcast as
// panel.update with status) -> clears when "response ready" lands.
// No human, no real Hermes: the webhook is a local fake server, the
// gateway log is a temp file the test writes to.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.crypto ??= webcrypto;

function event() {
  return { listener: null, addListener(listener) { this.listener = listener; } };
}
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${label}${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ""}`);
}

test("live thinking status flows: panel msg -> webhook accept -> log tail -> status updates -> cleared on response ready", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-thinking-"));
  // The forwarder reads its HMAC secret from this file; without it the
  // panel->webhook forward is skipped entirely.
  await fs.writeFile(path.join(bridgeDir, "webhook-secret"), "test-secret");
  const fakeGatewayLog = path.join(bridgeDir, "fake-gateway.log");
  await fs.writeFile(fakeGatewayLog, "");

  // --- Fake webhook: captures the forwarded message, returns "accepted". ---
  let received = null;
  const webhook = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      received = { headers: req.headers, body: JSON.parse(body) };
      res.setHeader("content-type", "application/json");
      // Real gateway returns HTTP 202 on accept (aiohttp async handling) —
      // mirror it exactly, or the test proves a code path production skips.
      res.statusCode = 202;
      res.end(JSON.stringify({ status: "accepted", route: "panel_message", delivery_id: received.headers["x-request-id"] }));
    });
  });
  await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  const webhookPort = webhook.address().port;

  // --- Boot the REAL native host with the fake webhook + fake gateway log. ---
  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
      AB_HERMES_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}/webhooks/panel_message`,
      AB_GATEWAY_LOG_FILE: fakeGatewayLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let hostStderr = "";
  child.stderr.on("data", (c) => { hostStderr += c; });

  // --- Real service worker wired to that host (same harness as other E2Es). ---
  const nativeMessage = event();
  const runtimeMessage = event();
  const broadcasts = [];
  const port = {
    onMessage: nativeMessage,
    onDisconnect: event(),
    postMessage(message) { child.stdin.write(encodeNativeMessage(message)); },
  };
  const passiveEvent = () => event();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: "hkedmoboloodflgcaidimhddljdnndcd",
      connectNative: () => port,
      getManifest: () => ({ version: "0.9.0" }),
      onInstalled: passiveEvent(),
      onStartup: passiveEvent(),
      onMessage: runtimeMessage,
      sendMessage: (message) => { broadcasts.push(message); return Promise.resolve(); },
    },
    action: { onClicked: passiveEvent() },
    tabs: {
      onCreated: passiveEvent(),
      onUpdated: passiveEvent(),
      onRemoved: passiveEvent(),
      onActivated: passiveEvent(),
    },
  };

  const decoder = new NativeMessageDecoder();
  child.stdout.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.type === "request" || message.type === "auth.response") {
        nativeMessage.listener(message, port);
      }
    }
  });

  context.after(async () => {
    globalThis.chrome = previousChrome;
    if (!child.killed) child.kill("SIGTERM");
    await new Promise((resolve) => webhook.close(resolve));
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  await new Promise((resolve) => {
    const check = () => {
      // Wait for the host's "ready" message via runtime.json existence.
      fs.readFile(path.join(bridgeDir, "runtime.json"), "utf8")
        .then(resolve)
        .catch(() => setTimeout(check, 100));
    };
    check();
  });
  child.stdin.write(encodeNativeMessage({ type: "hello", extensionVersion: "0.9.0" }));
  await flush();
  await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?thinking=${crypto.randomUUID()}`);
  // In production Chrome fires onInstalled/onStartup to connect the native
  // port; the harness never does, so trigger it explicitly — without a
  // connected port, emitBrowserEvent silently drops panel.message events.
  globalThis.chrome.runtime.onInstalled.listener({ reason: "install" });
  await flush();
  const sender = { id: globalThis.chrome.runtime.id };

  // --- 1. User types a message; it reaches the fake webhook. ---
  const sent = await new Promise((resolve) => {
    runtimeMessage.listener({ type: "panel.send", text: "find the cheapest whey" }, sender, resolve);
  });
  assert.equal(sent.ok, true);

  await waitFor(() => received, 10_000, `webhook to receive forwarded message (host stderr: ${hostStderr.slice(-400)})`);
  assert.equal(received.body.event_type, "panel.message");
  assert.equal(received.body.text, "find the cheapest whey");
  assert.ok(received.body.conversation_id);
  assert.equal(received.body.resume, false);
  const deliveryId = received.headers["x-request-id"];
  assert.ok(deliveryId && deliveryId.includes(":"), "delivery id carries host-instance nonce");

  // --- 2. Host must push the initial thinking status immediately. ---
  const statusInBroadcast = await waitFor(async () => {
    const updates = broadcasts.filter((m) => m.type === "panel.update" && m.status?.text);
    return updates.length > 0 ? updates[updates.length - 1] : null;
  }, 15_000, `initial thinking status broadcast (host stderr: ${hostStderr.slice(-300)})`);
  assert.equal(statusInBroadcast.status.text, "Planning the approach…");

  // --- 3. A concrete agent-authored summary must survive a generic gateway
  // heartbeat. Heartbeats contain no useful reasoning and must not overwrite it. ---
  const concreteSummary = "Comparing three listings; two match the requested size.";
  await nativeMessage.listener({
    type: "request",
    id: "agent-progress-summary",
    method: "panel.status",
    params: { text: concreteSummary, phase: "compare", evidence: ["2 of 3 listings match the requested size"], next: "Verify stock", persist: true },
  }, port);
  await flush();
  const marker = `webhook:panel_message:${received.body.conversation_id}`;
  await fs.appendFile(fakeGatewayLog,
    `2026-08-21 17:00:01,000 INFO gateway.platforms.webhook: [webhook] Response for ${marker}: ⏳ Working — 3 min — iteration 14/500, vision_analyze\n`);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const afterHeartbeat = broadcasts.filter((m) => m.type === "panel.update").at(-1);
  assert.equal(afterHeartbeat.status.text, concreteSummary);

  // --- 4. Write the completion line; status must clear. ---
  await fs.appendFile(fakeGatewayLog,
    `2026-08-21 17:05:01,000 INFO gateway.run: response ready: platform=webhook chat=${marker} time=300.0s api_calls=20 response=500 chars\n`);
  const clearedUpdate = await waitFor(async () => {
    const updates = broadcasts.filter((m) => m.type === "panel.update");
    const last = updates[updates.length - 1];
    return last && last.status === null ? last : null;
  }, 20_000, `status cleared after response ready. host stderr: ${hostStderr.slice(-300)}`);

  // --- 5. Status is transient: the cleared broadcast carries only the user
  // message in the transcript (no thinking entry was ever recorded). ---
  assert.equal(clearedUpdate.status, null);
  assert.equal(clearedUpdate.transcript.length, 1);
  assert.equal(clearedUpdate.transcript[0].role, "user");
  assert.equal(clearedUpdate.transcript[0].text, "find the cheapest whey");
  assert.equal(clearedUpdate.progress.length, 1, "agent-authored progress survives transient-status clearing");
  assert.equal(clearedUpdate.progress[0].phase, "compare");

  // --- 6. The final reply consumes that bounded progress and stores it as a
  // collapsible research trail on the answer; the next turn starts clean. ---
  await nativeMessage.listener({ type: "request", id: "agent-final", method: "panel.post", params: { text: "Offer B is the cheapest verified match." } }, port);
  await flush();
  const finalUpdate = broadcasts.filter((message) => message.type === "panel.update").at(-1);
  assert.equal(finalUpdate.transcript.length, 2);
  assert.equal(finalUpdate.transcript[1].role, "agent");
  assert.equal(finalUpdate.transcript[1].research.length, 1);
  assert.equal(finalUpdate.transcript[1].research[0].evidence[0], "2 of 3 listings match the requested size");
  assert.equal(finalUpdate.progress.length, 0);

  // --- 7. A later run that exhausts its finite safety budget without posting
  // a result clears the bubble and asks before spending another research pass.
  received = null;
  await new Promise((resolve) => {
    runtimeMessage.listener({ type: "panel.send", text: "search deeper" }, sender, resolve);
  });
  await waitFor(() => received?.body?.text === "search deeper" && received, 10_000, "second webhook delivery");
  const exhaustedMarker = `webhook:panel_message:${received.body.conversation_id}`;
  await fs.appendFile(fakeGatewayLog,
    `2026-08-21 17:10:01,000 INFO gateway.platforms.webhook: [webhook] Response for ${exhaustedMarker}: ⚠️ Iteration budget exhausted (28/28) — asking model to summarise\n` +
    `2026-08-21 17:10:02,000 INFO gateway.run: response ready: platform=webhook chat=${exhaustedMarker} time=300.0s api_calls=28 response=500 chars\n`);
  const continuation = await waitFor(async () => {
    const update = broadcasts.filter((message) => message.type === "panel.update").at(-1);
    const entry = update?.transcript?.at(-1);
    return entry?.role === "agent" && /Would you like me to keep going/i.test(entry.text) ? entry : null;
  }, 20_000, `continuation prompt after safety budget. host stderr: ${hostStderr.slice(-300)}`);
  assert.match(continuation.text, /initial research pass reached its safety limit/i);
});
