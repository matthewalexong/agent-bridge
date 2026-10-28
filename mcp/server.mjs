#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeOfflineError, callBridge } from "../lib/bridge-client.mjs";
import { clearCdpAnalysisSession, registerCdpAnalysisTools } from "./register-cdp-analysis-tools.mjs";
import { registerLocalAnalysisTools } from "./register-local-analysis-tools.mjs";
import { advertisedDescription, compactPanelRead, compactPanelSnapshot, compactPanelStatusResult, resolveMcpSurface, serializeToolPayload, shouldRegisterMcpTool } from "./surface.mjs";

const server = new McpServer({
  name: "chrome-agent-bridge",
  version: "0.9.0",
});
const mcpSurface = resolveMcpSurface();
const configuredPanelAgentName = String(process.env.CHROME_AGENT_BRIDGE_AGENT_NAME || "").trim().slice(0, 80);

async function syncConfiguredPanelIdentity() {
  if (!configuredPanelAgentName) return;
  try {
    const panel = await callBridge("panel.get");
    if (panel?.agent?.name == null) await callBridge("panel.identify", { agent: configuredPanelAgentName });
  } catch {
    // The side panel/native host may start after this MCP process. A bounded
    // local heartbeat retries without inference and never overwrites another
    // non-null agent identity.
  }
}

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

function tool(name, config, handler) {
  if (!shouldRegisterMcpTool(name, mcpSurface)) return;
  server.registerTool(name, { ...config, description: advertisedDescription(config.description, mcpSurface) }, async (input) => {
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
    description: "Close a tab only when it was created by Agent Bridge in the current extension session.",
    inputSchema: { tabId: z.number().int().nonnegative() },
  },
  async (input) => asText(await callBridge("tabs.close", input)),
);

tool(
  "browser_navigate",
  {
    title: "Navigate Chrome tab",
    description: "Navigate an existing tab to an HTTP, HTTPS, file, or about:blank URL. The extension enforces the side-panel browser-access mode and may hold this exact call for approval.",
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
      "Read bounded visible page text plus semantic short-lived refs. Use a ref with browser_act, then take a fresh snapshot after every action.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      maxChars: z.number().int().min(1_000).max(50_000).optional().default(8_000),
    },
  },
  async (input) => {
    const result = await callBridge("page.snapshot", input);
    // Hermes consumes the text content. Repeating a large snapshot again as
    // structuredContent can cross its spillover threshold, hiding the refs the
    // very next browser_act needs and wasting recovery turns.
    return asPanelText(compactPanelSnapshot(result, mcpSurface));
  },
);

const SNAPSHOT_BATCH_MAX_CHARS = 120_000;

tool(
  "browser_snapshot_batch",
  {
    title: "Snapshot several independent pages concurrently",
    description:
      "Capture 1-8 distinct Chrome tabs concurrently. Use after opening independent pages; failures remain per-tab and do not discard successful captures. The total visible-text budget is bounded.",
    inputSchema: {
      pages: z.array(z.object({
        tabId: z.number().int().nonnegative(),
        maxChars: z.number().int().min(1_000).max(30_000).optional().default(6_000),
      })).min(1).max(8),
    },
  },
  async (input) => {
    if (new Set(input.pages.map((page) => page.tabId)).size !== input.pages.length) {
      throw Object.assign(new Error("Browser snapshot batch cannot repeat a tab"), { code: "browser_snapshot_batch_invalid" });
    }
    if (input.pages.reduce((sum, page) => sum + page.maxChars, 0) > SNAPSHOT_BATCH_MAX_CHARS) {
      throw Object.assign(new Error("Browser snapshot batch exceeds the total character budget"), { code: "browser_snapshot_batch_invalid" });
    }
    const results = await Promise.all(input.pages.map(async (page) => {
      try {
        return { tab_id: page.tabId, status: "complete", snapshot: compactPanelSnapshot(await callBridge("page.snapshot", page), mcpSurface) };
      } catch (error) {
        return { tab_id: page.tabId, status: "error", error: { code: error?.code || "bridge_error", message: error?.message || String(error) } };
      }
    }));
    return asPanelText({ results });
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
      "Perform one atomic high-level action. Prefer a ref from the latest browser_snapshot. The extension enforces the side-panel browser-access mode and may hold this exact call for approval. Clicks run a complete CDP mouse sequence inside one request; press supports common navigation keys; select is for native <select> controls.",
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
      "Post a reply into the extension's side panel chat. Research updates are attached automatically. Optional links render as page cards under the reply; use pages you actually opened.",
    inputSchema: {
      text: z.string().min(1).max(20_000),
      agent: z.string().min(1).max(80).optional().describe("Identify as this agent before posting (first reply)."),
      links: z.array(z.object({
        url: z.string().url(),
        title: z.string().max(200).optional(),
        image: z.string().url().optional().describe("Thumbnail image URL shown on the card."),
        price: z.string().max(40).optional(),
      })).max(5).optional().describe("Optional page cards shown under the reply."),
    },
  },
  async (input) => {
    if (input.agent != null) await callBridge("panel.identify", { agent: input.agent });
    const links = (input.links ?? []).filter((link, index, all) => all.findIndex((item) => item.url === link.url) === index);
    return asText(await callBridge("panel.post", { text: input.text, links }));
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
      "Start a tab-scoped, metadata-only Chrome network monitor. Starting is sensitive and waits for one-time side-panel approval even when routine actions are allowed. Pass rawSessionId to reuse that Raw CDP attachment instead of attaching a second debugger. Headers and bodies are never returned.",
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
      "Attach an unrestricted Chrome DevTools Protocol session to one tab. Attachment is sensitive and waits for one-time side-panel approval even when routine actions are allowed. Set captureEvents=false when only commands plus a sanitized network projection are needed; captured Raw events may expose credentials and private data.",
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

await server.connect(new StdioServerTransport());
if (configuredPanelAgentName) {
  void syncConfiguredPanelIdentity();
  const identityTimer = setInterval(() => void syncConfiguredPanelIdentity(), 15_000);
  identityTimer.unref?.();
}
