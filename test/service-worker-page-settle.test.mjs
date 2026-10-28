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

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Stands in for the page's MutationObserver so the real injected
// waitForDomQuiet runs in Node; mutate() plays a DOM change.
class FakeMutationObserver {
  static active = new Set();
  static mutate() {
    for (const observer of FakeMutationObserver.active) observer.callback([{ type: "childList" }]);
  }
  constructor(callback) { this.callback = callback; }
  observe() { FakeMutationObserver.active.add(this); }
  disconnect() { FakeMutationObserver.active.delete(this); }
}

function chromeHarness() {
  const nativeMessages = [];
  const scriptCalls = [];
  const timers = new Set();
  const nativeMessage = event();
  const runtimeMessage = event();
  const tabUpdated = event();
  const tabRemoved = event();
  const port = {
    onMessage: nativeMessage,
    onDisconnect: event(),
    postMessage(message) { nativeMessages.push(message); },
  };
  const passiveEvent = () => event();
  const tabs = new Map([[42, { id: 42, windowId: 7, active: true, title: "Menu", url: "https://example.com/menu", status: "complete" }]]);
  const harness = {
    nativeMessage,
    nativeMessages,
    port,
    runtimeMessage,
    scriptCalls,
    tabs,
    // Default navigation: Chrome reports the tab loading the pending URL.
    onNavigate(tab, url) {
      tab.status = "loading";
      tab.pendingUrl = url;
    },
    onClick() {},
    after(ms, callback) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, ms);
      timers.add(timer);
    },
    every(ms, callback) {
      const timer = setInterval(callback, ms);
      timers.add(timer);
    },
    fire(tabId, changeInfo) {
      const tab = tabs.get(tabId);
      if (changeInfo.url) {
        tab.url = changeInfo.url;
        delete tab.pendingUrl;
      }
      if (changeInfo.status) tab.status = changeInfo.status;
      if (changeInfo.status === "complete") delete tab.pendingUrl;
      tabUpdated.listener(tabId, changeInfo, { ...tab });
    },
    close(tabId) {
      tabs.delete(tabId);
      tabRemoved.listener(tabId, { windowId: 7, isWindowClosing: false });
    },
    clearTimers() {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
    },
  };
  harness.chrome = {
    runtime: {
      id: "hkedmoboloodflgcaidimhddljdnndcd",
      connectNative: () => port,
      getManifest: () => ({ version: "0.9.0" }),
      onInstalled: passiveEvent(),
      onStartup: passiveEvent(),
      onMessage: runtimeMessage,
    },
    action: { onClicked: passiveEvent() },
    windows: { update: async () => ({}) },
    tabs: {
      get: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return { ...tab };
      },
      update: async (tabId, values) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        harness.onNavigate(tab, values.url);
        return { ...tab };
      },
      query: async () => [],
      onCreated: passiveEvent(),
      onUpdated: tabUpdated,
      onRemoved: tabRemoved,
      onActivated: passiveEvent(),
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        scriptCalls.push({ name: func.name, args, at: Date.now() });
        if (func.name === "waitForDomQuiet") return [{ result: await func(...args) }];
        if (func.name === "snapshotPage") {
          return [{ result: {
            title: "Menu",
            url: tabs.get(42).url,
            text: "Open",
            truncated: false,
            snapshot: '- button "Open" [ref=e1]',
            elements: [{
              index: 0,
              ref: "e1",
              selector: "#open",
              tag: "button",
              role: "button",
              name: "Open",
              _locator: { selector: "#open", role: "button", name: "Open", nth: 0, id: "open", tag: "button" },
            }],
          } }];
        }
        if (func.name === "prepareActionTarget") {
          return [{ result: { marker: args[1], x: 10, y: 10, target: { role: "button", name: "Open", tag: "button" } } }];
        }
        if (func.name === "inspectPreparedTarget") return [{ result: { ok: true } }];
        if (func.name === "cleanupPreparedTarget") return [{ result: { cleaned: true } }];
        return [{ result: null }];
      },
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (target, method, params) => {
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") harness.onClick();
        return {};
      },
      onEvent: passiveEvent(),
      onDetach: passiveEvent(),
    },
  };
  return harness;
}

function runtimeRequest(harness, message) {
  return new Promise((resolve) => harness.runtimeMessage.listener(message, { id: harness.chrome.runtime.id }, resolve));
}

async function request(harness, id, method, params) {
  harness.nativeMessage.listener({ type: "request", id, method, params }, harness.port);
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = harness.nativeMessages.find((message) => message.type === "response" && message.id === id);
    if (response) return response;
    if (Date.now() > deadline) throw new Error(`No response to ${id}`);
    await wait(5);
  }
}

