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
  const transcriptJson = context.transcript ? JSON.stringify(context.transcript) : "";
  if (HANDLER_URL) {
    const res = await fetch(HANDLER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, messageId: context.messageId, transcript: context.transcript ?? [] }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    const reply = data?.reply;
    if (typeof reply !== "string" || !reply.trim()) throw new Error("handler returned no reply");
    return reply.trim();
  }
  if (HANDLER_CMD) {
    const { spawn } = await import("node:child_process");
    const [cmd, ...args] = HANDLER_CMD.split(" ");
    const reply = await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(transcriptJson ? { AB_TRANSCRIPT_JSON: transcriptJson } : {}),
          ...(context.messageId ? { AB_MESSAGE_ID: String(context.messageId), AB_MESSAGE_REVISION: "1" } : {}),
        },
      });
      let out = "", err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("handler command timed out"));
      }, 120_000);
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { err += c; });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && out.trim()) resolve(out.trim());
        else reject(new Error(`handler exited ${code}: ${(err || out).trim().slice(0, 200)}`));
      });
      // Write the message AND close stdin — EOF is required or the handler
      // hangs forever waiting for more input.
      child.stdin.write(text);
      child.stdin.end();
    });
    return reply;
  }
  return `[${agentName}] (echo) ${text}`;
}

// --- Watcher loop ---
let cursor = null; // null = initialize to current stream position on first poll
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

// Answer the stranded message: if the LAST transcript entry is from the user,
// the watcher was down when it arrived and nobody replied — the user is still
// waiting. Without this, any watcher downtime permanently freezes the panel.
async function catchUpStranded() {
  try {
    const st = await callBridge("panel.get");
    const tr = st.transcript ?? [];
    const last = tr[tr.length - 1];
    if (last && last.role === "user" && last.text && last.text.trim()) {
      console.error(`[watcher] catch-up: stranded user message "${last.text.slice(0, 60)}" — answering`);
      try {
        const reply = await handleMessage(last.text, { messageId: last.id, transcript: tr });
        await callBridge("panel.post", { text: reply });
        console.error(`[watcher] catch-up replied (${reply.length} chars)`);
      } catch (e) {
        console.error(`[watcher] catch-up reply failed: ${e.message}`);
        try {
          await callBridge("panel.post", { text: `[${agentName}] Sorry — I couldn't generate a reply (${e.message}).` });
        } catch {}
      }
    } else {
      console.error(`[watcher] catch-up: no stranded user message (last=${last ? last.role : "none"})`);
    }
  } catch (e) {
    console.error(`[watcher] catch-up check failed: ${e.message}`);
  }
}

async function pollOnce() {
  try {
    if (cursor === null) {
      // Start at the CURRENT stream position: never replay and re-answer old
      // panel messages that a previous watcher run (or the user) already saw.
      const snap = await callBridge("events.poll", { afterSequence: 0, timeoutMs: 0 });
      cursor = snap.cursor;
      console.error(`[watcher] starting at event cursor ${cursor}`);
    }
    const res = await callBridge("events.poll", { afterSequence: cursor, timeoutMs: pollMs });
    cursor = res.cursor;
    const panelMessages = res.events.filter((e) => e.event === "panel.message");
    for (const msg of panelMessages) {
      const { text, messageId } = msg.data;
      console.error(`[watcher] panel.message: "${text.slice(0, 80)}"`);
      try {
        // Fetch the transcript so the brain can see what it previously said
        // (needed to detect corrections / wrong answers and re-research).
        let transcript = [];
        try {
          const st = await callBridge("panel.get");
          transcript = st.transcript ?? [];
        } catch {}
        const reply = await handleMessage(text, { messageId, cursor, transcript });
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

  // Answer any message left hanging while no watcher was running.
  await catchUpStranded();

  while (running) {
    await pollOnce();
  }
  console.error("[watcher] stopped");
}

main();
