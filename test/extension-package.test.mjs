import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release ZIP contains only the load-unpacked extension at archive root", async (context) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-package-test-"));
  context.after(() => fs.rm(output, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(root, "scripts/build-extension-zip.mjs"),
    "--out-dir",
    output,
  ]);
  const archive = stdout.trim();
  const { stdout: listing } = await execFileAsync("unzip", ["-Z1", archive]);
  const entries = listing.trim().split("\n").sort();
  assert.equal(entries.includes("manifest.json"), true);
  assert.equal(entries.includes("service-worker.js"), true);
  assert.equal(entries.includes("page-settle.js"), true);
  assert.equal(entries.includes("page-frames.js"), true);
  assert.equal(entries.includes("frame-scripts.js"), true);
  // The worker is an ES module: every file it imports must ship with it.
  const worker = await fs.readFile(path.join(root, "extension/service-worker.js"), "utf8");
  for (const [, imported] of worker.matchAll(/^import\s[^;]*?from\s+"\.\/([^"]+)";/gm)) {
    assert.equal(entries.includes(imported), true, `${imported} is imported by the service worker but not packaged`);
  }
  assert.equal(entries.includes("popup.html"), true);
  assert.equal(entries.includes("panel.html"), true);
  assert.equal(entries.includes("panel.css"), true);
  assert.equal(entries.includes("panel.js"), true);
  assert.equal(entries.some((entry) => /(^|\/)(node_modules|work|dist|\.git)(\/|$)/.test(entry)), false);
  assert.equal(entries.some((entry) => /\.(pem|env)$/i.test(entry)), false);
});
