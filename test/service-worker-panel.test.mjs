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
    const afterSend = await harness.dispatch("after-send", "panel.get", {});
    assert.equal(afterSend.result.status?.text, "Working…");
    assert.equal(afterSend.result.status?.phase, "working");

    const panelEvent = harness.nativeMessages.find((message) =>
      message.type === "event" && message.event === "panel.message");
    assert.ok(panelEvent, "expected a panel.message event on the native port");
    assert.equal(panelEvent.data.role, "user");
    assert.equal(panelEvent.data.text, "find me the cheapest whey");
    assert.equal(panelEvent.data.messageId, sent.result.entry.id);
    assert.equal(sent.result.resume, false);
    assert.match(sent.result.conversationId, /^c[a-f0-9]{32}$/);
    assert.equal(panelEvent.data.conversationId, sent.result.conversationId);
    assert.equal(panelEvent.data.resume, false);

    // 2. The agent replies through panel.post: transcript grows + broadcast.
    const posted = await harness.dispatch("panel-post", "panel.post", { text: "NOW Foods, $0.044/g" });
    assert.equal(posted.ok, true);
    assert.equal(posted.result.posted, true);
    assert.equal(posted.result.entry.role, "agent");

    const transcript = await harness.dispatch("panel-get", "panel.get", {});
    assert.equal(transcript.ok, true);
    assert.deepEqual(transcript.result.transcript.map((entry) => entry.role), ["user", "agent"]);
    assert.equal(transcript.result.transcript[1].text, "NOW Foods, $0.044/g");
    assert.equal(transcript.result.status, null);

    const updates = harness.broadcasts.filter((message) => message.type === "panel.update");
    assert.ok(updates.length >= 2, "expected panel.update broadcasts after send and post");
    const update = updates[updates.length - 1];
    assert.equal(update.transcript.length, 2);

    // 3. Hydrate + clear round-trip from the panel page.
    const hydrated = await harness.sendRuntime({ type: "panel.get" });
    assert.equal(hydrated.result.transcript.length, 2);

    const cleared = await harness.sendRuntime({ type: "panel.clear" });
    assert.equal(cleared.ok, true);
    const closeEvent = harness.nativeMessages.find((message) => message.type === "event" && message.event === "panel.close");
    assert.ok(closeEvent, "clear must end the Hermes conversation");
    assert.equal(closeEvent.data.conversationId, sent.result.conversationId);
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

test("panel.status sets a transient thinking status, broadcasts it, and clears", async () => {
  const harness = await loadHarness();
  try {
    const set = await harness.dispatch("status-set", "panel.status", { text: "Thinking… 2 min elapsed · step 9 · vision_analyze" });
    assert.equal(set.ok, true);
    assert.equal(set.result.status.text, "Thinking… 2 min elapsed · step 9 · vision_analyze");

    // Carried in panel.get and in broadcasts.
    const got = await harness.dispatch("status-get", "panel.get", {});
    assert.equal(got.result.status.text, "Thinking… 2 min elapsed · step 9 · vision_analyze");
    const updates = harness.broadcasts.filter((message) => message.type === "panel.update");
    assert.equal(updates[updates.length - 1].status.text, "Thinking… 2 min elapsed · step 9 · vision_analyze");

    // Status is transient: NOT part of the transcript.
    assert.equal(got.result.transcript.length, 0);
    assert.equal(got.result.progress.length, 1);

    // Clearing with empty/null text removes it (reply landed).
    const cleared = await harness.dispatch("status-clear", "panel.status", { text: "  " });
    assert.equal(cleared.result.status, null);
    const after = await harness.dispatch("status-after", "panel.get", {});
    assert.equal(after.result.status, null);
    assert.ok(after.result.capabilities.includes("status:v1"));
    assert.ok(after.result.capabilities.includes("research-trail:v1"));
  } finally {
    harness.restore();
  }
});

