import assert from "node:assert/strict";
import test from "node:test";
import {
  compareFramePaths,
  displayFrameUrl,
  frameAncestry,
  frameScopedRef,
  MAX_SNAPSHOT_ELEMENTS,
  mergeFrameSnapshots,
  parseActionRef,
} from "../extension/page-frames.js";

function element(ref, name, extra = {}) {
  return {
    index: Number(ref.slice(1)) - 1,
    ref,
    selector: `#${name.toLowerCase().replace(/\s+/g, "-")}`,
    tag: "button",
    role: "button",
    name,
    disabled: false,
    _locator: { selector: `#${name}`, role: "button", name, nth: 0, tag: "button", ...extra },
  };
}

function frameResult({ title = "Frame", url, text = "", names = [], path, childFrames = [], truncated = false }) {
  const elements = names.map((name, index) => element(`e${index + 1}`, name));
  return {
    title,
    url,
    text,
    truncated,
    snapshot: elements.map((item) => `- button "${item.name}" [ref=${item.ref}]`).join("\n"),
    elements,
    _childFrames: childFrames,
    ...(path ? { _frame: { path, href: url, width: 300, height: 150 } } : {}),
  };
}

test("action refs keep the e12 form in the main frame and scope subframe refs as f2e5", () => {
  assert.deepEqual(parseActionRef("e12"), { frame: 0, element: 12 });
  assert.deepEqual(parseActionRef("f2e5"), { frame: 2, element: 5 });
  assert.deepEqual(parseActionRef("f10e1"), { frame: 10, element: 1 });
  for (const invalid of ["", "e", "f0e1", "f1", "fe1", "f1e", "E1", "f01e1", "e1 ", "#e1", "f1e1e2", null, 12]) {
    assert.equal(parseActionRef(invalid), null, `${String(invalid)} must be rejected`);
  }
  assert.equal(frameScopedRef(0, "e3"), "e3");
  assert.equal(frameScopedRef(4, "e3"), "f4e3");
});

test("frame urls drop query strings and fragments that can carry tokens", () => {
  assert.equal(displayFrameUrl("https://js.stripe.com/v3/elements-inner-card.html?key=pk_live#secret=abc"), "https://js.stripe.com/v3/elements-inner-card.html");
  assert.equal(displayFrameUrl("about:srcdoc"), "about:srcdoc");
  assert.equal(displayFrameUrl("data:text/html,<b>hi</b>"), "data://…");
  assert.equal(displayFrameUrl("not a url"), "");
});

test("frame paths order parents before children and unindexed frames last", () => {
  const paths = [[-1], [1, 0], [0], [1], [2], [1, -1], [1, 1]];
  assert.deepEqual(paths.sort(compareFramePaths), [[0], [1], [1, 0], [1, 1], [1, -1], [2], [-1]]);
});

test("a page without subframes keeps the existing snapshot output", () => {
  const main = frameResult({ title: "Menu", url: "https://example.com/menu", text: "Hello", names: ["Open", "Close"] });
  const merged = mergeFrameSnapshots([{ frameId: 0, documentId: "doc-main", result: main }], { maxChars: 8_000 });
  assert.deepEqual(Object.keys(merged.result), ["title", "url", "text", "truncated", "snapshot", "elements"]);
  assert.equal(merged.result.snapshot, main.snapshot);
  assert.equal(merged.result.text, "Hello");
  assert.equal(merged.result.truncated, false);
  assert.deepEqual(merged.result.elements.map((item) => item.ref), ["e1", "e2"]);
  assert.equal(merged.result.elements.some((item) => "_locator" in item || "frame" in item), false);
  assert.deepEqual(merged.refs.get("e2"), { frameId: 0, documentId: "doc-main", locator: main.elements[1]._locator });
  assert.equal("frames" in merged.result, false);
});

test("injection results without frame metadata are treated as the main frame", () => {
  const main = frameResult({ url: "https://example.com/", names: ["Go"] });
  const merged = mergeFrameSnapshots([{ result: main }], { maxChars: 1_000 });
  assert.equal(merged.result.elements[0].ref, "e1");
  assert.equal(merged.refs.get("e1").frameId, 0);
});

test("a missing or failed main frame produces no snapshot", () => {
  const child = frameResult({ url: "https://pay.example/", names: ["Pay"], path: [0] });
  assert.equal(mergeFrameSnapshots([{ frameId: 3, result: child }], { maxChars: 1_000 }), null);
  assert.equal(mergeFrameSnapshots([{ frameId: 0, result: { error: { code: "x", message: "y" } } }], { maxChars: 1_000 }), null);
  assert.equal(mergeFrameSnapshots([], { maxChars: 1_000 }), null);
});