function quietCalls(harness) {
  return harness.scriptCalls.filter((call) => call.name === "waitForDomQuiet");
}

async function withHarness(run) {
  const harness = chromeHarness();
  const previous = { chrome: globalThis.chrome, document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  globalThis.chrome = harness.chrome;
  globalThis.document = {};
  globalThis.MutationObserver = FakeMutationObserver;
  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?settle=${crypto.randomUUID()}`);
    await runtimeRequest(harness, { type: "panel.permission.set", mode: "routine", scope: "browser" });
    await run(harness);
  } finally {
    harness.clearTimers();
    FakeMutationObserver.active.clear();
    Object.assign(globalThis, previous);
  }
}

test("navigate to a tab that is already complete returns after one quiet window", async () => {
  await withHarness(async (harness) => {
    // A same-document navigation: Chrome never reports the tab loading.
    harness.onNavigate = (tab, url) => { tab.url = url; };
    const response = await request(harness, "nav", "tabs.navigate", { tabId: 42, url: "https://example.com/menu#details" });
    assert.equal(response.ok, true);
    assert.equal(response.result.settled, true);
    assert.equal(response.result.waitUntil, "settled");
    assert.equal(response.result.url, "https://example.com/menu#details");
    assert.equal("reason" in response.result, false);
    assert.ok(response.result.elapsedMs >= 390 && response.result.elapsedMs < 2_000, `elapsedMs ${response.result.elapsedMs}`);
    assert.equal(quietCalls(harness).length, 1);
    assert.equal(quietCalls(harness)[0].args[0], 400, "default quiet window");
  });
});

test("navigate waits for the load to complete, follows the redirect, then waits for a quiet DOM", async () => {
  await withHarness(async (harness) => {
    let completedAt = 0;
    harness.onNavigate = (tab, url) => {
      tab.status = "loading";
      tab.pendingUrl = url;
      harness.after(50, () => harness.fire(42, { status: "loading", url }));
      harness.after(150, () => harness.fire(42, { url: "https://example.com/final" }));
      harness.after(300, () => {
        completedAt = Date.now();
        harness.fire(42, { status: "complete" });
      });
      // Client-side rendering keeps the DOM busy for a while after load.
      for (const ms of [350, 450, 550]) harness.after(ms, () => FakeMutationObserver.mutate());
    };
    const response = await request(harness, "nav", "tabs.navigate", { tabId: 42, url: "https://example.com/start" });
    assert.equal(response.ok, true);
    assert.equal(response.result.settled, true);
    assert.equal(response.result.url, "https://example.com/final", "the result reports where the redirect landed");
    assert.ok(response.result.elapsedMs >= 940, `quiet window restarts after the last mutation, elapsedMs ${response.result.elapsedMs}`);
    const [quiet] = quietCalls(harness);
    assert.ok(quiet.at >= completedAt, "DOM observation starts only after the load completes");
  });
});

test("a page that never goes quiet times out with settled:false instead of failing", async () => {
  await withHarness(async (harness) => {
    harness.onNavigate = (tab, url) => { tab.url = url; };
    harness.every(50, () => FakeMutationObserver.mutate());
    const response = await request(harness, "busy", "tabs.navigate", { tabId: 42, url: "https://example.com/ticker", timeoutMs: 800 });
    assert.equal(response.ok, true);
    assert.equal(response.result.settled, false);
    assert.equal(response.result.reason, "dom_busy");
    assert.ok(response.result.elapsedMs >= 790 && response.result.elapsedMs < 2_000, `elapsedMs ${response.result.elapsedMs}`);
  });
});

test("a load that never completes times out with settled:false and load_timeout", async () => {
  await withHarness(async (harness) => {
    const response = await request(harness, "stuck", "tabs.navigate", { tabId: 42, url: "https://example.com/slow", timeoutMs: 300 });
    assert.equal(response.ok, true);
    assert.equal(response.result.settled, false);
    assert.equal(response.result.reason, "load_timeout");
    assert.ok(response.result.elapsedMs >= 290 && response.result.elapsedMs < 1_500, `elapsedMs ${response.result.elapsedMs}`);
    assert.equal(quietCalls(harness).length, 0, "the DOM is not observed before the load completes");
  });
});

test("closing the tab mid-wait returns tab_closed without throwing", async () => {
  await withHarness(async (harness) => {
    harness.onNavigate = (tab, url) => {
      tab.status = "loading";
      tab.pendingUrl = url;
      harness.after(100, () => harness.close(42));
    };
    const response = await request(harness, "closed", "tabs.navigate", { tabId: 42, url: "https://example.com/gone" });
    assert.equal(response.ok, true);
    assert.equal(response.result.id, 42);
    assert.equal(response.result.settled, false);
    assert.equal(response.result.reason, "tab_closed");
    assert.ok(response.result.elapsedMs < 1_000, `elapsedMs ${response.result.elapsedMs}`);
  });
});

test("a client-side redirect during the quiet window settles the page it lands on", async () => {
  await withHarness(async (harness) => {
    harness.onNavigate = (tab, url) => {
      tab.status = "loading";
      tab.pendingUrl = url;
      harness.after(100, () => harness.fire(42, { status: "complete", url }));
      harness.after(300, () => harness.fire(42, { status: "loading", url: "https://example.com/landing" }));
      harness.after(700, () => harness.fire(42, { status: "complete" }));
    };
    const response = await request(harness, "redirect", "tabs.navigate", { tabId: 42, url: "https://example.com/bounce" });
    assert.equal(response.ok, true);
    assert.equal(response.result.settled, true);
    assert.equal(response.result.url, "https://example.com/landing");
    assert.ok(response.result.elapsedMs >= 1_050, `elapsedMs ${response.result.elapsedMs}`);
    assert.equal(quietCalls(harness).length, 2, "the landing page gets its own quiet window");
  });
});

test("an action that neither navigates nor loads returns within the quiet window", async () => {
  await withHarness(async (harness) => {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const response = await request(harness, "click", "page.act", { tabId: 42, kind: "click", ref: "e1" });
    assert.equal(response.ok, true);
    assert.equal(response.result.clicked, true);
    assert.equal(response.result.needsSnapshot, true);
    assert.equal(response.result.settled, true);
    assert.equal(response.result.navigated, false);
    assert.ok(response.result.elapsedMs >= 390 && response.result.elapsedMs < 1_000, `well under the 10 s timeout, elapsedMs ${response.result.elapsedMs}`);
  });
});

test("an action does not wait on a load that was already running before it", async () => {
  await withHarness(async (harness) => {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    // A hanging subresource keeps the tab loading; the click starts nothing new.
    harness.tabs.get(42).status = "loading";
    const response = await request(harness, "click", "page.act", { tabId: 42, kind: "click", ref: "e1" });
    assert.equal(response.ok, true);
    assert.equal(response.result.settled, true);
    assert.equal(response.result.navigated, false);
    assert.ok(response.result.elapsedMs < 1_000, `elapsedMs ${response.result.elapsedMs}`);
  });
});

test("an action that starts a navigation waits for the new page to settle", async () => {
  await withHarness(async (harness) => {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    harness.onClick = () => {
      harness.after(50, () => harness.fire(42, { status: "loading", url: "https://example.com/next" }));
      harness.after(600, () => harness.fire(42, { status: "complete" }));
    };
    const response = await request(harness, "click", "page.act", { tabId: 42, kind: "click", ref: "e1" });
    assert.equal(response.ok, true);
    assert.equal(response.result.clicked, true);
    assert.equal(response.result.settled, true);
    assert.equal(response.result.navigated, true);
    assert.ok(response.result.elapsedMs >= 990, `elapsedMs ${response.result.elapsedMs}`);
    assert.equal(quietCalls(harness).length, 2, "the first window spots the load; the second covers the new page");
  });
});

test("waitUntil none and load keep shorter waits, and invalid options are rejected before acting", async () => {
  await withHarness(async (harness) => {
    harness.onNavigate = (tab, url) => { tab.url = url; };
    const none = await request(harness, "none", "tabs.navigate", { tabId: 42, url: "https://example.com/a", waitUntil: "none" });
    assert.equal(none.ok, true);
    assert.equal(none.result.url, "https://example.com/a");
    assert.equal("settled" in none.result, false, "waitUntil none returns the previous result shape");

    const load = await request(harness, "load", "tabs.navigate", { tabId: 42, url: "https://example.com/b", waitUntil: "load" });
    assert.equal(load.result.settled, true);
    assert.equal(load.result.waitUntil, "load");
    assert.equal(quietCalls(harness).length, 0, "waitUntil load never observes the DOM");

    const invalid = await request(harness, "invalid", "tabs.navigate", { tabId: 42, url: "https://example.com/c", waitUntil: "idle" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "invalid_request");
    const tooLong = await request(harness, "too-long", "tabs.navigate", { tabId: 42, url: "https://example.com/c", timeoutMs: 60_000 });
    assert.equal(tooLong.error.code, "invalid_request");
    assert.equal(harness.tabs.get(42).url, "https://example.com/b", "rejected calls never navigate");
  });
});
