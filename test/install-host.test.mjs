import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("host installer dry-run emits a valid native host manifest", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(root, "scripts", "install-host.mjs"),
      "--dry-run",
    ],
  );
  const result = JSON.parse(stdout);
  assert.equal(result.manifest.type, "stdio");
  assert.equal(result.manifest.name, "com.escape_wu.chrome_agent_bridge");
  assert.deepEqual(result.manifest.allowed_origins, [
    "chrome-extension://hkedmoboloodflgcaidimhddljdnndcd/",
  ]);
  assert.ok(path.isAbsolute(result.manifest.path));
  assert.ok(path.isAbsolute(result.nodePath));
  assert.ok(path.isAbsolute(result.hostModulePath));
  assert.equal(result.harnessWebhookUrl, "http://127.0.0.1:3080/panel-webhook");
  assert.equal(result.harnessSessionCwd, path.join(path.dirname(root), "panel"));
  assert.match(result.manifest.path, /native-host-launcher$/);
});

test("host installer accepts provider-neutral harness routing overrides", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(root, "scripts", "install-host.mjs"),
    "--dry-run",
    "--harness-webhook-url", "http://127.0.0.1:9000/panel",
    "--harness-session-cwd", "/tmp/agent-bridge-project",
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.harnessWebhookUrl, "http://127.0.0.1:9000/panel");
  assert.equal(result.harnessSessionCwd, "/tmp/agent-bridge-project");
});
