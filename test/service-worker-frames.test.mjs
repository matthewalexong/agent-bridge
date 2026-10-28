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

function element(ref, role, name) {
  return {
    index: Number(ref.slice(1)) - 1,
    ref,
    selector: `[aria-label="${name}"]`,
    tag: role === "textbox" ? "input" : "button",
    role,
    name,
    disabled: false,
    _locator: { selector: `[aria-label="${name}"]`, role, name, nth: 0, tag: role === "textbox" ? "input" : "button" },
  };
}

function frameResult({ url, names, path, childFrames = [] }) {
  const elements = names.map(([role, name], index) => element(`e${index + 1}`, role, name));
  return {
    title: url,
    url,
    text: "",
    truncated: false,
    snapshot: elements.map((item) => `- ${item.role} "${item.name}" [ref=${item.ref}]`).join("\n"),
    elements,
    _childFrames: childFrames,
    ...(path ? { _frame: { path, href: url, width: 400, height: 200 } } : {}),
  };
}

// Main frame → outer frame (frameId 7, path [0]) → inner frame (frameId 8, path [0, 0]).
const pageFrames = [
  { frameId: 0, documentId: "doc-main", result: frameResult({ url: "https://shop.example/", names: [["button", "Main button"]], childFrames: [{ index: 0, visible: true }] }) },
  { frameId: 7, documentId: "doc-outer", result: frameResult({ url: "https://outer.example/", names: [["button", "Outer button"]], path: [0], childFrames: [{ index: 0, visible: true }] }) },
  { frameId: 8, documentId: "doc-inner", result: frameResult({ url: "https://inner.example/", names: [["button", "Pay"], ["textbox", "Card number"]], path: [0, 0] }) },
  { frameId: 9, documentId: "doc-orphan", result: frameResult({ url: "https://orphan.example/", names: [["button", "Orphan"]], path: [3, 0] }) },
];

function chromeHarness({ allFramesFails = false, staleDocuments = [], focusResults = {}, preparedFocus = true } = {}) {
  const nativeMessages = [];
  const debuggerCalls = [];
  const scriptCalls = [];
  const nativeMessage = event();
  const runtimeMessage = event();
  const port = {
    onMessage: nativeMessage,
    onDisconnect: event(),
    postMessage(message) { nativeMessages.push(message); },
  };
  const frameOf = (target) => target.documentIds?.[0] ?? (target.frameIds ? `frame:${target.frameIds[0]}` : "main");
  const chrome = {
    runtime: {
      id: "hkedmoboloodflgcaidimhddljdnndcd",
      connectNative: () => port,
      getManifest: () => ({ version: "0.7.0" }),
      onInstalled: event(),
      onStartup: event(),
      onMessage: runtimeMessage,
    },
    action: { onClicked: event() },
    windows: { update: async () => ({}) },
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 7, url: "https://shop.example/" }),
      query: async () => [],
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        scriptCalls.push({ name: func.name, target, args });
        if (func.name === "snapshotPage") {
          if (target.allFrames && allFramesFails) throw new Error("Cannot access contents of url \"chrome-error://chromewebdata/\"");
          return target.allFrames ? pageFrames : [pageFrames[0]];
        }
        const frame = frameOf(target);
        if (staleDocuments.includes(frame)) throw new Error(`No document with id ${frame}`);
        if (func.name === "prepareActionTarget") {
          return [{ frameId: 8, documentId: frame, result: { marker: args[1], x: 30, y: 12, target: { role: args[0].role, name: args[0].name, tag: args[0].tag } } }];
        }
        if (func.name === "inspectPreparedTarget") return [{ result: { ok: true } }];
        if (func.name === "locateChildFrame") {
          const [child, x, y, mode] = args;
          if (mode === "focus") return [{ result: { focused: focusResults[frame] ?? true } }];
          // Each ancestor offsets the point by its child's owner position.
          const offset = frame === "doc-outer" ? { x: 100, y: 50 } : { x: 10, y: 300 };
          return [{ result: { x: x + offset.x, y: y + offset.y, child } }];
        }
        if (func.name === "inspectPreparedFocus") return [{ result: { focused: preparedFocus } }];
        if (func.name === "performPreparedDomAction") return [{ result: { filled: true, length: args[2].length } }];
        if (func.name === "cleanupPreparedTarget") return [{ result: { cleaned: true } }];
        return [{ result: null }];
      },
    },
    debugger: {
      attach: async (target, version) => debuggerCalls.push(["attach", target, version]),
      detach: async (target) => debuggerCalls.push(["detach", target]),
      sendCommand: async (target, method, params) => {
        debuggerCalls.push(["command", target, method, params]);
        return {};
      },
      onEvent: event(),
      onDetach: event(),
    },
  };
  return { chrome, debuggerCalls, nativeMessage, nativeMessages, port, runtimeMessage, scriptCalls };
}

