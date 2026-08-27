#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeOfflineError, callBridge } from "../lib/bridge-client.mjs";
import { clearCdpAnalysisSession, registerCdpAnalysisTools } from "./register-cdp-analysis-tools.mjs";
import { registerLocalAnalysisTools } from "./register-local-analysis-tools.mjs";
import { registerShoppingTools } from "./register-shopping-tools.mjs";
import { captureBrowserSnapshotsBatch, createBrowserEvidenceRegistry } from "../lib/shopping-browser-evidence.mjs";
import { createShoppingCandidateRegistry } from "../lib/shopping-candidate-registry.mjs";
import { appendShoppingRecommendationSummary, createShoppingRecommendationRegistry, shoppingRecommendationCardDetails, shoppingRecommendationEvidenceCards } from "../lib/shopping-recommendation-registry.mjs";
import { advertisedDescription, compactPanelRead, compactPanelSnapshot, compactPanelStatusResult, defaultEvaluatorResultChars, resolveMcpSurface, serializeToolPayload, shouldRegisterMcpTool, shouldSlimPanelSchema, validatePanelPost, validatePanelProductClaims } from "./surface.mjs";

const server = new McpServer({
  name: "chrome-agent-bridge",
  version: "0.9.0",
});
const browserEvidenceRegistry = createBrowserEvidenceRegistry();
const shoppingCandidateRegistry = createShoppingCandidateRegistry();
const shoppingRecommendationRegistry = createShoppingRecommendationRegistry();
const mcpSurface = resolveMcpSurface();

function asText(value) {
  return {
    content: [{ type: "text", text: serializeToolPayload(value) }],
    structuredContent: value,
  };
}

function asPanelText(value) {
  if (mcpSurface !== "panel") return asText(value);
  return { content: [{ type: "text", text: serializeToolPayload(value) }] };
}

function asError(error) {
  const code = error?.code || (error instanceof BridgeOfflineError ? "bridge_offline" : "bridge_error");
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
            recovery:
              code === "bridge_offline"
                ? "Ensure the unpacked extension and native host are installed, reload the extension, then retry."
                : code === "unauthorized"
                  ? "Reload the local token or renew it from the extension popup, then retry."
                  : "Inspect current browser state before retrying.",
          },
        }, null, 2),
      },
    ],
  };
}

function advertisedToolConfig(name, config) {
  const next = { ...config, description: advertisedDescription(config.description, mcpSurface) };
  if (shouldSlimPanelSchema(name, mcpSurface) && config.inputSchema && typeof config.inputSchema === "object") {
    next.inputSchema = Object.fromEntries(Object.keys(config.inputSchema).map((key) => [key, z.any()]));
  }
  return next;
}

function tool(name, config, handler) {
  if (!shouldRegisterMcpTool(name, mcpSurface)) return;
  server.registerTool(name, advertisedToolConfig(name, config), async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      return asError(error);
    }
  });
}

tool(
  "browser_status",
  {
    title: "Browser status",
    description: "Check whether the Chrome extension and native host are connected.",
    inputSchema: {},
  },
  async () => asText(await callBridge("browser.status")),
);

tool(
  "browser_list_tabs",
  {
    title: "List Chrome tabs",
    description: "List current scriptable Chrome tabs. Use before selecting a tab ID.",
    inputSchema: {},
  },
  async () => asText({ tabs: await callBridge("tabs.list") }),
);

tool(
  "browser_open_tab",
  {
    title: "Open Chrome tab",
    description: "Open an HTTP, HTTPS, file, or about:blank URL in Chrome.",
    inputSchema: {
      url: z.string().url().or(z.literal("about:blank")),
      active: z.boolean().optional().default(true),
    },
  },
  async (input) => asText(await callBridge("tabs.create", input)),
);

tool(
  "browser_activate_tab",
  {
    title: "Activate Chrome tab",
    description: "Activate a Chrome tab and focus its window.",
    inputSchema: { tabId: z.number().int().nonnegative() },
  },
  async (input) => asText(await callBridge("tabs.activate", input)),
);

