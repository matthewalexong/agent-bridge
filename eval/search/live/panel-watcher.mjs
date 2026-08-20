#!/usr/bin/env node
// panel-watcher.mjs — long-lived agent-side watcher for the side panel chat.
//
// Polls the bridge event stream for panel.message events and responds.
// This is what makes the chat "live": without a watcher, user messages
// sit unanswered.
//
// Usage:
//   node eval/search/live/panel-watcher.mjs [--agent "Hermes"] [--poll 3000]
//
// The watcher:
//   1. Identifies itself via panel.identify (shows "Connected to <agent>")
//   2. Polls events.poll for panel.message events
//   3. When one arrives, calls the reply handler
//   4. Posts the reply via panel.post
//
// The reply handler is pluggable — swap `handleMessage` with whatever
// intelligence you want (local model, API call, echo, etc.).

import { callBridge } from "../../../lib/bridge-client.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const agentName = arg("agent", process.env.CHROME_AGENT_BRIDGE_AGENT_NAME || "MCP Agent");
const pollMs = Number(arg("poll", 3000));

// --- Reply handler ---
// The watcher is a pure transport. The BRAIN is the connected agent:
//   - If an agent is attached via MCP, it should run its own event loop
//     (browser_watch_events) and answer via browser_panel_post — no watcher
//     needed.
//   - This watcher is for headless/demo use: forward each user message to an
//     external command or URL so ANY agent can plug in. No model is
//     hardcoded here.
//
// Plug in a brain:
//   --handler-cmd "node /path/to/your/brain.mjs"   (stdin = message, stdout = reply)
//   --handler-url "http://your-agent:port/reply"    (POST {text}, JSON {reply})
// With neither, it echoes — so you can verify the loop without a brain.
const HANDLER_CMD = arg("handler-cmd", process.env.CHROME_AGENT_BRIDGE_HANDLER_CMD || null);
const HANDLER_URL = arg("handler-url", process.env.CHROME_AGENT_BRIDGE_HANDLER_URL || null);

async function handleMessage(text, context) {
  if (HANDLER_URL) {
    const res = await fetch(HANDLER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, messageId: context.messageId }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    const reply = data?.reply;
    if (typeof reply !== "string" || !reply.trim()) throw new Error("handler returned no reply");
    return reply.trim();
  }
  if (HANDLER_CMD) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const [cmd, ...args] = HANDLER_CMD.split(" ");
    const { stdout } = await run(cmd, args, { input: text, timeout: 120_000, maxBuffer: 1024 * 1024 });
    const reply = stdout.trim();
    if (!reply) throw new Error("handler command produced no output");
    return reply;
  }
  return `[${agentName}] (echo) ${text}`;
}

// --- Watcher loop ---
let cursor = 0;
let running = true;

process.on("SIGINT", () => { running = false; console.error("\n[watcher] stopping..."); });
process.on("SIGTERM", () => { running = false; });

async function identify() {
  try {
    const res = await callBridge("panel.identify", { agent: agentName });
    console.error(`[watcher] identified as "${res.agent.name}" (since ${res.agent.since})`);
  } catch (e) {
    // panel.identify requires v0.9.0+; degrade gracefully on older versions.
    console.error(`[watcher] identify failed (${e.code}) — panel may need reload for identity display`);
  }
}

async function pollOnce() {
  try {
    const res = await callBridge("events.poll", { afterSequence: cursor, timeoutMs: pollMs });
    cursor = res.cursor;
    const panelMessages = res.events.filter((e) => e.event === "panel.message");
    for (const msg of panelMessages) {
      const { text, messageId } = msg.data;
      console.error(`[watcher] panel.message: "${text.slice(0, 80)}"`);
      try {
        const reply = await handleMessage(text, { messageId, cursor });
        await callBridge("panel.post", { text: reply });
        console.error(`[watcher] replied (${reply.length} chars)`);
      } catch (e) {
        console.error(`[watcher] reply failed: ${e.message}`);
        // Tell the user in the panel rather than failing silently.
        try {
          await callBridge("panel.post", { text: `[${agentName}] Sorry — I couldn't generate a reply (${e.message}).` });
        } catch { /* bridge offline; nothing more to do */ }
      }
    }
    return panelMessages.length;
  } catch (e) {
    if (e.code === "bridge_offline") {
      console.error("[watcher] bridge offline, retrying...");
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      console.error(`[watcher] poll error: ${e.message}`);
    }
    return 0;
  }
}

async function main() {
  console.error(`[watcher] starting as "${agentName}", poll every ${pollMs}ms`);
  await identify();

  // Catch up on any existing unread panel messages.
  await pollOnce();

  while (running) {
    await pollOnce();
  }
  console.error("[watcher] stopped");
}

main();
