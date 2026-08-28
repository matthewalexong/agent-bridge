import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME } from "./config.mjs";
import { TOKEN_PATTERN } from "./auth-token.mjs";

export const MINIMUM_NODE_MAJOR = 18;

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function result(id, status, summary, action) {
  return { id, status, summary, ...(action ? { action } : {}) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function regularFile(file, fileSystem) {
  try {
    const stat = await fileSystem.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

export function nativeHostManifestPath({ platform, home, env = {} }) {
  if (platform === "darwin") {
    return path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts", `${HOST_NAME}.json`);
  }
  if (platform === "linux") {
    return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "google-chrome/NativeMessagingHosts", `${HOST_NAME}.json`);
  }
  return null;
}

export function defaultChromePaths({ platform, home }) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app",
      path.join(home, "Applications/Google Chrome.app"),
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/snap/bin/chromium",
    ];
  }
  return [];
}

async function anyPathExists(paths, fileSystem) {
  for (const candidate of paths) {
    try {
      await fileSystem.access(candidate);
      return true;
    } catch {
      // Try the next known installation location.
    }
  }
  return false;
}

function validateManifest(value, expectedLauncher) {
  return (
    value?.name === HOST_NAME &&
    value?.type === "stdio" &&
    value?.path === expectedLauncher &&
    Array.isArray(value?.allowed_origins) &&
    value.allowed_origins.includes(`chrome-extension://${EXTENSION_ID}/`)
  );
}

function validateAuth(value) {
  return value?.schemaVersion === 1 && TOKEN_PATTERN.test(value?.token || "");
}

function validateRuntime(value) {
  return (
    [1, 2].includes(value?.schemaVersion) &&
    value?.host === "127.0.0.1" &&
    Number.isInteger(value?.port) &&
    value.port >= 1 &&
    value.port <= 65535
  );
}