tool(
  "browser_close_tab",
  {
    title: "Close bridge-created Chrome tab",
    description: "Close a tab only when it was created by Chrome Agent Bridge in the current extension session.",
    inputSchema: { tabId: z.number().int().nonnegative() },
  },
  async (input) => asText(await callBridge("tabs.close", input)),
);

tool(
  "browser_navigate",
  {
    title: "Navigate Chrome tab",
    description: "Navigate an existing tab to an HTTP, HTTPS, file, or about:blank URL.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      url: z.string().url().or(z.literal("about:blank")),
    },
  },
  async (input) => asText(await callBridge("tabs.navigate", input)),
);

tool(
  "browser_snapshot",
  {
    title: "Snapshot page",
    description:
      "Read bounded visible page text plus semantic short-lived refs. The response includes snapshotId; pass it to shopping_page_evidence. Use a ref with browser_act, then take a fresh snapshot after every action.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      maxChars: z.number().int().min(1_000).max(50_000).optional().default(8_000),
    },
  },
  async (input) => {
    const result = await callBridge("page.snapshot", input);
    const evidence_receipt = browserEvidenceRegistry.capture({
      tab_id: input.tabId,
      snapshot: result,
      captured_at: result.captured_at || result.capturedAt || null,
    });
    // Hermes consumes the text content. Repeating a large snapshot again as
    // structuredContent can cross its spillover threshold, hiding snapshotId
    // from the very next shopping evidence call and wasting recovery turns.
    return asPanelText(compactPanelSnapshot({ ...result, evidence_receipt }, mcpSurface));
  },
);

tool(
  "browser_snapshot_batch",
  {
    title: "Snapshot several independent pages concurrently",
    description:
      "Capture 1-8 distinct Chrome tabs concurrently and issue a signed browser evidence receipt for each successful snapshot. Use after opening independent evidence-domain pages; failures remain per-tab and do not discard successful captures. The total visible-text budget is bounded.",
    inputSchema: {
      pages: z.array(z.object({
        tabId: z.number().int().nonnegative(),
        maxChars: z.number().int().min(1_000).max(30_000).optional().default(6_000),
      })).min(1).max(8),
    },
  },
  async (input) => {
    const results = await captureBrowserSnapshotsBatch(input.pages, {
      snapshot: (page) => callBridge("page.snapshot", page),
      capture: (entry) => browserEvidenceRegistry.capture(entry),
    });
    return asPanelText({
      results: results.map((entry) => entry.status === "complete"
        ? { ...entry, snapshot: compactPanelSnapshot(entry.snapshot, mcpSurface) }
        : entry),
    });
  },
);

tool(
  "browser_screenshot",
  {
    title: "Screenshot page",
    description: "Capture the visible viewport of a Chrome tab. This activates the tab.",
    inputSchema: { tabId: z.number().int().nonnegative() },
  },
  async (input) => {
    const result = await callBridge("page.screenshot", input);
    const match = /^data:image\/png;base64,(.+)$/.exec(result.dataUrl || "");
    if (!match) throw new Error("Extension returned an invalid PNG screenshot");
    return {
      content: [
        { type: "text", text: `Captured Chrome tab ${result.tabId}.` },
        { type: "image", data: match[1], mimeType: "image/png" },
      ],
    };
  },
);

tool(
  "browser_act",
  {
    title: "Act on page element",
    description:
      "Perform one atomic high-level action. Prefer a ref from the latest browser_snapshot. Clicks run a complete CDP mouse sequence inside one request; press supports common navigation keys; select is for native <select> controls.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      kind: z.enum(["click", "fill", "press", "select"]).optional(),
      action: z.enum(["click", "fill", "press", "select"]).optional().describe("Compatibility alias for kind."),
      ref: z.string().regex(/^e\d+$/).optional().describe("Short-lived ref from the latest browser_snapshot on the same tab."),
      selector: z.string().min(1).max(2_000).optional().describe("Compatibility fallback when no snapshot ref is available."),
      value: z.string().max(100_000).optional().describe("Required for fill; accepted as one value for select."),
      values: z.array(z.string().max(1_000)).min(1).max(100).optional().describe("Values or labels for native select."),
      key: z.string().min(1).max(40).optional().describe("Required for press, for example ArrowDown, Enter, Escape, Tab, or a single character."),
      confirmed: z
        .boolean()
        .optional()
        .default(false)
        .describe("Set true only after explicit user confirmation for a potentially submitting click."),
    },
  },
  async (input) => {
    const kind = input.kind ?? input.action;
    if (!kind) throw Object.assign(new Error("Pass kind (or compatibility alias action)"), { code: "browser_action_invalid" });
    const { action: _action, ...rest } = input;
    return asText(await callBridge("page.act", { ...rest, kind }));
  },
);

