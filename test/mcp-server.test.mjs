import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server exposes the browser and analysis tool surface", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-bridge-test-"));
  context.after(() => fs.rm(bridgeDir, { recursive: true, force: true }));
  const testNow = new Date().toISOString();

  const snapshotText = new Map([
    [101, "Example Domain\nThis domain is for use in illustrative examples."],
    [102, "Second page\nMore information."],
  ]);
  const panelPosts = [];
  const panelIdentities = [];
  let panelAgent = null;
  const mockBridge = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const rpc = JSON.parse(body || "{}");
      const tabId = rpc.params?.tabId;
      const text = snapshotText.get(tabId);
      response.setHeader("content-type", "application/json");
      if (rpc.method === "browser.status") {
        response.statusCode = 503;
        response.end(JSON.stringify({ ok: false, error: { code: "bridge_offline", message: "Offline in status fixture" } }));
        return;
      }
      if (rpc.method === "panel.get") {
        response.end(JSON.stringify({ ok: true, result: { transcript: [], agent: panelAgent } }));
        return;
      }
      if (rpc.method === "panel.identify") {
        panelIdentities.push(rpc.params.agent);
        panelAgent = { name: rpc.params.agent, since: testNow };
        response.end(JSON.stringify({ ok: true, result: { identified: true, agent: panelAgent } }));
        return;
      }
      if (rpc.method === "panel.post") {
        panelPosts.push(rpc.params);
        response.end(JSON.stringify({ ok: true, result: { posted: true, entry: { id: `panel_${panelPosts.length}`, role: "agent", ...rpc.params } } }));
        return;
      }
      if (rpc.method !== "page.snapshot" || !text) {
        response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error: { code: "unsupported_test_rpc", message: "Unsupported mock bridge request" } }));
        return;
      }
      response.end(JSON.stringify({ ok: true, result: {
        snapshotId: `snapshot-${tabId}`,
        title: `Fixture ${tabId}`,
        url: `https://fixture.example/${tabId}`,
        text,
        truncated: false,
        elements: [{ ref: "e1", role: "link", name: `Fixture link ${tabId}`, href: `https://fixture.example/${tabId}/next` }],
      } }));
    });
  });
  await new Promise((resolve) => mockBridge.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => mockBridge.close(resolve)));
  await fs.writeFile(path.join(bridgeDir, "runtime.json"), JSON.stringify({
    schemaVersion: 1,
    host: "127.0.0.1",
    port: mockBridge.address().port,
    token: "test-token",
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp", "server.mjs")],
    cwd: root,
    env: {
      PATH: process.env.PATH || "",
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
      CHROME_AGENT_BRIDGE_AGENT_NAME: "DeepSeek Harness",
      AB_MCP_SURFACE: "full",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "chrome-agent-bridge-test", version: "1.0.0" });
  context.after(() => client.close());
  await client.connect(transport);
  for (let attempt = 0; attempt < 20 && panelAgent == null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(panelAgent?.name, "DeepSeek Harness", "configured harness identity is declared when the bridge becomes available");

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "analysis_ast_match",
      "analysis_data_flow",
      "analysis_decode_string_array",
      "analysis_deflat_control_flow",
      "analysis_security_scan",
      "ast_transform_apply",
      "ast_transform_chain",
      "ast_transform_preview",
      "binary_decode",
      "binary_detect_format",
      "binary_encode",
      "binary_entropy_analysis",
      "blackbox_add",
      "blackbox_add_common",
      "blackbox_list",
      "breakpoint",
      "browser_act",
      "browser_activate_tab",
      "browser_cdp_attach",
      "browser_cdp_detach",
      "browser_cdp_events",
      "browser_cdp_send",
      "browser_click",
      "browser_close_tab",
      "browser_fill",
      "browser_list_tabs",
      "browser_navigate",
      "browser_network_poll",
      "browser_network_start",
      "browser_network_stop",
      "browser_open_tab",
      "browser_panel_identify",
      "browser_panel_post",
      "browser_panel_read",
      "browser_panel_status",
      "browser_screenshot",
      "browser_snapshot",
      "browser_snapshot_batch",
      "browser_status",
      "browser_watch_events",
      "collect_code",
      "console_get_exceptions",
      "crypto_compare",
      "crypto_test_harness",
      "debugger_capture_hit",
      "debugger_disassemble",
      "debugger_evaluate",
      "debugger_get_paused_state",
      "debugger_lifecycle",
      "debugger_pause",
      "debugger_resume",
      "debugger_run_to_location",
      "debugger_session",
      "debugger_step",
      "debugger_wait_for_paused",
      "detect_crypto",
      "detect_obfuscation",
      "extract_function_tree",
      "get_call_stack",
      "get_object_properties",
      "get_scope_variables_enhanced",
      "grpc_frame_build",
      "grpc_frame_parse",
      "http2_frame_parse",
      "js_deobfuscate_pipeline",
      "js_solve_constraints",
      "network_export_har",
      "network_extract_auth",
      "network_get_response_body",
      "network_get_stats",
      "network_http2_fingerprint",
      "network_intercept",
      "performance_coverage",
      "performance_get_metrics",
      "performance_take_heap_snapshot",
      "performance_trace",
      "profiler_cpu",
      "profiler_heap_sampling",
      "proto_auto_detect",
      "proto_dissect_dns",
      "proto_dissect_http",
      "proto_export_schema",
      "proto_fingerprint",
      "proto_infer_fields",
      "proto_infer_state_machine",
      "proto_visualize_state",
      "protobuf_decode_raw",
      "search_in_scripts",
      "sourcemap_coverage",
      "sourcemap_diff",
      "sourcemap_discover",
      "sourcemap_fetch_and_parse",
      "sourcemap_lookup",
      "sourcemap_parse_v4",
      "sourcemap_reconstruct_tree",
      "transform_workbench",
      "understand_code",
      "wasm_inspect",
      "wasm_string_extract",
      "watch",
      "webpack_enumerate",
    ],
  );

  const networkStart = tools.find((tool) => tool.name === "browser_network_start");
  assert.equal(networkStart.inputSchema.properties.rawSessionId.type, "string");
  assert.equal(networkStart.inputSchema.properties.urlMode.default, "origin_path");
  assert.deepEqual(networkStart.inputSchema.properties.urlMode.enum, ["origin_path", "full"]);

  const rawAttach = tools.find((tool) => tool.name === "browser_cdp_attach");
  assert.equal(rawAttach.inputSchema.properties.captureEvents.default, true);
  assert.equal(rawAttach.inputSchema.properties.maxBytes.maximum, 64 * 1024 * 1024);

  const pageAct = tools.find((tool) => tool.name === "browser_act");
  assert.deepEqual(pageAct.inputSchema.properties.kind.enum, ["click", "fill", "press", "select"]);
  assert.equal(pageAct.inputSchema.properties.ref.pattern, "^(?:f[1-9]\\d*)?e\\d+$");

  const navigate = tools.find((tool) => tool.name === "browser_navigate");
  for (const settleTool of [navigate, pageAct]) {
    assert.deepEqual(settleTool.inputSchema.properties.waitUntil.enum, ["none", "load", "settled"]);
    assert.equal(settleTool.inputSchema.properties.timeoutMs.maximum, 20_000);
    assert.equal(settleTool.inputSchema.required.includes("waitUntil"), false, "existing callers omit waitUntil");
    assert.equal(settleTool.inputSchema.required.includes("timeoutMs"), false, "existing callers omit timeoutMs");
  }

  const panelStatus = tools.find((tool) => tool.name === "browser_panel_status");
  assert.equal(panelStatus.inputSchema.properties.summary.maxLength, 1000);
  assert.equal(panelStatus.inputSchema.properties.text.maxLength, 1000);
  assert.equal(panelStatus.inputSchema.required?.includes("summary") ?? false, false);
  assert.deepEqual(panelStatus.inputSchema.properties.phase.enum, ["plan", "search", "inspect", "verify", "compare", "decision", "working"]);
  assert.equal(panelStatus.inputSchema.properties.evidence.maxItems, 5);
  assert.equal(panelStatus.inputSchema.properties.evidence.items.maxLength, 160);
  assert.equal(panelStatus.inputSchema.properties.next.maxLength, 200);

  const panelPost = tools.find((tool) => tool.name === "browser_panel_post");
  assert.deepEqual(Object.keys(panelPost.inputSchema.properties).sort(), ["agent", "links", "text"]);
  assert.deepEqual(panelPost.inputSchema.required, ["text"]);
  assert.equal(panelPost.inputSchema.properties.links.maxItems, 5);

  const collectCode = tools.find((tool) => tool.name === "collect_code");
  assert.equal(collectCode.inputSchema.required.includes("sessionId"), true);
  assert.equal(collectCode.inputSchema.properties.includeSource.default, true);

  const authExtract = tools.find((tool) => tool.name === "network_extract_auth");
  assert.equal(authExtract.inputSchema.properties.confirmed.default, false);

  const astPreview = tools.find((tool) => tool.name === "ast_transform_preview");
  assert.deepEqual(astPreview.inputSchema.properties.transforms.items.enum, [
    "constant_fold",
    "dead_code_remove",
    "decode_string_array",
    "deflat_control_flow",
    "strip_debugger",
    "unescape_strings",
  ]);

  const snapshot = await client.callTool({ name: "browser_snapshot", arguments: { tabId: 101 } });
  assert.equal(snapshot.isError, undefined, JSON.stringify(snapshot));
  assert.equal(snapshot.structuredContent.snapshotId, "snapshot-101");
  assert.equal(snapshot.structuredContent.text, snapshotText.get(101));
  assert.equal(snapshot.structuredContent.elements[0].ref, "e1");
  assert.equal("evidence_receipt" in snapshot.structuredContent, false);

  const snapshotBatch = await client.callTool({ name: "browser_snapshot_batch", arguments: { pages: [{ tabId: 101 }, { tabId: 102 }, { tabId: 999 }] } });
  assert.equal(snapshotBatch.isError, undefined, JSON.stringify(snapshotBatch));
  assert.deepEqual(snapshotBatch.structuredContent.results.map((item) => [item.tab_id, item.status]), [[101, "complete"], [102, "complete"], [999, "error"]]);
  assert.deepEqual(snapshotBatch.structuredContent.results.slice(0, 2).map((item) => item.snapshot.snapshotId), ["snapshot-101", "snapshot-102"]);
  assert.equal(snapshotBatch.structuredContent.results[2].error.code, "unsupported_test_rpc");

  const repeatedBatch = await client.callTool({ name: "browser_snapshot_batch", arguments: { pages: [{ tabId: 101 }, { tabId: 101 }] } });
  assert.equal(repeatedBatch.isError, true);
  assert.match(repeatedBatch.content[0].text, /browser_snapshot_batch_invalid/);

  const oversizedBatch = await client.callTool({ name: "browser_snapshot_batch", arguments: { pages: [101, 102, 103, 104, 105].map((tabId) => ({ tabId, maxChars: 30_000 })) } });
  assert.equal(oversizedBatch.isError, true);
  assert.match(oversizedBatch.content[0].text, /total character budget/);

  const post = await client.callTool({ name: "browser_panel_post", arguments: {
    text: "Here are the pages I opened.",
    agent: "Test Agent",
    links: [
      { url: "https://fixture.example/101", title: "Fixture 101" },
      { url: "https://fixture.example/101", title: "Duplicate" },
      { url: "https://fixture.example/102" },
    ],
  } });
  assert.equal(post.isError, undefined, JSON.stringify(post));
  assert.equal(panelIdentities.at(-1), "Test Agent");
  assert.deepEqual(panelPosts.at(-1), {
    text: "Here are the pages I opened.",
    links: [{ url: "https://fixture.example/101", title: "Fixture 101" }, { url: "https://fixture.example/102" }],
  });

  const plainPost = await client.callTool({ name: "browser_panel_post", arguments: { text: "Done." } });
  assert.equal(plainPost.isError, undefined, JSON.stringify(plainPost));
  assert.deepEqual(panelPosts.at(-1), { text: "Done.", links: [] });

  const status = await client.callTool({ name: "browser_status", arguments: {} });
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /bridge_offline/);

  const authWithoutConfirmation = await client.callTool({
    name: "network_extract_auth",
    arguments: { sessionId: "raw_12345678901234567890" },
  });
  assert.equal(authWithoutConfirmation.isError, true);
  assert.match(authWithoutConfirmation.content[0].text, /confirmation_required/);
});