test("subframe elements get frame-scoped refs, lines, and text sections", () => {
  const main = frameResult({
    title: "Checkout",
    url: "https://shop.example/checkout",
    text: "Checkout page",
    names: ["Place order"],
    childFrames: [{ index: 0, visible: true }, { index: 1, visible: true }],
  });
  const card = frameResult({ title: "Secure card", url: "https://pay.example/card?session=tok#k=v", text: "Card details", names: ["Card number", "Expiry"], path: [0] });
  const help = frameResult({ title: "", url: "https://help.example/widget", text: "Chat with us", names: ["Open chat"], path: [1] });
  const merged = mergeFrameSnapshots([
    { frameId: 0, documentId: "d0", result: main },
    { frameId: 9, documentId: "d9", result: help },
    { frameId: 4, documentId: "d4", result: card },
  ], { maxChars: 8_000 });

  assert.equal(merged.result.snapshot, [
    '- button "Place order" [ref=e1]',
    '- iframe "Secure card" [frame=f1] [url=https://pay.example/card]',
    '  - button "Card number" [ref=f1e1]',
    '  - button "Expiry" [ref=f1e2]',
    "- iframe [frame=f2] [url=https://help.example/widget]",
    '  - button "Open chat" [ref=f2e1]',
  ].join("\n"));
  assert.deepEqual(merged.result.elements.map((item) => [item.index, item.ref, item.frame]), [
    [0, "e1", undefined],
    [1, "f1e1", "f1"],
    [2, "f1e2", "f1"],
    [3, "f2e1", "f2"],
  ]);
  assert.deepEqual(merged.refs.get("f1e2"), { frameId: 4, documentId: "d4", locator: card.elements[1]._locator });
  assert.deepEqual(merged.refs.get("f2e1").frameId, 9);
  assert.equal(merged.refs.has("e2"), false);
  assert.equal(merged.result.text, "Checkout page\n\n[frame f1 https://pay.example/card]\nCard details\n\n[frame f2 https://help.example/widget]\nChat with us");
  assert.deepEqual(merged.result.frames, [
    { frame: "f1", url: "https://pay.example/card", title: "Secure card", elementCount: 2 },
    { frame: "f2", url: "https://help.example/widget", title: "", elementCount: 1 },
  ]);
  assert.equal(merged.frames.get(4).ordinal, 1);
  assert.equal(merged.frames.get(9).ordinal, 2);
});

test("the element cap applies across all frames with the main frame first", () => {
  const mainNames = Array.from({ length: MAX_SNAPSHOT_ELEMENTS - 3 }, (_, index) => `Main ${index}`);
  const main = frameResult({ url: "https://example.com/", names: mainNames, childFrames: [{ index: 0, visible: true }, { index: 1, visible: true }] });
  const first = frameResult({ url: "https://a.example/", names: ["A1", "A2", "A3", "A4", "A5"], path: [0] });
  const second = frameResult({ url: "https://b.example/", text: "Frame B text", names: ["B1"], path: [1] });
  const merged = mergeFrameSnapshots([
    { frameId: 0, result: main },
    { frameId: 1, result: first },
    { frameId: 2, result: second },
  ], { maxChars: 50_000 });

  assert.equal(merged.result.elements.length, MAX_SNAPSHOT_ELEMENTS);
  assert.equal(merged.refs.size, MAX_SNAPSHOT_ELEMENTS);
  assert.deepEqual(merged.result.elements.slice(-3).map((item) => item.ref), ["f1e1", "f1e2", "f1e3"]);
  assert.equal(merged.refs.has("f1e4"), false);
  assert.deepEqual(merged.result.frames[0], { frame: "f1", url: "https://a.example/", title: "Frame", elementCount: 3, elementsTruncated: true });
  // A frame past the element budget still contributes its text.
  assert.deepEqual(merged.result.frames[1], { frame: "f2", url: "https://b.example/", title: "Frame", elementCount: 0, elementsTruncated: true });
  assert.match(merged.result.text, /\[frame f2 https:\/\/b\.example\/\]\nFrame B text$/);
});

test("frame text shares the snapshot character budget", () => {
  const main = frameResult({ url: "https://example.com/", text: "x".repeat(90), names: ["Go"], childFrames: [{ index: 0, visible: true }] });
  const child = frameResult({ url: "https://a.example/", text: "y".repeat(100), names: ["Inner"], path: [0] });
  const merged = mergeFrameSnapshots([{ frameId: 0, result: main }, { frameId: 5, result: child }], { maxChars: 100 });
  assert.equal(merged.result.text.length, 100);
  assert.equal(merged.result.text.startsWith("x".repeat(90)), true);
  assert.equal(merged.result.truncated, true);
});

