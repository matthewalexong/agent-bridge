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
  "browser_panel_identify",
  "browser_panel_post",
  "browser_panel_read",
  "browser_panel_status",
  "shopping_request_intake",
  "shopping_listing_candidates",
  "shopping_page_evidence",
  "shopping_page_evidence_batch",
  "shopping_evaluator_batch",
  "shopping_decision_dossier",
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

export function compactPanelSnapshot(snapshot, surface = resolveMcpSurface()) {
  if (surface !== MCP_SURFACE_PANEL || !snapshot || typeof snapshot !== "object") return snapshot;
  const { elements: _elements, ...compact } = snapshot;
  return compact;
}

const KEEP_FULL_PANEL_SCHEMA = new Set([
  "shopping_request_intake",
  "shopping_listing_candidates",
  "shopping_page_evidence",
  "shopping_page_evidence_batch",
]);

export function shouldSlimPanelSchema(name, surface = resolveMcpSurface()) {
  return surface === MCP_SURFACE_PANEL && String(name).startsWith("shopping_") && !KEEP_FULL_PANEL_SCHEMA.has(name);
}

export function advertisedDescription(description, surface = resolveMcpSurface()) {
  const text = String(description || "");
  if (surface !== MCP_SURFACE_PANEL || text.length <= 280) return text;
  const sentence = text.split(/(?<=\.)\s/)[0] || text.slice(0, 240);
  return `${sentence} Full contract is enforced in process; do not tool_describe.`;
}

export function defaultEvaluatorResultChars(surface = resolveMcpSurface()) {
  return surface === MCP_SURFACE_FULL ? 120_000 : 20_000;
}

export function validatePanelPost({ kind, links, candidate_set_id, candidate_ids } = {}) {
  const cards = Array.isArray(links) ? links : [];
  if (kind === "products") {
    if (cards.length > 0) return "kind=products rejects model-authored links; choose candidate_ids from shopping_listing_candidates.";
    if (!candidate_set_id || !Array.isArray(candidate_ids) || candidate_ids.length === 0) {
      return "kind=products requires candidate_set_id and candidate_ids from shopping_listing_candidates.";
    }
  } else if (candidate_set_id != null || (Array.isArray(candidate_ids) && candidate_ids.length > 0)) {
    return "candidate_set_id and candidate_ids are only valid with kind=products.";
  }
  return null;
}
