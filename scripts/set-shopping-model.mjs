#!/usr/bin/env node
// Apply a shopping-only model preset to a dedicated Hermes profile.
// Desktop chat stays on grok-4.6. Panel traffic moves to the shopping profile
// webhook (default port 8645) only after this script writes the selection.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  loadShoppingModelCatalog,
  resolveShoppingPreset,
  selectionRecord,
  shoppingModelFile,
} from "../lib/shopping-model.mjs";

const args = process.argv.slice(2);
const catalog = loadShoppingModelCatalog();

function usage() {
  const names = Object.entries(catalog.presets).map(([name, preset]) => {
    const rec = name === catalog.recommended ? " (recommended)" : "";
    return `  ${name}${rec}  ${preset.provider}/${preset.model}  ${preset.tier}`;
  });
  console.log(`Usage:
  node scripts/set-shopping-model.mjs --list
  node scripts/set-shopping-model.mjs --disable
  node scripts/set-shopping-model.mjs <preset>

Presets:
${names.join("\n")}
`);
}

function hermes(profile, argv, { allowFail = false } = {}) {
  const result = spawnSync("hermes", ["-p", profile, ...argv], { encoding: "utf8" });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`hermes ${argv.join(" ")} failed: ${(result.stderr || result.stdout || "").trim().slice(0, 400)}`);
  }
  return result;
}

if (args.includes("-h") || args.includes("--help") || args.length === 0) {
  usage();
  process.exit(args.length === 0 ? 1 : 0);
}

if (args[0] === "--list") {
  for (const [name, preset] of Object.entries(catalog.presets)) {
    const rec = name === catalog.recommended ? " [recommended]" : "";
    const price = preset.approx_usd_per_million;
    console.log(`${name}${rec}
  ${preset.provider}/${preset.model}  ${preset.tier}  ~$${price.input}/$${price.output} per 1M
  needs ${preset.needs_env}
  ${preset.notes}
`);
  }
  process.exit(0);
}

if (args[0] === "--disable") {
  const path = shoppingModelFile();
  writeFileSync(path, `${JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }, null, 2)}\n`);
  console.log(`Disabled shopping-model override.
Panel webhook is back to the default Hermes profile (grok-4.6).
Wrote ${path}`);
  process.exit(0);
}

const preset = resolveShoppingPreset(args[0], catalog);
const required = process.env[preset.needs_env];
if (!required) {
  console.error(`Preset ${preset.name} needs ${preset.needs_env} in the environment.`);
  process.exit(2);
}

const profiles = spawnSync("hermes", ["profile", "list"], { encoding: "utf8" });
if (!String(profiles.stdout || "").includes(` ${preset.profile} `) && !String(profiles.stdout || "").includes(`\n  ${preset.profile} `)) {
  const created = spawnSync("hermes", [
    "profile", "create", preset.profile,
    "--clone",
    "--description", "Cheap Agent Bridge shopping panel. Isolated model, low reasoning, no desktop chat bleed.",
  ], { encoding: "utf8" });
  if (created.status !== 0) {
    console.error(`Could not create profile ${preset.profile}: ${(created.stderr || created.stdout || "").trim().slice(0, 400)}`);
    process.exit(1);
  }
}

hermes(preset.profile, ["config", "set", "model.provider", preset.provider]);
hermes(preset.profile, ["config", "set", "model.default", preset.model]);
hermes(preset.profile, ["config", "set", "agent.reasoning_effort", preset.reasoning_effort || "low"]);
hermes(preset.profile, ["config", "set", "agent.max_turns", String(preset.max_turns || 24)]);
hermes(preset.profile, ["config", "set", "memory.memory_enabled", "false"]);
hermes(preset.profile, ["config", "set", "memory.user_profile_enabled", "false"]);
hermes(preset.profile, ["config", "set", "platforms.webhook.enabled", "true"]);
hermes(preset.profile, ["config", "set", "platforms.webhook.extra.port", String(preset.webhook_port)]);
hermes(preset.profile, ["config", "set", "platforms.webhook.extra.host", "127.0.0.1"]);

const defaultSubs = join(homedir(), ".hermes", "webhook_subscriptions.json");
const profileSubs = join(homedir(), ".hermes", "profiles", preset.profile, "webhook_subscriptions.json");
try {
  const subs = JSON.parse(readFileSync(defaultSubs, "utf8"));
  mkdirSync(dirname(profileSubs), { recursive: true });
  writeFileSync(profileSubs, `${JSON.stringify(subs, null, 2)}\n`);
} catch (error) {
  console.error(`Warning: could not copy panel webhook subscription (${error.message})`);
}

const path = shoppingModelFile();
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify(selectionRecord(preset), null, 2)}\n`);

console.log(`Shopping panel model: ${preset.provider}/${preset.model} (${preset.name})
Profile: ${preset.profile}
Webhook: ${selectionRecord(preset).webhook_url}
Selection file: ${path}

Start or restart the shopping gateway from Terminal.app:
  hermes -p ${preset.profile} gateway install
  hermes -p ${preset.profile} gateway restart
Desktop chat stays on grok-4.6.`);
