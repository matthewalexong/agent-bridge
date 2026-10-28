// Live Hermes panel sessions only need the browser and panel tools.
// The full catalog (CDP/analysis/selector compatibility tools) stays
// available when AB_MCP_SURFACE=full (tests and debugger work).

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
  // `snapshot` already contains the bounded semantic page text the model
  // needs. Keep a small destination map so search results can be navigated by
  // exact href instead of brittle overlay-prone clicks. The plain `text` field
  // and full element list repeat the page, so they stay out of panel replies.
  const { elements = [], text: _text, ...compact } = snapshot;
  let pageHost = "";
  try { pageHost = new URL(snapshot.url || "").hostname.toLowerCase(); } catch {}
  const isSearchPage = /(?:^|\.)(?:google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com)$/.test(pageHost);
  const seen = new Set();
  const links = [];
  let linkChars = 0;
  if (isSearchPage) for (const element of elements) {
    if (typeof element?.href !== "string" || !/^https?:\/\//i.test(element.href)) continue;
    let href;
    let host;
    try {
      const parsed = new URL(element.href);
      parsed.hash = "";
      href = parsed.toString();
      host = parsed.hostname.toLowerCase();
    } catch { continue; }
    if (host === pageHost || host.endsWith(`.${pageHost}`) || seen.has(href)) continue;
    const link = { ref: element.ref, name: element.name || null, href };
    const size = JSON.stringify(link).length;
    if (links.length >= 30 || linkChars + size > 5_000) break;
    seen.add(href);
    links.push(link);
    linkChars += size;
  }
  return links.length ? { ...compact, links } : compact;
}

export function compactPanelRead(result, surface = resolveMcpSurface()) {
  if (surface !== MCP_SURFACE_PANEL || !result || typeof result !== "object") return result;
  return {
    agent: result.agent ?? null,
    status: result.status ?? null,
    transcript: (Array.isArray(result.transcript) ? result.transcript : []).slice(-20).map((entry) => ({
      id: entry.id,
      role: entry.role,
      text: entry.text,
      at: entry.at,
      ...(Array.isArray(entry.links) && entry.links.length ? { links: entry.links.map((link) => ({
        url: link.url,
        title: link.title,
        price: link.price,
        availability: link.availability,
      })) } : {}),
    })),
  };
}

export function compactPanelStatusResult(result, surface = resolveMcpSurface()) {
  if (surface !== MCP_SURFACE_PANEL || !result || typeof result !== "object") return result;
  return { updated: true, status: result.status ?? null };
}

export function advertisedDescription(description, surface = resolveMcpSurface()) {
  const text = String(description || "");
  if (surface !== MCP_SURFACE_PANEL || text.length <= 280) return text;
  const sentence = text.split(/(?<=\.)\s/)[0] || text.slice(0, 240);
  return `${sentence} Full contract is enforced in process; do not tool_describe.`;
}