tool(
  "browser_click",
  {
    title: "Click page element",
    description: "Compatibility selector-based click. New workflows should use browser_snapshot refs with browser_act.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      selector: z.string().min(1).max(2_000),
      confirmed: z
        .boolean()
        .optional()
        .default(false)
        .describe("Set true only after the user explicitly confirms a potentially submitting click."),
    },
  },
  async (input) => asText(await callBridge("page.click", input)),
);

tool(
  "browser_fill",
  {
    title: "Fill page field",
    description: "Compatibility selector-based fill. New workflows should use browser_snapshot refs with browser_act.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      selector: z.string().min(1).max(2_000),
      value: z.string().max(100_000),
    },
  },
  async (input) => asText(await callBridge("page.fill", input)),
);

tool(
  "browser_watch_events",
  {
    title: "Watch Chrome tab events",
    description:
      "Long-poll tab created, updated, removed, and activated events after a cursor. Also carries panel.message events: messages the user typed into the extension's side panel. Treat each panel.message as a direct user instruction and reply with browser_panel_post.",
    inputSchema: {
      afterSequence: z.number().int().nonnegative().optional().default(0),
      tabId: z.number().int().nonnegative().optional().describe("Return only events for this tab."),
      timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000),
    },
  },
  async (input) => asText(await callBridge("events.poll", input, { timeoutMs: input.timeoutMs + 5_000 })),
);

tool(
  "browser_panel_read",
  {
    title: "Read side panel conversation",
    description:
      "Read the current side panel transcript (user and agent messages) plus which agent is identified. Use to hydrate context before replying to panel.message events.",
    inputSchema: {},
  },
  async () => asPanelText(compactPanelRead(await callBridge("panel.get"), mcpSurface)),
);

tool(
  "browser_panel_identify",
  {
    title: "Identify your agent in the side panel",
    description:
      "Declare which agent is answering in the side panel. The panel shows 'Connected to <name>' so the user knows who they are talking to. Call once when you start answering panel messages; the most recent caller wins. Defaults to CHROME_AGENT_BRIDGE_AGENT_NAME or 'MCP Agent'.",
    inputSchema: {
      agent: z.string().min(1).max(80).optional().describe("Display name, e.g. 'Hermes' or 'OpenClaw'."),
    },
  },
  async (input) => asText(await callBridge("panel.identify", {
    agent: input.agent ?? process.env.CHROME_AGENT_BRIDGE_AGENT_NAME ?? "MCP Agent",
  })),
);

tool(
  "browser_panel_status",
  {
    title: "Update live side panel progress",
    description:
      "Publish a bounded user-visible research update. Call directly, never through tool_call. For non-trivial panel requests, call early with the plan and again after meaningful evidence or decisions. State actions, concrete evidence, conclusions, and the next step—never hidden chain-of-thought, private scratch work, or generic 'thinking'. Updates appear live and are attached to the final answer as a collapsible research trail.",
    inputSchema: {
      summary: z.string().min(1).max(1_000).optional().describe(
        "Cumulative progress summary, ideally using short 'Doing / Found / Next' phrases. Include concrete sources, counts, constraints, or decisions when known.",
      ),
      text: z.string().min(1).max(1_000).optional().describe("Compatibility alias for summary."),
      phase: z.enum(["plan", "search", "inspect", "verify", "compare", "decision", "working"]).optional().default("working"),
      evidence: z.array(z.string().min(1).max(160)).max(5).optional().default([]).describe("Short externally supportable facts, source names, counts, prices, or gate results; no hidden reasoning."),
      next: z.string().min(1).max(200).optional().describe("The next concrete action or unresolved question."),
    },
  },
  async (input) => asPanelText(compactPanelStatusResult(await callBridge("panel.status", {
    text: (input.summary ?? input.text ?? "Researching current options…").slice(0, 300),
    phase: input.phase,
    evidence: input.evidence,
    next: input.next,
    persist: true,
  }), mcpSurface)),
);

