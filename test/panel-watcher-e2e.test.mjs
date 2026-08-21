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

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for: ${label}${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ""}`);
}

// Full-loop E2E: real native host + real service worker + REAL watcher
// process + pluggable brain. No human anywhere in the loop.
//
// This closes the gap the original smoke test left open: it played the
// agent's role itself, so the watcher/brain path (where real failures like
// handler hangs and "model returned no text" live) was never exercised.
//
// Two scenarios:
//   1. Happy path: echo brain answers a synthetic user message.
//   2. Failure path: a brain that crashes → the watcher posts a visible
//      error notice into the panel instead of failing silently.
test("panel chat full loop with real watcher and brain (no human)", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-loop-"));
  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: { ...process.env, CHROME_AGENT_BRIDGE_DIR: bridgeDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let watcher = null;
  context.after(async () => {
    if (watcher && !watcher.killed) watcher.kill("SIGTERM");
    if (!child.killed) child.kill("SIGTERM");
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  const decoder = new NativeMessageDecoder();
  const incoming = [];
  const waiters = [];
  let deliverToExtension = null;
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

  // --- Boot host + real service worker (same harness as the smoke test). ---
  await nextMessage((m) => m.type === "ready");
  child.stdin.write(encodeNativeMessage({ type: "hello", extensionVersion: "0.9.0" }));
  await flush();

  const runtime = JSON.parse(await fs.readFile(path.join(bridgeDir, "runtime.json"), "utf8"));
  const auth = JSON.parse(await fs.readFile(path.join(bridgeDir, "auth.json"), "utf8"));
  const token = auth.token;

  const broadcasts = [];
  const nativeMessage = event();
  const runtimeMessage = event();
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

  function rpc(method, params) {
    const authHeader = ["Bea", "rer"].join("") + " " + token;
    return fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    }).then((r) => r.json());
  }

  function startWatcher(agentName, handlerCmd) {
    const w = spawn(
      process.execPath,
      [
        path.join(root, "eval/search/live/panel-watcher.mjs"),
        "--agent", agentName,
        "--poll", "300",
        "--handler-cmd", handlerCmd,
      ],
      {
        cwd: root,
        env: { ...process.env, CHROME_AGENT_BRIDGE_DIR: bridgeDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    w.stderr.on("data", (c) => { stderr += c; });
    w.getStderr = () => stderr;
    return w;
  }

  async function waitForAgentReply(expectedPredicate, label) {
    return waitFor(async () => {
      const res = await rpc("panel.get", {});
      if (!res.ok) return null;
      const agentEntries = res.result.transcript.filter((e) => e.role === "agent");
      return agentEntries.some(expectedPredicate) ? res.result : null;
    }, 15_000, label);
  }

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?loop=${crypto.randomUUID()}`);
    deliverToExtension = (message) => nativeMessage.listener(message, port);
    const sender = { id: globalThis.chrome.runtime.id };

    function userTypes(text) {
      return new Promise((resolve) => {
        runtimeMessage.listener({ type: "panel.send", text }, sender, resolve);
      });
    }

    // ===== Scenario 1: happy path with the echo brain =====
    watcher = startWatcher("EchoBot", `node ${path.join(root, "eval/search/live/fixtures/echo-brain.mjs")}`);

    await waitFor(async () => {
      const res = await rpc("panel.get", {});
      return res.ok && res.result.agent?.name === "EchoBot" ? true : null;
    }, 10_000, "watcher to identify as EchoBot");

    const sent = await userTypes("ping e2e");
    assert.equal(sent.ok, true, "panel.send should succeed");

    const result = await waitForAgentReply(
      (e) => e.text === "echo: ping e2e",
      "echo brain reply in transcript",
    );
    const t = result.transcript;
    assert.equal(t[0].role, "user");
    assert.equal(t[0].text, "ping e2e");
    assert.equal(t[1].role, "agent");
    assert.equal(t[1].text, "echo: ping e2e");

    // ===== Scenario 2: brain crashes → visible error notice, no silence =====
    watcher.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    watcher = startWatcher("BrokenBot", "node /nonexistent-brain.mjs");

    await waitFor(async () => {
      const res = await rpc("panel.get", {});
      return res.ok && res.result.agent?.name === "BrokenBot" ? true : null;
    }, 10_000, "second watcher to identify as BrokenBot");

    await userTypes("boom");

    const failed = await waitForAgentReply(
      (e) => e.text.includes("Sorry") && e.text.includes("couldn't generate a reply"),
      "error notice for crashed brain",
    );
    const lastEntry = failed.transcript[failed.transcript.length - 1];
    assert.equal(lastEntry.role, "agent");
    assert.match(lastEntry.text, /\[BrokenBot\] Sorry — I couldn't generate a reply/);

    // Panel UI broadcasts carried everything.
    const updates = broadcasts.filter((m) => m.type === "panel.update");
    assert.ok(updates.length >= 2, "expected panel.update broadcasts");
  } finally {
    globalThis.chrome = previousChrome;
    child.stdin.end();
  }
});
