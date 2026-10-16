import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BridgeOfflineError, callBridge as defaultCallBridge } from "./bridge-client.mjs";

const execFileAsync = promisify(execFile);

export const CHROME_APP_NAME = "Google Chrome";

// Chrome starts the extension's service worker, which calls connectNative()
// on startup and spawns the native host. Opening the app is therefore enough
// to bring the bridge back; no click is needed in the normal case.
export async function launchChromeApp({ platform = process.platform } = {}) {
  if (platform !== "darwin") {
    const error = new Error("Opening Chrome is only implemented on macOS");
    error.code = "unsupported_platform";
    throw error;
  }
  await execFileAsync("open", ["-a", CHROME_APP_NAME], { timeout: 10_000 });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isOffline(error) {
  return error instanceof BridgeOfflineError || error?.code === "bridge_offline";
}

export async function ensureBridgeConnected({
  callBridge = defaultCallBridge,
  launch = () => launchChromeApp(),
  sleep = delay,
  now = Date.now,
  timeoutMs = 30_000,
  pollMs = 1_000,
} = {}) {
  try {
    const status = await callBridge("browser.status");
    return { connected: true, launched: false, waitedMs: 0, status };
  } catch (error) {
    // Only an offline bridge justifies opening Chrome. Auth or protocol
    // failures are reported as they are, not papered over with a relaunch.
    if (!isOffline(error)) throw error;
  }

  await launch();

  const started = now();
  let lastError = null;
  while (now() - started < timeoutMs) {
    await sleep(pollMs);
    try {
      const status = await callBridge("browser.status");
      return { connected: true, launched: true, waitedMs: now() - started, status };
    } catch (error) {
      lastError = error?.message ?? String(error);
    }
  }
  return { connected: false, launched: true, waitedMs: now() - started, lastError };
}