tool(
  "browser_panel_post",
  {
    title: "Post a reply to the side panel",
    description:
      "Post a reply into the extension's side panel chat. Research updates are attached automatically. For product recommendations, choose exact-page-hydrated candidate_ids from the short-lived candidate_set_id; Agent Bridge reconstructs cards with signed current item price, observed seller, and availability. Verified cards must match the exact candidate-offer evidence bound to the final dossier; changed or rehydrated cards fail closed, and concise available verified cost, delivery, return, protection, and risk details are appended automatically. Unhydrated candidates and model-authored product links are rejected. Source_snapshot_ids are only a no-surviving-product fallback and cannot carry a shortlist, price/stock, winner, or market-exclusivity claim.",
    inputSchema: {
      text: z.string().min(1).max(20_000),
      kind: z.enum(["products", "question", "none"]).describe("products = recommendations bound to a candidate set. question = one product-specific ask. none = no listing to show."),
      shopping_phase: z.enum(["explore_category", "define_requirements", "research_products", "compare_offers", "decide_purchase"]).optional().describe("Main-reasoning-model judgment of the user's current shopping journey phase. Required for product cards. Early phases structurally reject cards and links."),
      agent: z.string().min(1).max(80).optional().describe("Identify as this agent before posting (first reply)."),
      candidate_set_id: z.string().regex(/^cset_[a-f0-9]{24}$/).optional().describe("Short-lived set ID from shopping_listing_candidates. Required for products."),
      candidate_ids: z.array(z.string().regex(/^listing_[a-f0-9]{16}$/)).min(1).max(5).optional().describe("Chosen IDs from that candidate set, in display order. Required for products."),
      recommendation_state: z.enum(["provisional", "verified"]).optional().describe("Required for products. Provisional is visibly labeled; verified requires final dossier references."),
      availability_requirement: z.enum(["in_stock_only", "allow_unknown"]).optional().default("in_stock_only").describe("Product cards default to explicit signed in-stock offers. Use allow_unknown only for a clearly labeled research lead, never an in-stock shortlist."),
      recommendation_refs: z.array(z.object({ recommendation_id: z.string().regex(/^shopping_recommendation_[a-f0-9]{32}$/), dossier_id: z.string().min(1).max(160), phase: z.enum(["product_recommendation", "offer_recommendation"]), candidate_id: z.string().regex(/^listing_[a-f0-9]{16}$/) }).strict()).min(1).max(5).optional(),
      source_snapshot_ids: z.array(z.string().min(1).max(160)).min(1).max(5).optional().describe("For question/none replies only: fresh snapshot IDs from pages actually opened. Agent Bridge reconstructs safe clickable source cards."),
      links: z.array(z.object({
        url: z.string().url(),
        title: z.string().max(200).optional(),
        image: z.string().url().optional().describe("Thumbnail image URL shown on the card."),
        price: z.string().max(40).optional(),
      })).max(5).optional().describe("Optional non-product page cards. Rejected for kind=products."),
    },
  },
  async (input) => {
    if (input.kind === "products" && Array.isArray(input.links) && input.links.length > 0) {
      let inferred;
      try {
        inferred = shoppingCandidateRegistry.matchHydratedLinks(input.links);
      } catch {
        return asText({ posted: false, error: "kind=products rejects model-authored links unless every URL exactly matches one current signed hydrated candidate set; pass candidate_set_id and candidate_ids." });
      }
      if (input.candidate_set_id != null && input.candidate_set_id !== inferred.candidate_set_id) {
        return asText({ posted: false, error: "Product links conflict with candidate_set_id." });
      }
      if (Array.isArray(input.candidate_ids) && JSON.stringify(input.candidate_ids) !== JSON.stringify(inferred.candidate_ids)) {
        return asText({ posted: false, error: "Product links conflict with candidate_ids." });
      }
      input = {
        ...input,
        ...inferred,
        recommendation_state: input.recommendation_state ?? "provisional",
        links: [],
      };
    }
    const rejected = validatePanelPost(input);
    if (rejected) return asText({ posted: false, error: rejected });
    const verifiedSummaries = input.kind === "products" && input.recommendation_state === "verified"
      ? input.candidate_ids.map((candidateId, index) => shoppingRecommendationRegistry.authorize(
        input.recommendation_refs[index],
        candidateId,
        shoppingCandidateRegistry.binding(input.candidate_set_id, candidateId),
      ))
      : [];
    if (input.agent != null) await callBridge("panel.identify", { agent: input.agent });
    const sourceLinks = input.kind === "products" ? [] : (input.source_snapshot_ids ?? []).map((snapshotId) => {
      const { receipt } = browserEvidenceRegistry.resolve(snapshotId);
      const url = new URL(receipt.url);
      if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("Source cards require a fresh HTTP(S) browser snapshot"), { code: "panel_source_snapshot_invalid" });
      return { url: url.href, title: String(receipt.title || url.hostname).slice(0, 200) };
    });
    const links = input.kind === "products"
      ? shoppingCandidateRegistry.cards(input.candidate_set_id, input.candidate_ids)
      : [...sourceLinks, ...(input.links ?? [])].filter((link, index, all) => all.findIndex((item) => item.url === link.url) === index).slice(0, 5);
    for (let index = 0; index < verifiedSummaries.length; index += 1) Object.assign(links[index], shoppingRecommendationCardDetails(verifiedSummaries[index]));
    const claimRejected = input.kind === "products" ? validatePanelProductClaims({ text: input.text, links, recommendation_state: input.recommendation_state, availability_requirement: input.availability_requirement }) : null;
    if (claimRejected) return asText({ posted: false, error: claimRejected });
    if (verifiedSummaries.length && links.length < 5) links.push(...shoppingRecommendationEvidenceCards(verifiedSummaries, 5 - links.length));
    let text = input.kind === "products" && input.recommendation_state === "provisional" && !/^provisional results\b/i.test(input.text)
      ? `Provisional results — ${input.text}`
      : input.text;
    if (verifiedSummaries.length) text = appendShoppingRecommendationSummary(text, verifiedSummaries);
    return asText(await callBridge("panel.post", { text, links }));
  },
);