async function bridgeStatus({ runtime, token, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "browser.status", params: {} }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true || payload?.result?.connected !== true) return null;
    return payload.result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runInstallationDoctor(options = {}) {
  const platform = options.platform || process.platform;
  const nodeVersion = options.nodeVersion || process.versions.node;
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const projectRoot = options.projectRoot || defaultRoot;
  const fileSystem = options.fileSystem || fs;
  const fetchImpl = options.fetchImpl || fetch;
  const checks = [];

  if (["darwin", "linux"].includes(platform)) {
    checks.push(result("platform", "pass", platform === "darwin" ? "Supported macOS host." : "Supported Linux host."));
  } else {
    checks.push(result("platform", "fail", "This operating system is not supported yet.", "Use macOS or Linux; Windows support is tracked publicly."));
  }

  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  if (Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR) {
    checks.push(result("node", "pass", `Node.js ${nodeMajor} satisfies the Node.js ${MINIMUM_NODE_MAJOR}+ requirement.`));
  } else {
    checks.push(result("node", "fail", `Node.js ${MINIMUM_NODE_MAJOR} or newer is required.`, "Install a supported Node.js release, then run npm ci again."));
  }

  const requiredProjectFiles = [
    "package.json",
    "extension/manifest.json",
    "extension/panel.html",
    "native-host/host.mjs",
    "mcp/server.mjs",
    "skills/chrome-agent-control/SKILL.md",
  ];
  const projectFilesPresent = (await Promise.all(
    requiredProjectFiles.map((relative) => regularFile(path.join(projectRoot, relative), fileSystem)),
  )).every(Boolean);
  checks.push(projectFilesPresent
    ? result("checkout", "pass", "The checkout contains the extension, host, MCP server, and paired Skill.")
    : result("checkout", "fail", "The checkout is incomplete.", "Clone the complete repository and run the doctor from its root."));

  const chromePaths = options.chromePaths || defaultChromePaths({ platform, home });
  checks.push(await anyPathExists(chromePaths, fileSystem)
    ? result("chrome", "pass", "A supported Chrome installation was found.")
    : result("chrome", "warn", "Google Chrome was not found in a standard location.", "Install Google Chrome or confirm that your custom installation can load unpacked extensions."));

  const bridgeRoot = path.resolve(env.CHROME_AGENT_BRIDGE_DIR || path.join(home, ".chrome-agent-bridge"));
  const expectedLauncher = path.join(bridgeRoot, "native-host-launcher");
  const manifestTarget = nativeHostManifestPath({ platform, home, env });
  let manifest = null;
  if (manifestTarget) {
    const manifestStat = await regularFile(manifestTarget, fileSystem);
    if (manifestStat) manifest = safeJson(await fileSystem.readFile(manifestTarget, "utf8").catch(() => ""));
  }
  checks.push(validateManifest(manifest, expectedLauncher)
    ? result("native-host-manifest", "pass", "The Chrome Native Messaging manifest is installed for the stable extension ID.")
    : result("native-host-manifest", "fail", "The Chrome Native Messaging manifest is missing or invalid.", "Run npm run install-host, then reload Agent Bridge on chrome://extensions."));

  const launcherStat = manifest?.path === expectedLauncher ? await regularFile(expectedLauncher, fileSystem) : null;
  const launcherContent = launcherStat ? await fileSystem.readFile(expectedLauncher, "utf8").catch(() => "") : "";
  const launcherExecutable = launcherStat && (platform === "win32" || (launcherStat.mode & 0o111) !== 0);
  const launcherCurrent = launcherContent.includes(process.execPath) && launcherContent.includes(path.join(projectRoot, "native-host", "host.mjs"));
  checks.push(launcherExecutable && launcherCurrent
    ? result("native-host-launcher", "pass", "The private native-host launcher is executable and points to this checkout.")
    : result("native-host-launcher", "fail", "The native-host launcher is missing, unsafe, or points somewhere else.", "Run npm run install-host again from the permanent checkout location."));

  const authTarget = path.join(bridgeRoot, "auth.json");
  const authStat = await regularFile(authTarget, fileSystem);
  const auth = authStat ? safeJson(await fileSystem.readFile(authTarget, "utf8").catch(() => "")) : null;
  const privateAuthMode = platform === "win32" || (authStat && (authStat.mode & 0o077) === 0);
  checks.push(validateAuth(auth) && privateAuthMode
    ? result("pairing", "pass", "The local pairing credential exists and has private permissions.")
    : result("pairing", "fail", "The local pairing credential is missing, invalid, or not private.", "Reload the extension after installing the host. If needed, open the Agent Bridge popup and renew pairing."));

  const runtimeTarget = path.join(bridgeRoot, "runtime.json");
  const runtimeStat = await regularFile(runtimeTarget, fileSystem);
  const runtime = runtimeStat ? safeJson(await fileSystem.readFile(runtimeTarget, "utf8").catch(() => "")) : null;
  checks.push(validateRuntime(runtime)
    ? result("runtime", "pass", "The native host published a valid local runtime record.")
    : result("runtime", "fail", "No valid running native host was found.", "Reload Agent Bridge on chrome://extensions and keep Chrome open."));

  const token = runtime?.schemaVersion === 1 && TOKEN_PATTERN.test(runtime?.token || "")
    ? runtime.token
    : validateAuth(auth) ? auth.token : null;
  const live = validateRuntime(runtime) && token
    ? await bridgeStatus({ runtime, token, fetchImpl, timeoutMs: options.timeoutMs || 2_000 })
    : null;
  const liveVersion = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(live?.extensionVersion || "")
    ? live.extensionVersion
    : "unknown";
  checks.push(live
    ? result("connection", "pass", `The authenticated bridge answered from extension v${liveVersion}.`)
    : result("connection", "fail", "The extension did not answer through the authenticated bridge.", "Open Chrome, reload Agent Bridge, then rerun npm run doctor."));

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.status] += 1;
  return {
    schemaVersion: 1,
    ok: counts.fail === 0,
    counts,
    checks,
    privacy: "No pairing token, private browser content, absolute home path, runtime port, or process ID is included.",
  };
}

export function formatDoctorReport(report) {
  const symbols = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = ["Agent Bridge installation doctor", ""];
  for (const check of report.checks) {
    lines.push(`[${symbols[check.status]}] ${check.summary}`);
    if (check.action) lines.push(`       Next: ${check.action}`);
  }
  lines.push("", `${report.counts.pass} passed, ${report.counts.warn} warning(s), ${report.counts.fail} failed.`);
  lines.push(report.ok ? "Agent Bridge is ready for a first browser_status check." : "Resolve the failed checks from top to bottom, then run the doctor again.");
  lines.push("This report intentionally omits credentials and private browser state.");
  return `${lines.join("\n")}\n`;
}
