import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryUrl = "https://github.com/matthewalexong/agent-bridge";

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
}

test("public metadata presents the domain-neutral Agent Bridge identity", async () => {
  const [packageJson, plugin, extension, mcp, readme] = await Promise.all([
    readJson("package.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson("extension/manifest.json"),
    readJson(".mcp.json"),
    fs.readFile(path.join(root, "README.md"), "utf8"),
  ]);

  assert.equal(packageJson.name, "agent-bridge");
  assert.equal(packageJson.homepage, `${repositoryUrl}#readme`);
  assert.equal(plugin.interface.displayName, "Agent Bridge");
  assert.equal(plugin.repository, repositoryUrl);
  assert.equal(extension.name, "Agent Bridge");
  assert.equal(mcp.mcpServers["chrome-agent-bridge"].title, "Agent Bridge");
  assert.match(readme, /^# Agent Bridge$/m);
  assert.match(readme, /Let AI agents work through your real Chrome browser\./);
  assert.match(readme, /Shopping is the first flagship capability/i);
});

test("lineage is explicit while compatibility identifiers remain stable", async () => {
  const [license, notice, mcp, config] = await Promise.all([
    fs.readFile(path.join(root, "LICENSE"), "utf8"),
    fs.readFile(path.join(root, "NOTICE.md"), "utf8"),
    readJson(".mcp.json"),
    fs.readFile(path.join(root, "lib/config.mjs"), "utf8"),
  ]);

  assert.match(license, /Copyright \(c\) 2026 梧桐/);
  assert.match(notice, /Chrome Agent Bridge/);
  assert.match(notice, /escapeWu/);
  assert.ok(mcp.mcpServers["chrome-agent-bridge"]);
  assert.match(config, /chrome-agent-bridge/);
});