const networkSessionId = z.string().min(20).max(120);
const rawSessionId = z.string().min(20).max(120);
const networkResourceType = z.enum([
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "xhr",
  "fetch",
  "websocket",
  "other",
]);

tool(
  "browser_network_start",
  {
    title: "Start network monitoring",
    description:
      "Start a tab-scoped, metadata-only Chrome network monitor. Pass rawSessionId to reuse that Raw CDP attachment instead of attaching a second debugger. Headers and bodies are never returned.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      rawSessionId: rawSessionId.optional(),
      urlMode: z.enum(["origin_path", "full"]).optional().default("origin_path"),
      resourceTypes: z.array(networkResourceType).max(10).optional().default([]),
      urlIncludes: z.array(z.string().max(200)).max(20).optional().default([]),
      maxEvents: z.number().int().min(1).max(1_000).optional().default(500),
      maxBytes: z.number().int().min(65_536).max(4_000_000).optional().default(1_000_000),
    },
  },
  async (input) => asText(await callBridge("network.start", input)),
);

tool(
  "browser_network_poll",
  {
    title: "Poll network events",
    description:
      "Read sanitized request, response, completion, failure, and WebSocket lifecycle metadata after a cursor. Completion and failure events include method, status when known, and durationMs.",
    inputSchema: {
      sessionId: networkSessionId,
      afterCursor: z.number().int().nonnegative().optional().default(0),
      limit: z.number().int().min(1).max(200).optional().default(100),
      timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000),
    },
  },
  async (input) => asText(
    await callBridge("network.poll", input, { timeoutMs: input.timeoutMs + 5_000 }),
  ),
);

