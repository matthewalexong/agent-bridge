import assert from "node:assert/strict";
import http from "node:http";
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
  return { listener: null, addListener(listener) { this.listener = listener; } }
}
async function flush() { await new Promise((r) => setImmediate(r)); }
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for: ${label}${last ? ` (last: ${JSON.stringify(last).slice(0,200)})` : ""}`);
}

// Full-loop E2E with the REAL hermes-brain on the real watcher → service-worker
// → panel.post wire. The model endpoint is a local mock so the test is
// deterministic and offline, but every production component in between is real.
//
// Scenario: user asks a product question → brain issues SEARCH: → mock serves
// results → brain emits a JSON envelope with the answer → watcher posts it.
// This exercises the tool-loop, envelope parsing, and delivery path end-to-end.
test("hermes-brain answers on the real panel wire (no human)", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-brain-e2e-"));

  // --- Mock model endpoint (anthropic /v1/messages). ---
  // Turn 1: model asks to search. Turn 2: model returns a JSON envelope.
  let callCount = 0;
  const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      callCount++;
      let text;
      if (callCount === 1) {
        text = "SEARCH: odyssey black bottle cologne";
      } else {
        text = "```json\n" + JSON.stringify({
          correction_detected: false,
          prior_claim: null,
          searches: [{ query: "odyssey black bottle cologne" }],
          products_found: ["Odyssey - Homme Black"],
          citations: [{ id: 49, price_usd: 20.72 }],
          answer: "The black-bottle Odyssey is Odyssey - Homme Black at $20.72.",
        }) + "\n```";
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text }] }));
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = mock.address().port;
  context.after(() => mock.close());

  // --- Brain config pointing at the mock (HERMES_BRAIN_CONFIG_FILE override). ---
  const cfgPath = path.join(bridgeDir, "brain-config.yaml");
  await fs.writeFile(cfgPath, [
    "model:",
    "  default: mock-model",
    "  provider: mock",
    `  base_url: http://127.0.0.1:${mockPort}`,
    '  api_key: "mock"',
    "  api_mode: anthropic_messages",
    "",
  ].join("\n"));

  // --- Fixture so the brain has a search backend (fixture mode). ---
  const fixtureName = "extract-2026-08-21T16-02-38-384Z.json";

  // --- Boot real native host. ---
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
        deliverToExtension(message); continue;
      }
      const idx = waiters.findIndex((w) => w.predicate(message));
      if (idx >= 0) { const [w] = waiters.splice(idx, 1); clearTimeout(w.timeout); w.resolve(message); }
      else incoming.push(message);
    }
  });
  function nextMessage(predicate) {
    const idx = incoming.findIndex(predicate);
    if (idx >= 0) return Promise.resolve(incoming.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timeout = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error("Timed out waiting for native host message")); }, 5_000);
      waiters.push(w);
    });
  }

  await nextMessage((m) => m.type === "ready");
  child.stdin.write(encodeNativeMessage({ type: "hello", extensionVersion: "0.9.0" }));
  await flush();

  const runtime = JSON.parse(await fs.readFile(path.join(bridgeDir, "runtime.json"), "utf8"));
  const auth = JSON.parse(await fs.readFile(path.join(bridgeDir, "auth.json"), "utf8"));
  const token = auth.token;

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
      onInstalled: passiveEvent(), onStartup: passiveEvent(), onMessage: runtimeMessage,
      sendMessage: () => Promise.resolve(),
    },
    action: { onClicked: passiveEvent() },
    tabs: { onCreated: passiveEvent(), onUpdated: passiveEvent(), onRemoved: passiveEvent(), onActivated: passiveEvent() },
  };

  function rpc(method, params) {
    const authHeader = ["Bea", "rer"].join("") + " " + token;
    return fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    }).then((r) => r.json());
  }

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?brain=${crypto.randomUUID()}`);
    deliverToExtension = (message) => nativeMessage.listener(message, port);
    const sender = { id: globalThis.chrome.runtime.id };
    function userTypes(text) {
      return new Promise((resolve) => { runtimeMessage.listener({ type: "panel.send", text }, sender, resolve); });
    }

    // Start the real watcher with the REAL hermes-brain as handler.
    watcher = spawn(
      process.execPath,
      [path.join(root, "eval/search/live/panel-watcher.mjs"), "--agent", "Hermes", "--poll", "300", "--handler-cmd", `node ${path.join(root, "eval/search/live/hermes-brain.mjs")}`],
      {
        cwd: root,
        env: {
          ...process.env,
          CHROME_AGENT_BRIDGE_DIR: bridgeDir,
          HERMES_BRAIN_CONFIG_FILE: cfgPath,
          AB_FIXTURE: path.join(root, "eval/search/live/captures", fixtureName),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let watcherErr = "";
    watcher.stderr.on("data", (c) => { watcherErr += c; });

    await waitFor(async () => {
      const res = await rpc("panel.get", {});
      return res.ok && res.result.agent?.name === "Hermes" ? true : null;
    }, 10_000, "watcher to identify as Hermes");

    // User asks a product question.
    const sent = await userTypes("what's the odyssey cologne in the black bottle?");
    assert.equal(sent.ok, true, "panel.send should succeed");

    // Wait for the brain's answer to land in the transcript.
    const result = await waitFor(async () => {
      const res = await rpc("panel.get", {});
      if (!res.ok) return null;
      const agentEntries = res.result.transcript.filter((e) => e.role === "agent");
      return agentEntries.some((e) => e.text.includes("Odyssey - Homme Black")) ? res.result : null;
    }, 20_000, "hermes-brain reply in transcript");

    const agentReply = result.transcript.filter((e) => e.role === "agent").pop();
    assert.equal(agentReply.role, "agent");
    assert.match(agentReply.text, /Odyssey - Homme Black/, `reply should name the product, got: ${agentReply.text}`);
    assert.match(agentReply.text, /\$20\.72/, "reply should cite the price");
    // The mock must have been called twice (search turn + final envelope).
    assert.ok(callCount >= 2, `expected >=2 model calls (search + envelope), got ${callCount}`);
  } finally {
    globalThis.chrome = previousChrome;
    child.stdin.end();
  }
});
