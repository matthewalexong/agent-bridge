import assert from "node:assert/strict";
import test from "node:test";
import {
  advertisedDescription,
  compactPanelRead,
  compactPanelSnapshot,
  compactPanelStatusResult,
  MCP_SURFACE_FULL,
  MCP_SURFACE_PANEL,
  PANEL_TOOL_NAMES,
  resolveMcpSurface,
  serializeToolPayload,
  shouldRegisterMcpTool,
} from "../mcp/surface.mjs";

test("live MCP surface defaults to panel", () => {
  assert.equal(resolveMcpSurface({}), MCP_SURFACE_PANEL);
  assert.equal(resolveMcpSurface({ AB_MCP_SURFACE: "panel" }), MCP_SURFACE_PANEL);
  assert.equal(resolveMcpSurface({ AB_MCP_SURFACE: "FULL" }), MCP_SURFACE_FULL);
});

test("panel conversation tools omit accumulated research trails from model responses", () => {
  const state = {
    agent: "Hermes",
    status: { text: "Verifying exact offers" },
    progress: [{ summary: "x".repeat(10_000) }],
    transcript: [{
      id: "panel_1",
      role: "user",
      text: "Find a machine",
      at: "2026-08-25T12:00:00.000Z",
      research: [{ summary: "x".repeat(10_000) }],
    }],
  };
  const compact = compactPanelRead(state, MCP_SURFACE_PANEL);
  assert.equal(compact.transcript[0].text, "Find a machine");
  assert.equal("research" in compact.transcript[0], false);
  assert.equal("progress" in compact, false);
  assert.ok(JSON.stringify(compact).length < 500);
  assert.deepEqual(compactPanelStatusResult({ status: state.status, progress: state.progress }, MCP_SURFACE_PANEL), {
    updated: true,
    status: state.status,
  });
});

test("panel surface keeps browser and panel tools and hides analysis tools", () => {
  assert.equal(shouldRegisterMcpTool("browser_snapshot", MCP_SURFACE_PANEL), true);
  assert.equal(shouldRegisterMcpTool("browser_panel_post", MCP_SURFACE_PANEL), true);
  assert.equal(shouldRegisterMcpTool("collect_code", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("debugger_pause", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("browser_click", MCP_SURFACE_PANEL), false, "selector compatibility clicks should stay behind browser_act");
  assert.equal(shouldRegisterMcpTool("browser_fill", MCP_SURFACE_PANEL), false, "selector compatibility fills should stay behind browser_act");
  assert.equal(shouldRegisterMcpTool("browser_click", MCP_SURFACE_FULL), true);
  assert.equal(shouldRegisterMcpTool("browser_fill", MCP_SURFACE_FULL), true);
  assert.equal(shouldRegisterMcpTool("collect_code", MCP_SURFACE_FULL), true);
  assert.ok(PANEL_TOOL_NAMES.length <= 20);
  assert.ok(PANEL_TOOL_NAMES.every((name) => name.startsWith("browser_")));
});

test("panel trims long tool descriptions", () => {
  const long = `${"Publish a bounded user-visible research update. ".repeat(8)}Extra.`;
  const short = advertisedDescription(long, MCP_SURFACE_PANEL);
  assert.ok(short.length < long.length);
  assert.match(short, /Full contract is enforced/);
  assert.equal(advertisedDescription(long, MCP_SURFACE_FULL), long);
});

test("tool payloads are compact JSON", () => {
  const pretty = JSON.stringify({ a: 1, b: ["x"] }, null, 2);
  const compact = serializeToolPayload({ a: 1, b: ["x"] });
  assert.equal(compact, '{"a":1,"b":["x"]}');
  assert.ok(compact.length < pretty.length);
});

test("panel snapshots keep the snapshot handle without duplicating element metadata", () => {
  const snapshot = {
    snapshotId: "snapshot-1",
    snapshot: '- link "Product" [ref=e1]',
    url: "https://www.google.com/search?q=product",
    text: "Product $20",
    elements: Array.from({ length: 500 }, (_, index) => ({
      ref: `e${index + 1}`,
      selector: `#item-${index}`,
      ...(index === 0 ? { name: "Product", href: "https://shop.example/product" } : {}),
    })),
  };
  const compact = compactPanelSnapshot(snapshot, MCP_SURFACE_PANEL);
  assert.equal(compact.snapshotId, "snapshot-1");
  assert.equal("elements" in compact, false);
  assert.equal("text" in compact, false);
  assert.deepEqual(compact.links, [{ ref: "e1", name: "Product", href: "https://shop.example/product" }]);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(snapshot).length / 4);
  assert.equal(compactPanelSnapshot(snapshot, MCP_SURFACE_FULL), snapshot);
});
