import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("side-panel token menu masks long-lived tokens and never uses synchronized storage", async () => {
  const module = await import(pathToFileURL(path.join(root, "extension/panel.js")));
  const token = `cab_${Buffer.alloc(32, 3).toString("base64url")}`;
  const masked = module.maskToken(token);
  assert.equal(masked.startsWith(token.slice(0, 8)), true);
  assert.equal(masked.endsWith(token.slice(-6)), true);
  assert.equal(masked.includes(token), false);

  const source = await fs.readFile(path.join(root, "extension/panel.js"), "utf8");
  assert.equal(source.includes("storage.sync"), false);
  assert.equal(source.includes("console."), false);
  assert.equal(source.includes('send({ type: "auth.status" })'), true, "panel startup uses token-free connectivity status");
  assert.equal(source.match(/send\(\{ type: "auth\.get" \}\)/g)?.length, 1, "the raw token is fetched only when settings opens");
  assert.match(source, /function closeMenu[\s\S]*clearToken\(\)/, "closing settings drops the retained token");
});

test("side panel hosts the token controls retired from the toolbar popup", async () => {
  const html = await fs.readFile(path.join(root, "extension/panel.html"), "utf8");
  for (const id of ["menu-toggle", "menu-popover", "token", "toggle-token", "copy-token", "renew-token"]) {
    assert.equal(html.includes(`id="${id}"`), true, `panel.html must contain #${id}`);
  }
  assert.match(html, /id="menu-popover"[^>]+role="dialog"/);
  // Renew is destructive (invalidates the previous token at once), so the
  // two-step confirmation from the popup must survive the port.
  const source = await fs.readFile(path.join(root, "extension/panel.js"), "utf8");
  assert.equal(source.includes("Confirm renew"), true);
  assert.equal(source.includes("auth.renew"), true);
});
