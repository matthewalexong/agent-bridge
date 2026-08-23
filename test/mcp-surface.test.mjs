import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("panel surface keeps hubs and hides analysis/checkout tools", () => {
  assert.equal(shouldRegisterMcpTool("browser_snapshot", MCP_SURFACE_PANEL), true);
  assert.equal(shouldRegisterMcpTool("shopping_evaluator_batch", MCP_SURFACE_PANEL), true);
  assert.equal(shouldRegisterMcpTool("browser_panel_post", MCP_SURFACE_PANEL), true);
  assert.equal(shouldRegisterMcpTool("collect_code", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("debugger_pause", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("shopping_checkout_terms_accept", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("shopping_merchant_trust", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("collect_code", MCP_SURFACE_FULL), true);
  assert.ok(PANEL_TOOL_NAMES.length <= 32);
  assert.ok(PANEL_TOOL_NAMES.includes("shopping_evaluator_batch"));
});

test("tool payloads are compact JSON", () => {
  const pretty = JSON.stringify({ a: 1, b: ["x"] }, null, 2);
  const compact = serializeToolPayload({ a: 1, b: ["x"] });
  assert.equal(compact, "{\"a\":1,\"b\":[\"x\"]}");
  assert.ok(compact.length < pretty.length);
});
