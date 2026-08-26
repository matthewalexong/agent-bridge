import assert from "node:assert/strict";
import test from "node:test";
import {
  loadShoppingModelCatalog,
  resolvePanelGatewayLogFile,
  resolvePanelWebhookUrl,
  resolveShoppingPreset,
  selectionRecord,
} from "../lib/shopping-model.mjs";

test("shopping catalog recommends the stronger Token Plan planning model", () => {
  const catalog = loadShoppingModelCatalog();
  assert.equal(catalog.recommended, "qwen-max");
  assert.ok(catalog.presets["grok-4.3"]);
  assert.ok(catalog.presets["qwen-plus"]);
  assert.ok(catalog.presets["qwen-max"]);
  assert.ok(catalog.presets["deepseek-v4-pro"]);
  assert.equal(catalog.presets["grok-4.3"].needs_env, "XAI_API_KEY");
  assert.equal(catalog.presets["qwen-flash"].provider, "alibaba");
  assert.equal(catalog.presets["qwen-plus"].model, "qwen3.7-plus");
  assert.equal(catalog.presets["qwen-max"].model, "qwen3.8-max");
  assert.equal(catalog.presets["qwen-max"].max_turns, 28);
  assert.equal(catalog.presets["qwen-plus"].base_url, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
  assert.equal(catalog.presets["qwen-plus"].billing, "token-plan-credits");
  assert.equal(catalog.presets["qwen-flash"].model, "qwen3.6-flash");
  assert.equal(catalog.presets["deepseek-v4-flash"].needs_env, "DEEPSEEK_API_KEY");
  assert.equal(catalog.presets["deepseek-v4-pro"].vision, false);
  assert.equal(catalog.presets["deepseek-v4-flash-vision"].vision, true);
  assert.equal(catalog.presets["grok-4.3"].vision, true);
  assert.equal(catalog.presets["qwen-plus"].vision, true);
});

test("shopping gateway status tail follows the selected profile log", () => {
  const env = { HERMES_HOME: "/Users/example/.hermes", AB_SHOPPING_MODEL_FILE: "/tmp/selection.json" };
  const readFile = () => JSON.stringify({ enabled: true, preset: "qwen-max", profile: "shopping", provider: "alibaba", model: "qwen3.8-max" });
  assert.equal(resolvePanelGatewayLogFile(env, { readFile }), "/Users/example/.hermes/profiles/shopping/logs/gateway.log");
  assert.equal(resolvePanelGatewayLogFile({ ...env, AB_GATEWAY_LOG_FILE: "/tmp/custom.log" }, { readFile }), "/tmp/custom.log");
});

test("unknown shopping preset fails closed", () => {
  assert.throws(() => resolveShoppingPreset("not-a-model"), /Unknown shopping model preset/);
});

test("panel webhook stays on default unless a shopping selection is enabled", () => {
  const isolated = { AB_SHOPPING_MODEL_FILE: "/tmp/missing-shopping-model.json" };
  assert.equal(resolvePanelWebhookUrl(isolated), "http://127.0.0.1:8644/webhooks/panel_message");
  assert.equal(
    resolvePanelWebhookUrl({ ...isolated, AB_HERMES_WEBHOOK_URL: "http://127.0.0.1:9/webhooks/panel_message" }),
    "http://127.0.0.1:9/webhooks/panel_message",
  );
  const preset = resolveShoppingPreset("grok-4.3");
  const record = selectionRecord(preset);
  assert.equal(record.webhook_url, "http://127.0.0.1:8645/webhooks/panel_message");
});
