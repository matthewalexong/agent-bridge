#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { bridgeDirectory, EXTENSION_ID, HOST_NAME } from "../lib/config.mjs";

function parseArgs(argv) {
  const result = { dryRun: false, extensionId: EXTENSION_ID, harnessWebhookUrl: null, harnessSessionCwd: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--extension-id") result.extensionId = argv[++index];
    else if (arg === "--harness-webhook-url") result.harnessWebhookUrl = argv[++index];
    else if (arg === "--harness-session-cwd") result.harnessSessionCwd = argv[++index];
    else if (arg === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[a-p]{32}$/.test(result.extensionId)) {
    throw new Error("Pass a valid Chrome extension ID with --extension-id <32 characters a-p>");
  }
  if (result.harnessWebhookUrl != null) {
    const url = new URL(result.harnessWebhookUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("--harness-webhook-url must be a loopback HTTP URL");
    }
  }
  return result;
}

function manifestPath() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    );
  }
  if (process.platform === "linux") {
    return path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "google-chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    );
  }
  throw new Error("The installer currently supports macOS and Linux. Windows support is not yet implemented.");
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostModulePath = path.join(projectRoot, "native-host", "host.mjs");
const harnessWebhookUrl = args.harnessWebhookUrl
  || process.env.AB_HARNESS_WEBHOOK_URL
  || process.env.AB_HERMES_WEBHOOK_URL
  || "http://127.0.0.1:3080/panel-webhook";
const harnessSessionCwd = path.resolve(
  args.harnessSessionCwd
    || process.env.AB_HARNESS_SESSION_CWD
    || path.join(path.dirname(projectRoot), "panel"),
);
const hostPath = path.join(bridgeDirectory(), "native-host-launcher");
const target = manifestPath();
const manifest = {
  name: HOST_NAME,
  description: "Agent Bridge native messaging host",
  path: hostPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${args.extensionId}/`],
};

if (args.dryRun) {
  process.stdout.write(
    `${JSON.stringify({ target, manifest, nodePath: process.execPath, hostModulePath, harnessWebhookUrl, harnessSessionCwd }, null, 2)}\n`,
  );
} else {
  const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const launcher = [
    "#!/bin/sh",
    "set -eu",
    `export AB_HARNESS_WEBHOOK_URL=${shellQuote(harnessWebhookUrl)}`,
    `export AB_HARNESS_SESSION_CWD=${shellQuote(harnessSessionCwd)}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(hostModulePath)}`,
    "",
  ].join("\n");
  await fs.mkdir(path.dirname(hostPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(hostPath, launcher, { mode: 0o700 });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`Installed native host manifest: ${target}\n`);
  process.stdout.write("Reload the Chrome extension to connect.\n");
}