test("frames hidden by their owner, and their descendants, are dropped", () => {
  const main = frameResult({ url: "https://example.com/", names: ["Go"], childFrames: [{ index: 0, visible: false }, { index: 1, visible: true }] });
  const hidden = frameResult({ url: "https://ads.example/", text: "Ad", names: ["Ad link"], path: [0], childFrames: [{ index: 0, visible: true }] });
  const hiddenChild = frameResult({ url: "https://ads.example/inner", text: "Inner ad", names: ["Inner ad link"], path: [0, 0] });
  const visible = frameResult({ url: "https://login.example/", names: ["Sign in"], path: [1] });
  const merged = mergeFrameSnapshots([
    { frameId: 0, result: main },
    { frameId: 2, result: hidden },
    { frameId: 3, result: hiddenChild },
    { frameId: 4, result: visible },
  ], { maxChars: 8_000 });
  assert.deepEqual([...merged.refs.keys()], ["e1", "f1e1"]);
  assert.equal(merged.refs.get("f1e1").frameId, 4);
  assert.doesNotMatch(merged.result.text, /Ad/);
});

test("subframes without elements or text, without a path, or with errors get no ordinal", () => {
  const main = frameResult({ url: "https://example.com/", names: ["Go"], childFrames: [{ index: 0, visible: true }, { index: 1, visible: true }, { index: 2, visible: true }] });
  const empty = frameResult({ url: "https://empty.example/", path: [0] });
  const noPath = frameResult({ url: "https://nopath.example/", names: ["Lost"] });
  const failed = { error: { code: "boom", message: "failed" } };
  const real = frameResult({ url: "https://real.example/", names: ["Real"], path: [2] });
  const merged = mergeFrameSnapshots([
    { frameId: 0, result: main },
    { frameId: 6, result: empty },
    { frameId: 7, result: noPath },
    { frameId: 8, result: failed },
    { frameId: 9, result: real },
    { frameId: 10, result: null },
  ], { maxChars: 8_000 });
  assert.deepEqual([...merged.refs.keys()], ["e1", "f1e1"]);
  assert.equal(merged.refs.get("f1e1").frameId, 9);
});

test("frame ancestry walks from a nested frame up to the main frame", () => {
  const main = frameResult({ url: "https://example.com/", names: ["Go"], childFrames: [{ index: 0, visible: true }] });
  const outer = frameResult({ url: "https://outer.example/", names: ["Outer"], path: [0], childFrames: [{ index: 1, visible: true }] });
  const inner = frameResult({ url: "https://inner.example/", names: ["Inner"], path: [0, 1] });
  const shadowFrame = frameResult({ url: "https://shadow.example/", names: ["Shadow"], path: [-1] });
  const merged = mergeFrameSnapshots([
    { frameId: 0, documentId: "d0", result: main },
    { frameId: 21, documentId: "d21", result: outer },
    { frameId: 22, documentId: "d22", result: inner },
    { frameId: 23, documentId: "d23", result: shadowFrame },
  ], { maxChars: 8_000 });

  assert.deepEqual(frameAncestry(merged.frames, 22), [
    { parent: { frameId: 21, documentId: "d21" }, child: { index: 1, href: "https://inner.example/", width: 300, height: 150 } },
    { parent: null, child: { index: 0, href: "https://outer.example/", width: 300, height: 150 } },
  ]);
  assert.deepEqual(frameAncestry(merged.frames, 23), [
    { parent: null, child: { index: -1, href: "https://shadow.example/", width: 300, height: 150 } },
  ]);
  assert.equal(frameAncestry(merged.frames, 0), null);
  assert.equal(frameAncestry(merged.frames, 99), null);
});

test("frame ancestry refuses missing or ambiguous parents instead of guessing", () => {
  const frames = new Map([
    [0, { frameId: 0, path: [] }],
    [1, { frameId: 1, path: [-1], index: -1 }],
    [2, { frameId: 2, path: [-1], index: -1 }],
    [3, { frameId: 3, path: [-1, 0], index: 0 }],
    [4, { frameId: 4, path: [5, 0], index: 0 }],
  ]);
  assert.equal(frameAncestry(frames, 3), null, "two frames share the parent path");
  assert.equal(frameAncestry(frames, 4), null, "the parent frame was not snapshotted");
  assert.equal(frameAncestry(frames, 1).length, 1);
});
