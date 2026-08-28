import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXTENSION_ID, HOST_NAME } from "../lib/config.mjs";
import {
  formatDoctorReport,
  nativeHostManifestPath,
  runInstallationDoctor,
} from "../lib/installation-doctor.mjs";

async function writeFixtureFile(target, content = "fixture", mode = 0o600) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, { mode });
  await fs.chmod(target, mode);
}

test("installation doctor reports a healthy setup without exposing private state", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bridge-doctor-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "private-user-home");
  const projectRoot = path.join(temporary, "checkout");
  const bridgeRoot = path.join(home, ".chrome-agent-bridge");
  const chrome = path.join(temporary, "Google Chrome.app");
  const launcher = path.join(bridgeRoot, "native-host-launcher");
  const token = `cab_${Buffer.alloc(32, 9).toString("base64url")}`;
  const port = 43127;
  const required = [
    "package.json",
    "extension/manifest.json",
    "extension/panel.html",
    "native-host/host.mjs",
    "mcp/server.mjs",
    "skills/chrome-agent-control/SKILL.md",
  ];
  await Promise.all(required.map((relative) => writeFixtureFile(path.join(projectRoot, relative))));
  await fs.mkdir(chrome, { recursive: true });
  await writeFixtureFile(launcher, `#!/bin/sh\nexec '${process.execPath}' '${path.join(projectRoot, "native-host", "host.mjs")}'\n`, 0o700);
  await writeFixtureFile(path.join(bridgeRoot, "auth.json"), JSON.stringify({ schemaVersion: 1, token }), 0o600);
  await writeFixtureFile(path.join(bridgeRoot, "runtime.json"), JSON.stringify({ schemaVersion: 2, host: "127.0.0.1", port, pid: 9999 }), 0o600);
  const manifestTarget = nativeHostManifestPath({ platform: "darwin", home, env: {} });
  await writeFixtureFile(manifestTarget, JSON.stringify({
    name: HOST_NAME,
    type: "stdio",
    path: launcher,
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  }), 0o644);

  const fetchImpl = async (url, options) => {
    assert.equal(url, `http://127.0.0.1:${port}/rpc`);
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    return {
      ok: true,
      json: async () => ({ ok: true, result: { connected: true, extensionVersion: "0.9.0" } }),
    };
  };
  const report = await runInstallationDoctor({
    platform: "darwin",
    nodeVersion: "22.0.0",
    home,
    env: { CHROME_AGENT_BRIDGE_DIR: bridgeRoot },
    projectRoot,
    chromePaths: [chrome],
    fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { pass: 9, warn: 0, fail: 0 });
  const serialized = JSON.stringify(report);
  const human = formatDoctorReport(report);
  for (const privateValue of [token, home, launcher, String(port), "9999"]) {
    assert.equal(serialized.includes(privateValue), false);
    assert.equal(human.includes(privateValue), false);
  }
  assert.match(human, /9 passed/);
});

test("installation doctor gives ordered remediation without mutating a missing setup", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bridge-doctor-empty-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  let fetchCalled = false;
  const report = await runInstallationDoctor({
    platform: "linux",
    nodeVersion: "16.20.0",
    home: path.join(temporary, "home"),
    env: { CHROME_AGENT_BRIDGE_DIR: path.join(temporary, "bridge") },
    projectRoot: path.join(temporary, "checkout"),
    chromePaths: [path.join(temporary, "chrome")],
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("must not be called");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(fetchCalled, false);
  assert.equal(report.checks.find((check) => check.id === "chrome").status, "warn");
  assert.equal(report.checks.find((check) => check.id === "node").status, "fail");
  assert.equal(report.checks.find((check) => check.id === "connection").status, "fail");
  assert.equal((await fs.readdir(temporary)).sort().join(","), "");
});

test("native host manifest paths match supported Chrome locations", () => {
  assert.match(nativeHostManifestPath({ platform: "darwin", home: "/safe-home", env: {} }), /Library\/Application Support\/Google\/Chrome\/NativeMessagingHosts/);
  assert.equal(
    nativeHostManifestPath({ platform: "linux", home: "/safe-home", env: { XDG_CONFIG_HOME: "/safe-config" } }),
    `/safe-config/google-chrome/NativeMessagingHosts/${HOST_NAME}.json`,
  );
  assert.equal(nativeHostManifestPath({ platform: "win32", home: "C:\\safe", env: {} }), null);
});
