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
  // `snapshot` already contains the bounded semantic page text the model
  // needs. Keep a small destination map so search results can be navigated by
  // exact href instead of brittle overlay-prone clicks. The plain `text` field
  // repeats the page, while full elements remain in the signed registry.
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

function compactPanelOffer(offer) {
  const evidence = offer?.listing_evidence || {};
  const facts = evidence.facts || {};
  return {
    candidate_id: offer?.candidate_id,
    title: offer?.candidate?.title || evidence?.source_receipt?.title || null,
    url: offer?.candidate?.url || evidence?.source?.url || null,
    captured_at: evidence?.source?.captured_at || null,
    price_usd: facts.price_usd || null,
    stock: facts.stock || null,
    seller: facts.seller || null,
    fulfiller: facts.fulfiller || null,
    shipping_usd: facts.shipping_usd || null,
    warnings: evidence.warnings || [],
  };
}

export function compactPanelHydrationResult({ candidate_offers, candidate_offers_ref, artifacts, ledger } = {}, surface = resolveMcpSurface()) {
  if (surface !== MCP_SURFACE_PANEL) {
    return {
      ...(candidate_offers ? {
        candidate_set_id: candidate_offers.candidate_set_id,
        candidate_ids: candidate_offers.offers.map((offer) => offer.candidate_id),
        candidate_offers,
        candidate_offers_ref,
      } : { artifacts }),
      ledger,
    };
  }
  if (candidate_offers) {
    return {
      candidate_set_id: candidate_offers.candidate_set_id,
      candidate_ids: candidate_offers.offers.map((offer) => offer.candidate_id),
      candidate_offers_summary: candidate_offers.offers.map(compactPanelOffer),
      candidate_offers_ref,
      ledger,
    };
  }
  return {
    artifacts_summary: (artifacts || []).map((artifact) => compactPanelOffer({ listing_evidence: artifact })),
    ledger,
  };
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

export function validatePanelPost({ text, kind, links, candidate_set_id, candidate_ids, recommendation_state, recommendation_refs, source_snapshot_ids } = {}) {
  const cards = Array.isArray(links) ? links : [];
  if (kind === "products") {
    if (cards.length > 0) return "kind=products rejects model-authored links; choose candidate_ids from shopping_listing_candidates.";
    if (Array.isArray(source_snapshot_ids) && source_snapshot_ids.length > 0) return "kind=products rejects source snapshot cards; product cards come from signed candidate evidence.";
    if (!candidate_set_id || !Array.isArray(candidate_ids) || candidate_ids.length === 0) {
      return "kind=products requires candidate_set_id and candidate_ids from shopping_listing_candidates.";
    }
    if (!['provisional', 'verified'].includes(recommendation_state)) return "kind=products requires recommendation_state=provisional or verified.";
    if (recommendation_state === "verified" && (!Array.isArray(recommendation_refs) || recommendation_refs.length !== candidate_ids.length)) return "verified product cards require one recommendation_ref per candidate_id.";
    if (recommendation_state === "provisional" && Array.isArray(recommendation_refs) && recommendation_refs.length) return "provisional product cards cannot claim recommendation authority.";
  } else if (candidate_set_id != null || (Array.isArray(candidate_ids) && candidate_ids.length > 0) || recommendation_state != null || (Array.isArray(recommendation_refs) && recommendation_refs.length > 0)) {
    return "candidate and recommendation fields are only valid with kind=products.";
  }
  if (kind === "none" && Array.isArray(source_snapshot_ids) && source_snapshot_ids.length > 0 && /(?:[$£€]\s?\d|\b(?:best|cheapest|winner|buy now|in stock|sold out|pre-?order|no other architecture|only (?:true|practical|viable|new) (?:path|option|architecture))\b)/i.test(String(text || ""))) {
    return "Source-only cards cannot publish a product shortlist, current price or stock, winner, or market-exclusivity claim; use signed product candidates or state that offer verification is incomplete.";
  }
  return null;
}

export function validatePanelProductClaims({ text, links, recommendation_state, availability_requirement = "in_stock_only" } = {}) {
  const copy = String(text || "");
  const cards = Array.isArray(links) ? links : [];
  if (/\b(?:no other architecture|only (?:true|practical|viable) (?:path|option|architecture)|nothing else (?:qualifies|compares|is comparable))\b/i.test(copy)) {
    return "Offer cards cannot support an absolute market-exclusivity claim; report the researched alternatives and remaining scope instead.";
  }
  if (recommendation_state === "provisional" && /\b(?:cheapest|lowest(?:\s+(?:price|cost))?|best\s+(?:option|pick|offer|value|match)|winner|buy now)\b/i.test(copy)) {
    return "Provisional product cards cannot name a winner or make a lowest-price claim; complete the final dossier first.";
  }
  if (cards.some((card) => card?.availability === "Availability unknown") && /\b(?:in stock|sold out|out of stock|available now|(?:same[- ]day )?pick-?up|ships? (?:today|tomorrow|by)|arrives? (?:today|tomorrow|by))\b/i.test(copy)) {
    return "The reply makes a current availability claim for cards whose signed availability is unknown.";
  }
  if (cards.some((card) => !card?.landed_total) && /\b(?:true price|landed total|all[- ]in (?:price|cost)|total after (?:tax|shipping|fees))\b/i.test(copy)) {
    return "The reply makes a total-price claim without a verified landed total for every displayed card.";
  }
  if (availability_requirement === "in_stock_only" && cards.some((card) => !/^in stock$/i.test(String(card?.availability || "")))) {
    return "An in-stock shortlist can contain only cards with explicit signed In stock availability; verify another seller or omit the card.";
  }
  if (availability_requirement === "allow_unknown" && cards.some((card) => /^availability unknown$/i.test(String(card?.availability || ""))) && !/^availability unverified\b/i.test(copy)) {
    return "Unknown-availability research leads must begin with 'Availability unverified' and cannot be presented as an in-stock shortlist.";
  }
  return null;
}