test("structured progress is bounded, deduplicated, and attached to the final answer", async () => {
  const harness = await loadHarness();
  try {
    await harness.sendRuntime({ type: "panel.send", text: "compare these two laptops" });
    const generic = await harness.dispatch("generic", "panel.status", { text: "Planning the approach…", phase: "plan", persist: false });
    assert.equal(generic.result.progress.length, 0, "host placeholder must not become research evidence");

    const plan = { text: "Checking exact models and final prices.", phase: "plan", evidence: ["Two candidate listings supplied"], next: "Verify identity and fulfillment", persist: true };
    await harness.dispatch("progress-plan", "panel.status", plan);
    await harness.dispatch("progress-plan-duplicate", "panel.status", plan);
    await harness.dispatch("progress-verify", "panel.status", {
      text: "Both models match; one total includes an estimated tax range.", phase: "verify",
      evidence: ["Offer A: $1,020–$1,080 landed", `Credential ${"xai-" + "A".repeat(24)}`, ...Array(10).fill("extra evidence")],
      next: "Compare ranges without assuming the expected value", persist: true,
    });
    let state = await harness.dispatch("progress-get", "panel.get", {});
    assert.equal(state.result.progress.length, 2, "identical status updates are deduplicated");
    assert.equal(state.result.progress[1].evidence.length, 5, "evidence is bounded");
    assert.equal(state.result.progress[1].evidence[1], "[Sensitive detail omitted]", "credentials are never retained in a trail");
    assert.equal(state.result.status.phase, "verify");

    const posted = await harness.dispatch("progress-post", "panel.post", { text: "The totals overlap, so I need your preference on uncertainty." });
    assert.equal(posted.result.entry.research.length, 2);
    assert.equal(posted.result.entry.research[0].phase, "plan");
    assert.equal(posted.result.entry.research[1].next, "Compare ranges without assuming the expected value");
    state = await harness.dispatch("progress-after", "panel.get", {});
    assert.equal(state.result.progress.length, 0);
    assert.equal(state.result.status, null);
    assert.equal(state.result.transcript[1].research.length, 2, "trail survives as part of the answer entry");

    await harness.sendRuntime({ type: "panel.send", text: "now compare phones" });
    const nextTurn = await harness.dispatch("progress-next-turn", "panel.get", {});
    assert.equal(nextTurn.result.progress.length, 0, "research never leaks into the next user turn");
    const followUp = harness.nativeMessages.filter((message) => message.type === "event" && message.event === "panel.message").at(-1);
    assert.equal(followUp.data.resume, true);
    assert.ok(followUp.data.conversationId);
  } finally {
    harness.restore();
  }
});

test("panel.identify names the connected agent and broadcasts it", async () => {
  const harness = await loadHarness();
  try {
    // Initially no agent is identified.
    const before = await harness.dispatch("ident-before", "panel.get", {});
    assert.equal(before.result.agent, null);

    // Agent identifies itself (e.g. Hermes via browser_panel_identify).
    const identified = await harness.dispatch("ident", "panel.identify", { agent: "Hermes" });
    assert.equal(identified.ok, true);
    assert.equal(identified.result.agent.name, "Hermes");
    assert.ok(identified.result.agent.since);

    // panel.get now reports the identity.
    const after = await harness.dispatch("ident-after", "panel.get", {});
    assert.equal(after.result.agent.name, "Hermes");

    // Broadcast carried the identity so an open panel updates live.
    const updates = harness.broadcasts.filter((message) => message.type === "panel.update");
    assert.equal(updates[updates.length - 1].agent.name, "Hermes");

    // A second agent takes over (most recent caller wins).
    const second = await harness.dispatch("ident-2", "panel.identify", { agent: "OpenClaw" });
    assert.equal(second.result.agent.name, "OpenClaw");
    const finalState = await harness.dispatch("ident-final", "panel.get", {});
    assert.equal(finalState.result.agent.name, "OpenClaw");

    // Validation: empty and oversized names rejected, identity unchanged.
    const emptyName = await harness.dispatch("ident-empty", "panel.identify", { agent: "   " });
    assert.equal(emptyName.ok, false);
    assert.equal(emptyName.error.code, "invalid_request");
    const bigName = await harness.dispatch("ident-big", "panel.identify", { agent: "x".repeat(81) });
    assert.equal(bigName.ok, false);
    assert.equal(bigName.error.code, "too_large");
    const unchanged = await harness.dispatch("ident-check", "panel.get", {});
    assert.equal(unchanged.result.agent.name, "OpenClaw");
  } finally {
    harness.restore();
  }
});

test("panel.post link cards are stored, sanitized, and reported in panel.get", async () => {
  const harness = await loadHarness();
  try {
    const goodLink = {
      url: "https://www.amazon.com/dp/B0DR8D9H55",
      title: "Odyssey Homme Black EDP 2.02 oz",
      image: "https://m.media-amazon.com/images/I/thumb.jpg",
      price: "$20.72",
    };
    const posted = await harness.dispatch("links-post", "panel.post", {
      text: "Best match below.",
      links: [
        goodLink,
        { url: "javascript:alert(1)", title: "evil scheme" }, // stripped: non-http
        { url: "https://ok.example.com", title: "t".repeat(500) }, // title truncated
        { url: "not a url", title: "garbage" }, // stripped: unparseable
      ],
    });
    assert.equal(posted.ok, true);
    const stored = posted.result.entry.links;
    assert.equal(stored.length, 2, "only http(s) links survive sanitization");
    assert.equal(stored[0].url, goodLink.url);
    assert.equal(stored[0].title, goodLink.title);
    assert.equal(stored[0].image, goodLink.image);
    assert.equal(stored[0].price, "$20.72");
    assert.ok(stored[1].title.length <= 200, "oversized title truncated");

    // panel.get surfaces the links so the panel page can render cards.
    const got = await harness.dispatch("links-get", "panel.get", {});
    assert.equal(got.result.transcript[0].links.length, 2);

    // Capabilities probe is present (lets a stale panel detect an old SW).
    assert.ok(Array.isArray(got.result.capabilities), "panel.get reports capabilities");
    assert.ok(got.result.capabilities.includes("links:v1"));

    // A post with no links omits the field entirely.
    const bare = await harness.dispatch("links-bare", "panel.post", { text: "no links" });
    assert.equal(bare.result.entry.links, undefined);
  } finally {
    harness.restore();
  }
});
