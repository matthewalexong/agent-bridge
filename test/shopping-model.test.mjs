import assert from "node:assert/strict";
import test from "node:test";
import {
  loadShoppingModelCatalog,
  resolvePanelWebhookUrl,
  resolveShoppingPreset,
  selectionRecord,
} from "../lib/shopping-model.mjs";

test("shopping catalog recommends the current balanced Token Plan model", () => {
  const catalog = loadShoppingModelCatalog();
  assert.equal(catalog.recommended, "qwen-plus");
  assert.ok(catalog.presets["grok-4.3"]);
  assert.ok(catalog.presets["qwen-plus"]);
  assert.ok(catalog.presets["deepseek-v4-pro"]);
  assert.equal(catalog.presets["grok-4.3"].needs_env, "XAI_API_KEY");
  assert.equal(catalog.presets["qwen-flash"].provider, "alibaba");
  assert.equal(catalog.presets["qwen-plus"].model, "qwen3.7-plus");
  assert.equal(catalog.presets["qwen-plus"].base_url, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
  assert.equal(catalog.presets["qwen-plus"].billing, "token-plan-credits");
  assert.equal(catalog.presets["qwen-flash"].model, "qwen3.6-flash");
  assert.equal(catalog.presets["deepseek-v4-flash"].needs_env, "DEEPSEEK_API_KEY");
  assert.equal(catalog.presets["deepseek-v4-pro"].vision, false);
  assert.equal(catalog.presets["deepseek-v4-flash-vision"].vision, true);
  assert.equal(catalog.presets["grok-4.3"].vision, true);
  assert.equal(catalog.presets["qwen-plus"].vision, true);
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
