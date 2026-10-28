import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_WEBHOOK_URL = "http://127.0.0.1:8644/webhooks/panel_message";

export function resolvePanelWebhookUrl(env = process.env) {
  return env.AB_HERMES_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
}

export function resolvePanelGatewayLogFile(env = process.env) {
  if (env.AB_GATEWAY_LOG_FILE) return env.AB_GATEWAY_LOG_FILE;
  return join(env.HERMES_HOME || join(homedir(), ".hermes"), "logs", "gateway.log");
}
