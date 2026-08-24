import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("panel renders live and durable research trails with DOM-safe text", async () => {
  const [script, styles] = await Promise.all([
    fs.readFile(path.join(root, "extension/panel.js"), "utf8"),
    fs.readFile(path.join(root, "extension/panel.css"), "utf8"),
  ]);
  assert.match(script, /function appendResearchItems/);
  assert.match(script, /function appendResearchTrail/);
  assert.match(script, /doc\.createElement\("details"\)/);
  assert.match(script, /Research trail ·/);
  assert.match(script, /message\.progress/);
  assert.match(script, /entry\.research/);
  assert.match(script, /\.textContent = item\.summary/);
  assert.doesNotMatch(script, /innerHTML\s*=/, "research rendering must not create an HTML injection path");
  assert.match(styles, /\.research-trail/);
  assert.match(styles, /\.research-evidence/);
  assert.match(styles, /\.research-next/);
  assert.match(styles, /thinking-spinner/);
  assert.match(styles, /thinking-flash/);
  assert.match(script, /thinking-spinner/);
  assert.match(script, /card-price-label/);
  assert.match(script, /Sold by /);
  assert.match(script, /Availability unknown/);
  assert.match(script, /✓ Verified pick/);
  assert.match(script, /Landed total/);
  assert.match(script, /card-details/);
  assert.match(script, /card-breakdown/);
  assert.match(styles, /\.card-availability\.is-in/);
  assert.match(styles, /\.card-availability\.is-out/);
  assert.match(styles, /\.card-availability\.is-unknown/);
  assert.match(styles, /\.card-verified/);
  assert.match(styles, /\.card-landed-total/);
  assert.match(styles, /\.card-details/);
  assert.match(styles, /\.card-breakdown/);
});
