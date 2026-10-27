import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolvePanelGatewayLogFile, resolvePanelWebhookUrl } from "../lib/panel-webhook.mjs";

test("panel webhook uses the default Hermes webhook unless overridden", () => {
  assert.equal(resolvePanelWebhookUrl({}), "http://127.0.0.1:8644/webhooks/panel_message");
  assert.equal(
    resolvePanelWebhookUrl({ AB_HERMES_WEBHOOK_URL: "http://127.0.0.1:9/webhooks/panel_message" }),
    "http://127.0.0.1:9/webhooks/panel_message",
  );
});

test("panel gateway log follows HERMES_HOME unless overridden", () => {
  const hermesHome = path.join("hermes-home");
  assert.equal(resolvePanelGatewayLogFile({ HERMES_HOME: hermesHome }), path.join(hermesHome, "logs", "gateway.log"));
  assert.equal(resolvePanelGatewayLogFile({ HERMES_HOME: hermesHome, AB_GATEWAY_LOG_FILE: "custom.log" }), "custom.log");
});
