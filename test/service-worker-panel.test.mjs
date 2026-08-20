import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.crypto ??= webcrypto;

function event() {
  return { listener: null, addListener(listener) { this.listener = listener; } };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadHarness() {
  const nativeMessages = [];
  const broadcasts = [];
  const nativeMessage = event();
  const runtimeMessage = event();
  const port = {
    onMessage: nativeMessage,
    onDisconnect: event(),
    postMessage(message) { nativeMessages.push(message); },
  };
  const passiveEvent = () => event();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: "hkedmoboloodflgcaidimhddljdnndcd",
      connectNative: () => port,
      getManifest: () => ({ version: "0.8.0" }),
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
  await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?panel=${crypto.randomUUID()}`);
  const sender = { id: globalThis.chrome.runtime.id };
  return {
    nativeMessages,
    broadcasts,
    sender,
    sendRuntime: (message) => new Promise((resolve) => {
      runtimeMessage.listener(message, sender, resolve);
    }),
    dispatch: async (id, method, params) => {
      await nativeMessage.listener({ type: "request", id, method, params }, port);
      await flush();
      return nativeMessages.find((message) => message.id === id);
    },
    restore: () => { globalThis.chrome = previousChrome; },
  };
}

test("panel messages reach the agent event stream and replies land in the transcript", async () => {
  const harness = await loadHarness();
  try {
    // 1. User types in the panel: transcript entry + panel.message event out.
    const sent = await harness.sendRuntime({ type: "panel.send", text: "find me the cheapest whey" });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.entry.role, "user");

    const panelEvent = harness.nativeMessages.find((message) =>
      message.type === "event" && message.event === "panel.message");
    assert.ok(panelEvent, "expected a panel.message event on the native port");
    assert.equal(panelEvent.data.role, "user");
    assert.equal(panelEvent.data.text, "find me the cheapest whey");
    assert.equal(panelEvent.data.messageId, sent.result.entry.id);

    // 2. The agent replies through panel.post: transcript grows + broadcast.
    const posted = await harness.dispatch("panel-post", "panel.post", { text: "NOW Foods, $0.044/g" });
    assert.equal(posted.ok, true);
    assert.equal(posted.result.posted, true);
    assert.equal(posted.result.entry.role, "agent");

    const transcript = await harness.dispatch("panel-get", "panel.get", {});
    assert.equal(transcript.ok, true);
    assert.deepEqual(transcript.result.transcript.map((entry) => entry.role), ["user", "agent"]);
    assert.equal(transcript.result.transcript[1].text, "NOW Foods, $0.044/g");

    const updates = harness.broadcasts.filter((message) => message.type === "panel.update");
    assert.ok(updates.length >= 2, "expected panel.update broadcasts after send and post");
    const update = updates[updates.length - 1];
    assert.equal(update.transcript.length, 2);

    // 3. Hydrate + clear round-trip from the panel page.
    const hydrated = await harness.sendRuntime({ type: "panel.get" });
    assert.equal(hydrated.result.transcript.length, 2);

    const cleared = await harness.sendRuntime({ type: "panel.clear" });
    assert.equal(cleared.ok, true);
    const after = await harness.dispatch("panel-get-2", "panel.get", {});
    assert.equal(after.result.transcript.length, 0);
  } finally {
    harness.restore();
  }
});

test("panel input validation rejects empty, non-string, and oversized text", async () => {
  const harness = await loadHarness();
  try {
    const empty = await harness.sendRuntime({ type: "panel.send", text: "   " });
    assert.equal(empty.ok, false);
    assert.equal(empty.error.code, "invalid_request");

    const nonString = await harness.dispatch("panel-bad", "panel.post", { text: 42 });
    assert.equal(nonString.ok, false);
    assert.equal(nonString.error.code, "invalid_request");

    const oversized = await harness.dispatch("panel-big", "panel.post", { text: "x".repeat(20_001) });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error.code, "too_large");

    // Nothing was recorded.
    const transcript = await harness.dispatch("panel-get-3", "panel.get", {});
    assert.equal(transcript.result.transcript.length, 0);
  } finally {
    harness.restore();
  }
});
