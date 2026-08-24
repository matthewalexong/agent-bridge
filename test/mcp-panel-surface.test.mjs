import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PANEL_TOOL_NAMES } from "../mcp/surface.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("default MCP server advertises the compact panel surface only", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ab-panel-surface-"));
  context.after(() => fs.rm(bridgeDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(bridgeDir, "runtime.json"), JSON.stringify({
    schemaVersion: 1,
    host: "127.0.0.1",
    port: 9,
    token: "test-token",
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp", "server.mjs")],
    cwd: root,
    env: {
      PATH: process.env.PATH || "",
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "panel-surface-test", version: "1.0.0" });
  context.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...PANEL_TOOL_NAMES].sort());
  const advertised = JSON.stringify(tools);
  assert.ok(advertised.length < 25_000, `advertised catalog is ${advertised.length} chars`);
  const dossier = tools.find((tool) => tool.name === "shopping_decision_dossier");
  assert.ok(dossier, "dossier stays on the panel surface");
  assert.ok(JSON.stringify(dossier.inputSchema || {}).length < 2_000, "dossier schema must stay slim");
  for (const hidden of ["shopping_identity_resolve", "shopping_preference_rank", "shopping_product_evidence", "shopping_candidate_coverage", "shopping_offer_analyze"]) {
    assert.equal(tools.some((tool) => tool.name === hidden), false, `${hidden} must stay behind shopping_evaluator_batch`);
  }
  for (const hidden of ["browser_click", "browser_fill"]) assert.equal(tools.some((tool) => tool.name === hidden), false, `${hidden} must stay behind browser_act`);
});

test("live panel skill stays small and does not replace judgment with keywords", async () => {
  const skill = await fs.readFile(path.join(root, "eval/search/skills/agent-bridge-panel.md"), "utf8");
  assert.ok(skill.length < 4000, `skill is ${skill.length} chars`);
  assert.match(skill, /Do \*\*not\*\* `tool_describe`/);
  assert.match(skill, /Never `web_extract`/);
  assert.match(skill, /your judgment/);
  assert.match(skill, /Do not invent a keyword table/);
  assert.match(skill, /Never introduce yourself/);
  assert.match(skill, /research now/);
  assert.match(skill, /kind=products/);
  assert.match(skill, /one chat until the user clears/);
  assert.doesNotMatch(skill, /if query includes/i);
});