function runtimeRequest(harness, message) {
  return new Promise((resolve) => harness.runtimeMessage.listener(message, { id: harness.chrome.runtime.id }, resolve));
}

async function request(harness, id, method, params) {
  const operation = harness.nativeMessage.listener({ type: "request", id, method, params }, harness.port);
  await flush();
  const state = await runtimeRequest(harness, { type: "panel.get" });
  for (const pending of state.result.browserAccess.pending) {
    await runtimeRequest(harness, { type: "panel.permission.resolve", requestId: pending.id, decision: "approve" });
  }
  await operation;
  await flush();
  return harness.nativeMessages.find((message) => message.id === id);
}

async function loadHarness(options) {
  const harness = chromeHarness(options);
  const previousChrome = globalThis.chrome;
  globalThis.chrome = harness.chrome;
  await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?frames=${crypto.randomUUID()}`);
  await runtimeRequest(harness, { type: "panel.permission.set", mode: "routine", scope: "browser" });
  return { harness, restore: () => { globalThis.chrome = previousChrome; } };
}

const calls = (harness, name) => harness.scriptCalls.filter((call) => call.name === name);

test("snapshots run in every frame and expose frame-scoped refs", async () => {
  const { harness, restore } = await loadHarness();
  try {
    const snapshot = await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    assert.equal(snapshot.ok, true);
    assert.deepEqual(calls(harness, "snapshotPage")[0].target, { tabId: 42, allFrames: true });
    assert.deepEqual(snapshot.result.elements.map((item) => item.ref), ["e1", "f1e1", "f2e1", "f2e2", "f3e1"]);
    assert.deepEqual(snapshot.result.frames.map((frame) => frame.url), ["https://outer.example/", "https://inner.example/", "https://orphan.example/"]);
    assert.equal(snapshot.result.refCount, 5);
    assert.match(snapshot.result.snapshot, /^- button "Main button" \[ref=e1\]\n- iframe/);
    assert.equal(snapshot.result.elements.some((item) => "_locator" in item), false);
  } finally {
    restore();
  }
});

test("snapshots fall back to the main frame when a multi-frame injection fails", async () => {
  const { harness, restore } = await loadHarness({ allFramesFails: true });
  try {
    const snapshot = await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    assert.equal(snapshot.ok, true);
    assert.deepEqual(calls(harness, "snapshotPage").map((call) => call.target), [{ tabId: 42, allFrames: true }, { tabId: 42 }]);
    assert.deepEqual(snapshot.result.elements.map((item) => item.ref), ["e1"]);
    assert.equal("frames" in snapshot.result, false);
  } finally {
    restore();
  }
});

test("main-frame refs keep targeting the tab without frame ids", async () => {
  const { harness, restore } = await loadHarness();
  try {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const clicked = await request(harness, "click", "page.act", { tabId: 42, kind: "click", ref: "e1" });
    assert.equal(clicked.ok, true);
    assert.deepEqual(clicked.result.point, { x: 30, y: 12 });
    assert.deepEqual(calls(harness, "prepareActionTarget")[0].target, { tabId: 42 });
    assert.equal(calls(harness, "locateChildFrame").length, 0);
  } finally {
    restore();
  }
});

test("a click in a nested frame maps its point through each ancestor before CDP input", async () => {
  const { harness, restore } = await loadHarness();
  try {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const clicked = await request(harness, "click", "page.act", { tabId: 42, kind: "click", ref: "f2e1" });
    assert.equal(clicked.ok, true, JSON.stringify(clicked.error));
    assert.equal(clicked.result.ref, "f2e1");
    assert.deepEqual(clicked.result.point, { x: 140, y: 362 });

    assert.deepEqual(calls(harness, "prepareActionTarget")[0].target, { tabId: 42, documentIds: ["doc-inner"] });
    assert.equal(calls(harness, "prepareActionTarget")[0].args[0].name, "Pay");
    assert.equal("frame" in calls(harness, "prepareActionTarget")[0].args[0], false, "frame routing stays out of the page locator");
    assert.deepEqual(calls(harness, "inspectPreparedTarget").map((call) => call.target), [
      { tabId: 42, documentIds: ["doc-inner"] },
      { tabId: 42, documentIds: ["doc-inner"] },
    ]);
    // Bottom-up: the outer frame locates the inner frame, then the main frame locates the outer frame.
    assert.deepEqual(calls(harness, "locateChildFrame").map((call) => [call.target, call.args]), [
      [{ tabId: 42, documentIds: ["doc-outer"] }, [{ index: 0, href: "https://inner.example/", width: 400, height: 200 }, 30, 12, "point"]],
      [{ tabId: 42 }, [{ index: 0, href: "https://outer.example/", width: 400, height: 200 }, 130, 62, "point"]],
    ]);
    assert.deepEqual(
      harness.debuggerCalls.filter((call) => call[2] === "Input.dispatchMouseEvent").map((call) => [call[3].type, call[3].x, call[3].y]),
      [["mouseMoved", 140, 362], ["mousePressed", 140, 362], ["mouseReleased", 140, 362]],
    );
    assert.deepEqual(calls(harness, "cleanupPreparedTarget").at(-1).target, { tabId: 42, documentIds: ["doc-inner"] });
  } finally {
    restore();
  }
});

test("fill in a frame runs in that frame's document without the debugger", async () => {
  const { harness, restore } = await loadHarness();
  try {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const filled = await request(harness, "fill", "page.act", { tabId: 42, kind: "fill", ref: "f2e2", value: "4242" });
    assert.equal(filled.ok, true);
    assert.equal(filled.result.length, 4);
    assert.deepEqual(calls(harness, "performPreparedDomAction")[0].target, { tabId: 42, documentIds: ["doc-inner"] });
    assert.equal(calls(harness, "locateChildFrame").length, 0);
    assert.equal(harness.debuggerCalls.length, 0);
  } finally {
    restore();
  }
});

test("press in a frame focuses each frame owner from the top down first", async () => {
  const { harness, restore } = await loadHarness();
  try {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const pressed = await request(harness, "press", "page.act", { tabId: 42, kind: "press", ref: "f2e2", key: "Enter" });
    assert.equal(pressed.ok, true, JSON.stringify(pressed.error));
    assert.deepEqual(calls(harness, "locateChildFrame").map((call) => [call.target, call.args[3]]), [
      [{ tabId: 42 }, "focus"],
      [{ tabId: 42, documentIds: ["doc-outer"] }, "focus"],
    ]);
    assert.deepEqual(calls(harness, "inspectPreparedFocus")[0].target, { tabId: 42, documentIds: ["doc-inner"] });
    assert.deepEqual(
      harness.debuggerCalls.filter((call) => call[2] === "Input.dispatchKeyEvent").map((call) => call[3].type),
      ["keyDown", "keyUp"],
    );
  } finally {
    restore();
  }
});

test("press in a frame refuses to send keys when focus cannot reach the target", async () => {
  for (const options of [{ focusResults: { "doc-outer": false } }, { preparedFocus: false }]) {
    const { harness, restore } = await loadHarness(options);
    try {
      await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
      const pressed = await request(harness, "press", "page.act", { tabId: 42, kind: "press", ref: "f2e2", key: "Enter" });
      assert.equal(pressed.ok, false);
      assert.equal(pressed.error.code, "frame_focus_unavailable");
      assert.equal(harness.debuggerCalls.filter((call) => call[2] === "Input.dispatchKeyEvent").length, 0);
    } finally {
      restore();
    }
  }
});

test("a frame that navigated since the snapshot reports stale_ref", async () => {
  const { harness, restore } = await loadHarness({ staleDocuments: ["doc-inner"] });
  try {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const clicked = await request(harness, "click", "page.act", { tabId: 42, kind: "click", ref: "f2e1" });
    assert.equal(clicked.ok, false);
    assert.equal(clicked.error.code, "stale_ref");
    assert.equal(harness.debuggerCalls.filter((call) => call[2] === "Input.dispatchMouseEvent").length, 0);
  } finally {
    restore();
  }
});

test("a frame whose parent was not snapshotted cannot be clicked", async () => {
  const { harness, restore } = await loadHarness();
  try {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const clicked = await request(harness, "click", "page.act", { tabId: 42, kind: "click", ref: "f3e1" });
    assert.equal(clicked.ok, false);
    assert.equal(clicked.error.code, "frame_position_unavailable");
    assert.equal(harness.debuggerCalls.filter((call) => call[2] === "Input.dispatchMouseEvent").length, 0);
  } finally {
    restore();
  }
});

test("malformed and unknown frame refs are rejected", async () => {
  const { harness, restore } = await loadHarness();
  try {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const malformed = await request(harness, "bad", "page.act", { tabId: 42, kind: "click", ref: "f0e1" });
    assert.equal(malformed.error.code, "invalid_ref");
    const unknown = await request(harness, "unknown", "page.act", { tabId: 42, kind: "click", ref: "f9e1" });
    assert.equal(unknown.error.code, "stale_ref");
  } finally {
    restore();
  }
});
