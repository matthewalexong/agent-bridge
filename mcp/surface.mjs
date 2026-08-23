// Live Hermes panel sessions only need browser + shopping hubs.
// The full catalog (CDP/analysis/checkout/watch/individual assessors)
// stays available when AB_MCP_SURFACE=full (tests and debugger work).

export const MCP_SURFACE_PANEL = "panel";
export const MCP_SURFACE_FULL = "full";

export const PANEL_TOOL_NAMES = Object.freeze([
  "browser_status",
  "browser_list_tabs",
  "browser_open_tab",
  "browser_close_tab",
  "browser_activate_tab",
  "browser_navigate",
  "browser_snapshot",
  "browser_snapshot_batch",
  "browser_screenshot",
  "browser_act",
  "browser_click",
  "browser_fill",
  "browser_panel_identify",
  "browser_panel_post",
  "browser_panel_read",
  "browser_panel_status",
  "shopping_request_intake",
  "shopping_page_evidence",
  "shopping_page_evidence_batch",
  "shopping_evaluator_batch",
  "shopping_decision_dossier",
  "shopping_identity_resolve",
  "shopping_preference_rank",
  "shopping_product_evidence",
  "shopping_candidate_coverage",
  "shopping_offer_analyze",
  "shopping_profile_resolve",
  "shopping_profile_list",
  "shopping_profile_remember",
  "shopping_profile_update",
  "shopping_profile_forget",
]);

const PANEL_TOOL_SET = new Set(PANEL_TOOL_NAMES);

export function resolveMcpSurface(env = process.env) {
  return String(env.AB_MCP_SURFACE || "panel").trim().toLowerCase() === "full"
    ? MCP_SURFACE_FULL
    : MCP_SURFACE_PANEL;
}

export function shouldRegisterMcpTool(name, surface = resolveMcpSurface()) {
  return surface === MCP_SURFACE_FULL || PANEL_TOOL_SET.has(name);
}

export function serializeToolPayload(value) {
  return JSON.stringify(value);
}
