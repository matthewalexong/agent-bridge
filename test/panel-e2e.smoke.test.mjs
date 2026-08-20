import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.crypto ??= webcrypto;

function event() {
  return { listener: null, addListener(listener) { this.listener = listener; } };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

// End-to-end smoke test: real native host process + real service worker.
//
// Full protocol loop:
//   1. Agent identifies itself via panel.identify (RPC over the bridge)
//   2. User types in the panel → service worker emits panel.message event
//   3. Event lands in the native host's event buffer
//   4. Agent polls events.poll and sees the panel.message
//   5. Agent posts a reply via panel.post (RPC over the bridge)
//   6. Reply lands in the transcript with role "agent"
test("panel chat round-trip through a real native host", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-e2e-"));
  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: { ...process.env, CHROME_AGENT_BRIDGE_DIR: bridgeDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(async () => {
    if (!child.killed) child.kill("SIGTERM");
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  const decoder = new NativeMessageDecoder();
  const incoming = [];
  const waiters = [];
  // Messages the host sends TO the extension (request / auth.response) must be
  // delivered to the service worker's native port listener. Everything else is
  // consumed by the test via nextMessage.
  let deliverToExtension = null; // set after the service worker loads
  child.stdout.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (deliverToExtension && (message.type === "request" || message.type === "auth.response")) {
        deliverToExtension(message);
        continue;
      }
      const idx = waiters.findIndex((w) => w.predicate(message));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        clearTimeout(w.timeout);
        w.resolve(message);
      } else incoming.push(message);
    }
  });

  function nextMessage(predicate) {
    const idx = incoming.findIndex(predicate);
    if (idx >= 0) return Promise.resolve(incoming.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timeout = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error("Timed out waiting for native host message"));
      }, 5_000);
      waiters.push(w);
    });
  }

  // --- Boot the native host and load the real service worker against it. ---
  await nextMessage((m) => m.type === "ready");
  child.stdin.write(encodeNativeMessage({ type: "hello", extensionVersion: "0.9.0" }));
  await flush();

  const runtime = JSON.parse(await fs.readFile(path.join(bridgeDir, "runtime.json"), "utf8"));
  const auth = JSON.parse(await fs.readFile(path.join(bridgeDir, "auth.json"), "utf8"));
  const token = auth.token;

  // Load the service worker with a fake chrome that forwards to the real host.
  const nativeMessages = [];
  const broadcasts = [];
  const nativeMessage = event();
  const runtimeMessage = event();
  const port = {
    onMessage: nativeMessage,
    onDisconnect: event(),
    postMessage(message) { nativeMessages.push(message); child.stdin.write(encodeNativeMessage(message)); },
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

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?e2e=${crypto.randomUUID()}`);
    // Deliver host→extension messages (RPC requests) to the service worker.
    deliverToExtension = (message) => nativeMessage.listener(message, port);
    const sender = { id: globalThis.chrome.runtime.id };

    function rpc(method, params) {
      return fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
      }).then((r) => r.json());
    }

    // --- Step 1: Agent identifies itself. ---
    const identifyRes = await rpc("panel.identify", { agent: "Hermes" });
    assert.equal(identifyRes.ok, true);
    assert.equal(identifyRes.result.agent.name, "Hermes");

    // --- Step 2: User types in the panel. ---
    const sent = await new Promise((resolve) => {
      runtimeMessage.listener({ type: "panel.send", text: "what's the cheapest protein?" }, sender, resolve);
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.entry.role, "user");

    // --- Step 3+4: Agent polls the event stream and sees panel.message. ---
    const pollRes = await rpc("events.poll", { afterSequence: 0, timeoutMs: 5_000 });
    assert.equal(pollRes.ok, true);
    const panelEvents = pollRes.result.events.filter((e) => e.event === "panel.message");
    assert.ok(panelEvents.length >= 1, "expected at least one panel.message event");
    assert.equal(panelEvents[0].data.text, "what's the cheapest protein?");
    assert.equal(panelEvents[0].data.role, "user");

    // --- Step 5: Agent replies. ---
    const replyRes = await rpc("panel.post", { text: "NOW Foods Isolate at $0.044/g protein." });
    assert.equal(replyRes.ok, true);
    assert.equal(replyRes.result.posted, true);

    // --- Step 6: Transcript has both messages with correct roles. ---
    const transcriptRes = await rpc("panel.get", {});
    assert.equal(transcriptRes.ok, true);
    const entries = transcriptRes.result.transcript;
    assert.equal(entries.length, 2);
    assert.equal(entries[0].role, "user");
    assert.equal(entries[0].text, "what's the cheapest protein?");
    assert.equal(entries[1].role, "agent");
    assert.equal(entries[1].text, "NOW Foods Isolate at $0.044/g protein.");
    assert.equal(transcriptRes.result.agent.name, "Hermes");

    // --- Broadcasts reached the panel UI. ---
    const updates = broadcasts.filter((m) => m.type === "panel.update");
    assert.ok(updates.length >= 2, "expected panel.update broadcasts");
    assert.equal(updates[updates.length - 1].agent.name, "Hermes");
    assert.equal(updates[updates.length - 1].transcript.length, 2);
  } finally {
    globalThis.chrome = previousChrome;
    child.stdin.end();
  }
});
