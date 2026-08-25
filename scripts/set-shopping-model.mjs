#!/usr/bin/env node
// Apply a shopping-only model preset to a dedicated Hermes profile.
// The default Hermes profile is left untouched. Panel traffic moves to the
// shopping profile webhook (default port 8645) after this writes the selection.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function hardenShoppingProfile(profile) {
  hermes(profile, ["config", "set", "onboarding.profile_build", "off"]);
  hermes(profile, ["config", "set", "display.busy_input_mode", "queue"]);
  const home = join(homedir(), ".hermes", "profiles", profile);
  writeFileSync(join(home, "SOUL.md"), [
    "You are a silent shopper in a Chrome side panel.",
    "Never introduce yourself. Never mention Hermes, /help, skills, tools, or a profile.",
    "If they want a product, price, build, or recommendation, research live listings now.",
    "Ask at most one product-specific question, and only if it would change what to buy.",
    "Then post the answer. Do not explain how you work.",
    "",
  ].join("\n"));
  const skillsRoot = join(home, "skills");
  const keep = join(skillsRoot, "agent-bridge-panel");
  try {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      const target = join(skillsRoot, entry.name);
      if (target !== keep) rmSync(target, { recursive: true, force: true });
    }
  } catch {
    mkdirSync(skillsRoot, { recursive: true });
  }
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "search", "skills", "agent-bridge-panel.md");
  mkdirSync(join(keep), { recursive: true });
  cpSync(src, join(keep, "SKILL.md"));
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
    const cost = preset.billing === "token-plan-credits"
      ? "Token Plan Credits (usage-dependent)"
      : `~$${price.input}/$${price.output} per 1M`;
    console.log(`${name}${rec}
  ${preset.provider}/${preset.model}  ${preset.tier}  ${cost}
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

const pooled = hermes(preset.profile, ["auth", "list", preset.provider], { allowFail: true });
const hasPooledCredential = /\b\d+ credentials?\b|^\s*#\d+/m.test(String(pooled.stdout || ""));
if (!process.env[preset.needs_env] && !hasPooledCredential) {
  console.error(`Preset ${preset.name} needs ${preset.needs_env} or a pooled ${preset.provider} credential.`);
  process.exit(2);
}

hermes(preset.profile, ["config", "set", "model.provider", preset.provider]);
hermes(preset.profile, ["config", "set", "model.default", preset.model]);
if (preset.base_url) hermes(preset.profile, ["config", "set", "model.base_url", preset.base_url]);
else hermes(preset.profile, ["config", "unset", "model.base_url"], { allowFail: true });
hermes(preset.profile, ["config", "set", "agent.max_turns", String(preset.max_turns || 24)]);
hermes(preset.profile, ["config", "set", "memory.memory_enabled", "false"]);
hermes(preset.profile, ["config", "set", "memory.user_profile_enabled", "false"]);
hermes(preset.profile, ["config", "set", "platforms.webhook.enabled", "true"]);
hermes(preset.profile, ["config", "set", "platforms.webhook.extra.port", String(preset.webhook_port)]);
hermes(preset.profile, ["config", "set", "platforms.webhook.extra.host", "127.0.0.1"]);
hardenShoppingProfile(preset.profile);

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
The default Hermes profile is unchanged.`);