tool(
  "browser_network_stop",
  {
    title: "Stop network monitoring",
    description: "Stop a network monitor and release its resources. It detaches Chrome only when the monitor owns the attachment; a reused Raw session remains attached.",
    inputSchema: { sessionId: networkSessionId },
  },
  async (input) => asText(await callBridge("network.stop", input)),
);

tool(
  "browser_cdp_attach",
  {
    title: "Attach Raw CDP",
    description:
      "Attach an unrestricted Chrome DevTools Protocol session to one tab. Set captureEvents=false when only commands plus a sanitized network projection are needed; captured Raw events may expose credentials and private data.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      captureEvents: z.boolean().optional().default(true),
      maxEvents: z.number().int().min(1).max(1_000).optional().default(500),
      maxBytes: z.number().int().min(65_536).max(64 * 1024 * 1024).optional().default(1_000_000),
    },
  },
  async (input) => asText(await callBridge("raw.attach", input)),
);

tool(
  "browser_cdp_send",
  {
    title: "Send Raw CDP command",
    description:
      "Send any CDP method and JSON params without a method allowlist or response sanitization. Use targetSessionId for a child target previously attached within this Raw CDP session.",
    inputSchema: {
      sessionId: rawSessionId,
      method: z.string().min(1).max(200),
      params: z.record(z.unknown()).optional().default({}),
      targetSessionId: z.string().min(1).max(200).optional(),
    },
  },
  async (input) => asText(await callBridge("raw.send", input)),
);

tool(
  "browser_cdp_events",
  {
    title: "Poll Raw CDP events",
    description:
      "Read original CDP event methods, source targets, and params without field sanitization. Results may contain secrets or private browsing data.",
    inputSchema: {
      sessionId: rawSessionId,
      afterCursor: z.number().int().nonnegative().optional().default(0),
      limit: z.number().int().min(1).max(200).optional().default(100),
      timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000),
    },
  },
  async (input) => asText(
    await callBridge("raw.poll", input, { timeoutMs: input.timeoutMs + 5_000 }),
  ),
);

tool(
  "browser_cdp_detach",
  {
    title: "Detach Raw CDP",
    description: "Detach an unrestricted CDP session from its tab and release child-target routing state.",
    inputSchema: { sessionId: rawSessionId },
  },
  async (input) => {
    try {
      return asText(await callBridge("raw.detach", input));
    } finally {
      clearCdpAnalysisSession(input.sessionId);
    }
  },
);

registerLocalAnalysisTools({ tool, asText });
registerCdpAnalysisTools({ tool, asText });
registerShoppingTools({
  tool,
  asText,
  resolveBrowserSnapshot: (snapshotId, options) => browserEvidenceRegistry.resolve(snapshotId, options),
  storeListingCandidateSet: (artifact) => shoppingCandidateRegistry.store(artifact),
  resolveListingCandidateSet: (candidateSetId) => shoppingCandidateRegistry.resolve(candidateSetId),
  hydrateListingCandidateSet: (artifact) => shoppingCandidateRegistry.hydrate(artifact),
  bindShoppingRecommendationOffers: (contextId, artifact) => shoppingRecommendationRegistry.bindCandidateOffers(contextId, artifact),
  storeShoppingRecommendation: (dossier, stages) => shoppingRecommendationRegistry.store(dossier, stages),
  resolvePanelRequest: async (requestId) => {
    const panel = await callBridge("panel.get");
    const matches = (panel?.transcript || []).filter((entry) => entry?.role === "user" && entry?.id === requestId);
    if (matches.length !== 1) throw Object.assign(new Error("User request ID does not resolve to exactly one current panel message"), { code: "shopping_request_not_found" });
    return { request_id: requestId, request_revision: 1, text: matches[0].text, captured_at: matches[0].at };
  },
});

await server.connect(new StdioServerTransport());
