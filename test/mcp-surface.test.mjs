import assert from "node:assert/strict";
import test from "node:test";
import {
  advertisedDescription,
  defaultEvaluatorResultChars,
  MCP_SURFACE_FULL,
  MCP_SURFACE_PANEL,
  PANEL_TOOL_NAMES,
  resolveMcpSurface,
  serializeToolPayload,
  shouldRegisterMcpTool,
  shouldSlimPanelSchema,
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

test("panel slims fat shopping schemas and descriptions", () => {
  assert.equal(shouldSlimPanelSchema("shopping_decision_dossier", MCP_SURFACE_PANEL), true);
  assert.equal(shouldSlimPanelSchema("shopping_page_evidence", MCP_SURFACE_PANEL), false);
  assert.equal(shouldSlimPanelSchema("shopping_decision_dossier", MCP_SURFACE_FULL), false);
  const long = `${"Deterministically compose an auditable decision. ".repeat(8)}Extra.`;
  const short = advertisedDescription(long, MCP_SURFACE_PANEL);
  assert.ok(short.length < long.length);
  assert.match(short, /Full contract is enforced/);
  assert.equal(advertisedDescription(long, MCP_SURFACE_FULL), long);
  assert.equal(defaultEvaluatorResultChars(MCP_SURFACE_PANEL), 20_000);
  assert.equal(defaultEvaluatorResultChars(MCP_SURFACE_FULL), 120_000);
});

test("tool payloads are compact JSON", () => {
  const pretty = JSON.stringify({ a: 1, b: ["x"] }, null, 2);
  const compact = serializeToolPayload({ a: 1, b: ["x"] });
  assert.equal(compact, '{"a":1,"b":["x"]}');
  assert.ok(compact.length < pretty.length);
});
