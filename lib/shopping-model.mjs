import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDirectory } from "./config.mjs";

const DEFAULT_WEBHOOK_URL = "http://127.0.0.1:8644/webhooks/panel_message";
const CATALOG_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "search", "live", "shopping-models.json");

export function shoppingModelFile(env = process.env) {
  return env.AB_SHOPPING_MODEL_FILE || join(bridgeDirectory(env), "shopping-model.json");
}

export function loadShoppingModelCatalog(path = CATALOG_FILE) {
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  if (!catalog?.presets || typeof catalog.presets !== "object") throw new Error("shopping model catalog is missing presets");
  return catalog;
}

export function resolveShoppingPreset(name, catalog = loadShoppingModelCatalog()) {
  const key = String(name || "").trim();
  const preset = catalog.presets[key];
  if (!preset) throw new Error(`Unknown shopping model preset: ${key || "(empty)"}. Try: ${Object.keys(catalog.presets).join(", ")}`);
  return { name: key, ...preset, profile: catalog.profile || "shopping", webhook_port: catalog.webhook_port || 8645 };
}

export function shoppingWebhookUrl(preset) {
  const port = Number(preset.webhook_port || 8645);
  return `http://127.0.0.1:${port}/webhooks/panel_message`;
}

export function activeShoppingSelection(raw) {
  if (!raw || raw.enabled === false) return null;
  if (!raw.preset || !raw.provider || !raw.model) return null;
  return raw;
}

export function resolvePanelWebhookUrl(env = process.env, { readFile = readFileSync } = {}) {
  if (env.AB_HERMES_WEBHOOK_URL) return env.AB_HERMES_WEBHOOK_URL;
  try {
    const selection = activeShoppingSelection(JSON.parse(readFile(shoppingModelFile(env), "utf8")));
    if (selection?.webhook_url) return selection.webhook_url;
  } catch {
    // Missing or invalid selection falls back to the default Hermes webhook.
  }
  return DEFAULT_WEBHOOK_URL;
}

export function resolvePanelGatewayLogFile(env = process.env, { readFile = readFileSync } = {}) {
  if (env.AB_GATEWAY_LOG_FILE) return env.AB_GATEWAY_LOG_FILE;
  try {
    const selection = activeShoppingSelection(JSON.parse(readFile(shoppingModelFile(env), "utf8")));
    if (selection?.profile) return join(hermesHomeForProfile(selection.profile, env), "logs", "gateway.log");
  } catch {
    // Missing or invalid selection uses the default Hermes profile log.
  }
  return join(hermesHomeForProfile("default", env), "logs", "gateway.log");
}

export function selectionRecord(preset) {
  return {
    enabled: true,
    preset: preset.name,
    profile: preset.profile,
    provider: preset.provider,
    model: preset.model,
    reasoning_effort: preset.reasoning_effort || "low",
    max_turns: preset.max_turns || 24,
    webhook_url: shoppingWebhookUrl(preset),
    updated_at: new Date().toISOString(),
  };
}

export function hermesHomeForProfile(profile, env = process.env) {
  const root = env.HERMES_HOME || join(homedir(), ".hermes");
  return profile && profile !== "default" ? join(root, "profiles", profile) : root;
}
