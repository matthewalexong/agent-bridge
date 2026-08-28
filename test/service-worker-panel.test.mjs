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

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadHarness({ sessionStore = new Map() } = {}) {
  const nativeMessages = [];
  const broadcasts = [];
  const nativeMessage = event();
  const runtimeMessage = event();
  const runtimeConnect = event();
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
      onConnect: runtimeConnect,
      onMessage: runtimeMessage,
      sendMessage: (message) => { broadcasts.push(message); return Promise.resolve(); },
    },
    action: { onClicked: passiveEvent() },
    storage: {
      session: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => sessionStore.has(key)).map((key) => [key, sessionStore.get(key)]));
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) sessionStore.set(key, value);
        },
        async remove(keys) {
          for (const key of keys) sessionStore.delete(key);
        },
      },
    },
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
    connectPanel: () => {
      const panelPort = { name: "agent-bridge-panel-lifecycle", onDisconnect: event() };
      runtimeConnect.listener(panelPort);
      return { disconnect: () => panelPort.onDisconnect.listener() };
    },
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

test("authenticated bridge panel.send uses the same conversation event path as the panel UI", async () => {
  const harness = await loadHarness();
  try {
    const sent = await harness.dispatch("diagnostic-send", "panel.send", {
      text: "find current 128GB unified-memory local AI machines",
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.entry.role, "user");
    assert.equal(sent.result.resume, false);
    assert.match(sent.result.conversationId, /^c[a-f0-9]{32}$/);

    const panelEvent = harness.nativeMessages.find((message) =>
      message.type === "event" && message.event === "panel.message");
    assert.ok(panelEvent);
    assert.equal(panelEvent.data.text, "find current 128GB unified-memory local AI machines");
    assert.equal(panelEvent.data.messageId, sent.result.entry.id);
    assert.equal(panelEvent.data.conversationId, sent.result.conversationId);

    const state = await harness.dispatch("diagnostic-state", "panel.get", {});
    assert.equal(state.result.transcript.at(-1).text, panelEvent.data.text);
    assert.equal(state.result.status?.text, "Working…");
  } finally {
    harness.restore();
  }
});

test("one Hermes conversation lasts until the side panel closes", async () => {
  const harness = await loadHarness();
  try {
    const panel = harness.connectPanel();
    const first = await harness.sendRuntime({ type: "panel.send", text: "find a safe camera" });
    const second = await harness.sendRuntime({ type: "panel.send", text: "only show weather-sealed options" });
    assert.equal(second.result.conversationId, first.result.conversationId);
    assert.equal(second.result.resume, true);

    panel.disconnect();
    await wait(350);
    const closeEvent = harness.nativeMessages.find((message) => message.type === "event" && message.event === "panel.close");
    assert.equal(closeEvent.data.conversationId, first.result.conversationId);
    const afterClose = await harness.dispatch("after-panel-close", "panel.get", {});
    assert.equal(afterClose.result.transcript.length, 0);

    harness.connectPanel();
    const reopened = await harness.sendRuntime({ type: "panel.send", text: "now find headphones" });
    assert.notEqual(reopened.result.conversationId, first.result.conversationId);
    assert.equal(reopened.result.resume, false);
  } finally {
    harness.restore();
  }
});

test("a quick side-panel reload preserves the active Hermes conversation", async () => {
  const harness = await loadHarness();
  try {
    const firstPanel = harness.connectPanel();
    const first = await harness.sendRuntime({ type: "panel.send", text: "compare two laptops" });
    firstPanel.disconnect();
    await wait(50);
    harness.connectPanel();
    await wait(300);
    const second = await harness.sendRuntime({ type: "panel.send", text: "focus on battery life" });
    assert.equal(second.result.conversationId, first.result.conversationId);
    assert.equal(second.result.resume, true);
    assert.equal(harness.nativeMessages.some((message) => message.type === "event" && message.event === "panel.close"), false);
  } finally {
    harness.restore();
  }
});

test("a service-worker reload never resumes hidden context behind a New session label", async () => {
  const staleConversationId = `c${"a".repeat(32)}`;
  const sessionStore = new Map([
    ["panelConversationId", staleConversationId],
    ["panelConversationStarted", true],
    ["panelHarnessSession", false],
  ]);
  const harness = await loadHarness({ sessionStore });
  try {
    const before = await harness.sendRuntime({ type: "panel.get" });
    assert.equal(before.result.selectedSessionId, null, "the UI truthfully presents a new session");

    const sent = await harness.sendRuntime({ type: "panel.send", text: "Research this from scratch" });
    assert.notEqual(sent.result.conversationId, staleConversationId);
    assert.equal(sent.result.resume, false);
  } finally {
    harness.restore();
  }
});

test("previous harness sessions can be listed, loaded, and resumed without copying context into browser storage", async () => {
  const harness = await loadHarness();
  try {
    const refresh = await harness.sendRuntime({ type: "panel.sessions.refresh" });
    assert.equal(refresh.ok, true);
    const listEvent = harness.nativeMessages.find((message) => message.type === "event" && message.event === "panel.sessions.list");
    assert.equal(listEvent.data.requestId, refresh.result.requestId);

    await harness.dispatch("sessions-update", "panel.sessions.update", { sessions: [
      { id: "session-shop", title: "Compare local AI machines", updatedAt: "2026-08-27T00:00:00.000Z", running: false },
    ] });
    const listed = await harness.sendRuntime({ type: "panel.get" });
    assert.equal(listed.result.sessions[0].title, "Compare local AI machines");
    assert.ok(listed.result.capabilities.includes("harness-session-picker:v1"));

    const selected = await harness.sendRuntime({ type: "panel.session.select", sessionId: "session-shop" });
    assert.equal(selected.ok, true);
    const selectEvent = harness.nativeMessages.find((message) => message.type === "event" && message.event === "panel.session.select");
    assert.equal(selectEvent.data.sessionId, "session-shop");

    await harness.dispatch("session-loaded", "panel.session.loaded", {
      sessionId: "session-shop",
      transcript: [{ id: "old-1", role: "user", text: "Find a local AI machine", at: "2026-08-27T00:00:00.000Z" }],
    });
    const resumed = await harness.sendRuntime({ type: "panel.send", text: "Show the cheapest options" });
    assert.equal(resumed.result.conversationId, "session-shop");
    assert.equal(resumed.result.resume, true);
    const messageEvent = harness.nativeMessages.filter((message) => message.type === "event" && message.event === "panel.message").at(-1);
    assert.equal(messageEvent.data.harnessSession, true);

    const removal = await harness.sendRuntime({ type: "panel.session.remove", sessionId: "session-shop" });
    assert.equal(removal.ok, true);
    const archiveEvent = harness.nativeMessages.find((message) => message.type === "event" && message.event === "panel.session.archive");
    assert.equal(archiveEvent.data.sessionId, "session-shop");
    await harness.dispatch("session-archived", "panel.session.archived", { sessionId: "session-shop" });
    const afterRemoval = await harness.sendRuntime({ type: "panel.get" });
    assert.equal(afterRemoval.result.sessions.length, 0);
    assert.equal(afterRemoval.result.selectedSessionId, null);
    assert.ok(afterRemoval.result.capabilities.includes("harness-session-remove:v1"));

    const closeEvent = harness.nativeMessages.filter((message) => message.type === "event" && message.event === "panel.close").at(-1);
    assert.equal(closeEvent.data.harnessSession, true, "closing detaches the panel without ending harness-owned context");
  } finally {
    harness.restore();
  }
});

test("a newly accepted harness session is titled in the picker without changing webhook follow-up routing", async () => {
  const harness = await loadHarness();
  try {
    const first = await harness.sendRuntime({ type: "panel.send", text: "Map the 128 GB local AI landscape" });
    await harness.dispatch("session-started", "panel.session.started", {
      sessionId: "session-created",
      title: "Map the 128 GB local AI landscape",
      updatedAt: "2026-08-27T00:00:00.000Z",
      running: true,
    });
    const state = await harness.sendRuntime({ type: "panel.get" });
    assert.equal(state.result.selectedSessionId, "session-created");
    assert.equal(state.result.sessions[0].title, "Map the 128 GB local AI landscape");
    assert.ok(state.result.capabilities.includes("harness-session-rename:v1"));

    const followUp = await harness.sendRuntime({ type: "panel.send", text: "Tell me more about AMD" });
    assert.equal(followUp.result.conversationId, first.result.conversationId);
    assert.equal(followUp.result.resume, true);
    const messageEvent = harness.nativeMessages.filter((message) => message.type === "event" && message.event === "panel.message").at(-1);
    assert.equal(messageEvent.data.harnessSession, false);

    const rename = await harness.sendRuntime({ type: "panel.session.rename", sessionId: "session-created", title: "AI workstations" });
    assert.equal(rename.ok, true);
    const renameEvent = harness.nativeMessages.find((message) => message.type === "event" && message.event === "panel.session.rename");
    assert.deepEqual({ sessionId: renameEvent.data.sessionId, title: renameEvent.data.title }, { sessionId: "session-created", title: "AI workstations" });
    await harness.dispatch("session-renamed", "panel.session.renamed", { sessionId: "session-created", title: "AI workstations" });
    const renamedState = await harness.sendRuntime({ type: "panel.get" });
    assert.equal(renamedState.result.sessions[0].title, "AI workstations");
  } finally {
    harness.restore();
  }
});

test("active harness sessions cannot be removed", async () => {
  const harness = await loadHarness();
  try {
    await harness.dispatch("sessions-running", "panel.sessions.update", { sessions: [
      { id: "session-running", title: "Active research", updatedAt: "2026-08-27T00:00:00.000Z", running: true },
    ] });
    const removal = await harness.sendRuntime({ type: "panel.session.remove", sessionId: "session-running" });
    assert.equal(removal.ok, false);
    assert.equal(removal.error.code, "session_running");
    assert.equal(harness.nativeMessages.some((message) => message.type === "event" && message.event === "panel.session.archive"), false);
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

test("terminal decision milestones never leave an animated busy status", async () => {
  const harness = await loadHarness();
  try {
    const active = await harness.dispatch("decision-active", "panel.status", {
      text: "Comparing the finalists.", phase: "decision", next: "Post the verified answer",
    });
    assert.equal(active.result.status.phase, "decision", "an unfinished decision remains active");

    const finished = await harness.dispatch("decision-finished", "panel.status", {
      text: "Finished the bounded search and prepared the answer.", phase: "decision",
      evidence: ["3 architectures checked"], next: null,
    });
    assert.equal(finished.result.status, null, "a completed decision cannot drive the thinking bubble");
    assert.equal(finished.result.progress.at(-1).phase, "decision", "the milestone remains available for the research trail");

    const state = await harness.dispatch("decision-state", "panel.get", {});
    assert.equal(state.result.status, null);
    assert.equal(state.result.progress.at(-1).summary, "Finished the bounded search and prepared the answer.");
    const updates = harness.broadcasts.filter((message) => message.type === "panel.update");
    assert.equal(updates.at(-1).status, null, "open panels are told to stop animating immediately");
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
      price_label: "Item price",
      seller: "Audio Shop",
      availability: "In stock",
      verification: "Verified pick",
      landed_total: "$24.18",
      landed_total_label: "Landed total",
      delivery: "Delivery Aug 26–Aug 28",
      cost_breakdown: [{ label: "Item", amount: "$20.72" }, { label: "Shipping", amount: "$0.00" }, { label: "Tax", amount: "$3.46" }, { label: "Fake", amount: "$99.00" }, { label: "Discount", amount: "-$1.00" }],
      deal_label: "Historical low",
      timing_label: "Buy now",
      history_context: "18% below verified median · 8 prices over 70 days",
      deal_flags: ["Sale is not historically special", "Invented deal claim"],
      protections: ["30-day returns", "12-month warranty", 42, "x".repeat(100)],
      checks: ["Exact item", "Safety checked", "Invented check"],
    };
    const posted = await harness.dispatch("links-post", "panel.post", {
      text: "Best match below.",
      links: [
        goodLink,
        { url: "javascript:alert(1)", title: "evil scheme" }, // stripped: non-http
        { url: "https://ok.example.com", title: "t".repeat(500), seller: "s".repeat(500), availability: "Definitely available", price_label: "Free" }, // bounded metadata
        { url: "https://www.apple.com/shop/buy-mac/mac-studio/example", title: "Mac Studio", availability: "Pre-order" },
        { url: "not a url", title: "garbage" }, // stripped: unparseable
      ],
    });
    assert.equal(posted.ok, true);
    const stored = posted.result.entry.links;
    assert.equal(stored.length, 3, "only http(s) links survive sanitization");
    assert.equal(stored[0].url, goodLink.url);
    assert.equal(stored[0].title, goodLink.title);
    assert.equal(stored[0].image, goodLink.image);
    assert.equal(stored[0].price, "$20.72");
    assert.equal(stored[0].price_label, "Item price");
    assert.equal(stored[0].seller, "Audio Shop");
    assert.equal(stored[0].availability, "In stock");
    assert.equal(stored[0].verification, "Verified pick");
    assert.equal(stored[0].landed_total, "$24.18");
    assert.equal(stored[0].landed_total_label, "Landed total");
    assert.equal(stored[0].delivery, "Delivery Aug 26–Aug 28");
    assert.deepEqual(stored[0].cost_breakdown, [{ label: "Item", amount: "$20.72" }, { label: "Shipping", amount: "$0.00" }, { label: "Tax", amount: "$3.46" }]);
    assert.equal(stored[0].deal_label, "Historical low");
    assert.equal(stored[0].timing_label, "Buy now");
    assert.equal(stored[0].history_context, "18% below verified median · 8 prices over 70 days");
    assert.deepEqual(stored[0].deal_flags, ["Sale is not historically special"]);
    assert.deepEqual(stored[0].protections, ["30-day returns", "12-month warranty"]);
    assert.deepEqual(stored[0].checks, ["Exact item", "Safety checked"]);
    assert.ok(stored[1].title.length <= 200, "oversized title truncated");
    assert.equal(stored[1].seller.length, 120, "oversized seller truncated");
    assert.equal(stored[1].availability, undefined, "unknown availability literals are dropped");
    assert.equal(stored[2].availability, "Pre-order", "explicit preorder remains distinct from in-stock availability");
    assert.equal(stored[1].price_label, undefined, "unknown price labels are dropped");
    assert.equal(stored[1].verification, undefined, "unverified cards cannot invent the badge");

    // panel.get surfaces the links so the panel page can render cards.
    const got = await harness.dispatch("links-get", "panel.get", {});
    assert.equal(got.result.transcript[0].links.length, 3);

    // Capabilities probe is present (lets a stale panel detect an old SW).
    assert.ok(Array.isArray(got.result.capabilities), "panel.get reports capabilities");
    assert.ok(got.result.capabilities.includes("links:v1"));
    assert.ok(got.result.capabilities.includes("product-card-evidence:v1"));

    // A post with no links omits the field entirely.
    const bare = await harness.dispatch("links-bare", "panel.post", { text: "no links" });
    assert.equal(bare.result.entry.links, undefined);
  } finally {
    harness.restore();
  }
});
