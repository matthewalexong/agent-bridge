#!/usr/bin/env node
// read-label.mjs — deterministic Supplement/Nutrition Facts reader.
//
// The regulated truth source. Opens ONE product-page tab, pulls the hi-res
// image gallery, OCRs each image with the local macOS Vision binary, finds the
// facts panel, and parses: servings per container, serving size (g), and
// protein per serving (g). From those, total protein and $/gram of protein.
//
// No LLM anywhere in this path. OCR is free, local, and deterministic.
//
// Usage:
//   node eval/search/live/read-label.mjs --asin B000GISU1M [--price 107.95]
//
// Output: JSON on stdout. Tab is ALWAYS closed.

import { callBridge } from "../../../lib/bridge-client.mjs";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OCR_BIN = join(__dirname, "ocr");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

// OCR one image file via the compiled Swift/Vision binary.
function ocrImage(path) {
  try {
    return execFileSync(OCR_BIN, [path], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    return "";
  }
}

// Detect whether OCR text contains a facts panel, and parse the key numbers.
// A REAL panel has the title AND at least one mandatory row ("servings per
// container" / "serving size"). Cross-references like "SEE NUTRITION FACTS FOR
// MORE INFORMATION" and flavor-variant front labels must NOT qualify.
function parseFacts(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const joined = lines.join("\n");

  const hasTitle =
    /nutrition\s*facts/i.test(joined) ||
    /supplement\s*facts/i.test(joined);
  const hasMandatoryRow =
    /servings?\s*per\s*container/i.test(joined) ||
    /serving\s*size/i.test(joined);
  if (!hasTitle || !hasMandatoryRow) return null;

  // servings per container
  let servings = null;
  let m = joined.match(/(\d+)\s*servings?\s*per\s*container/i);
  if (m) servings = parseInt(m[1], 10);
  if (servings == null) {
    // "Servings Per Container" possibly on its own line with number nearby
    const idx = lines.findIndex((l) => /servings?\s*per\s*container/i.test(l));
    if (idx >= 0) {
      const window = lines.slice(Math.max(0, idx - 1), idx + 2).join(" ");
      const mm = window.match(/(\d{1,4})/);
      if (mm) servings = parseInt(mm[1], 10);
    }
  }
  if (servings == null) {
    m = joined.match(/(\d+)\s*servings/i);
    if (m) servings = parseInt(m[1], 10);
  }

  // serving size in grams
  let servingSizeG = null;
  m = joined.match(/serving\s*size\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i);
  if (m) servingSizeG = parseFloat(m[1]);

  // protein per serving in grams
  let proteinPerServing = null;
  m = joined.match(/protein\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i);
  if (m) proteinPerServing = parseFloat(m[1]);

  return { servingsPerContainer: servings, servingSizeG, proteinPerServingG: proteinPerServing };
}

// Extract distinct hi-res gallery URLs from the page's inline colorImages JSON.
const HIRES_SCRIPT = `(() => {
  const urls = [];
  for (const s of document.querySelectorAll("script")) {
    const t = s.textContent || "";
    let idx = 0;
    while (true) {
      const at = t.indexOf('"hiRes":"', idx);
      if (at < 0) break;
      const start = at + '"hiRes":"'.length;
      const end = t.indexOf('"', start);
      if (end > start) {
        const u = t.slice(start, end).replace(/\\\\\\//g, "/");
        if (u.startsWith("https")) urls.push(u);
      }
      idx = end + 1;
    }
  }
  return urls;
})()`;

// Stage 2: the Product Information detail tables (DOM text, deterministic).
// Rows look like "Total Servings Per Container   76" / "Protein   25 g".
const TABLE_SCRIPT = `(() => {
  const tables = [...document.querySelectorAll(
    "#productDetails_techSpec_section_1, #prodDetails table, #productDetails_detailBullets_sections1, table.prodDetTable"
  )];
  return tables.map(t => t.innerText).join("\\n");
})()`;

function parseInfoTable(text) {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ");
  let servings = null, protein = null, servingSize = null;
  let m = flat.match(/Total Servings Per Container\s*[:\u200f\u200e]*\s*(\d+)/i);
  if (m) servings = parseInt(m[1], 10);
  m = flat.match(/\bProtein\s*[:\u200f\u200e]*\s*(\d+(?:\.\d+)?)\s*g/i);
  if (m) protein = parseFloat(m[1]);
  m = flat.match(/Serving Size\s*[:\u200f\u200e]*\s*(\d+(?:\.\d+)?)\s*g/i);
  if (m) servingSize = parseFloat(m[1]);
  // Sanity: table "Protein" is per-serving; a whole-tub value would be >>100g.
  if (protein != null && protein > 100) protein = null;
  if (servings == null && protein == null) return null;
  return { servingsPerContainer: servings, servingSizeG: servingSize, proteinPerServingG: protein };
}

async function readLabel(asin, price, maxImages = 14, claimedWeightG = null) {
  const url = `https://www.amazon.com/dp/${asin}`;
  const tab = await callBridge("tabs.create", { url });
  const tabId = tab.tabId ?? tab.id;

  try {
    await new Promise((r) => setTimeout(r, 3500));

    const attach = await callBridge("raw.attach", { tabId, captureEvents: false });
    const sessionId = attach.sessionId || attach.rawSessionId;
    if (!sessionId) throw new Error("no sessionId");

    // Fetch gallery URLs AND the info-table text in one session.
    const ev = await callBridge("raw.send", {
      sessionId, method: "Runtime.evaluate",
      params: { expression: HIRES_SCRIPT, returnByValue: true },
    });
    const evTable = await callBridge("raw.send", {
      sessionId, method: "Runtime.evaluate",
      params: { expression: TABLE_SCRIPT, returnByValue: true },
    });
    await callBridge("raw.detach", { sessionId });

    const infoTable = parseInfoTable(evTable?.result?.result?.value ?? "");
    const raw = ev?.result?.result?.value ?? [];
    // Dedupe by image id, keep order.
    const byId = new Map();
    for (const u of raw) {
      const base = u.split("/").pop();
      const id = base.replace(/_AC_[^.]*/i, "").replace(/\.[a-z]+$/i, "");
      if (!byId.has(id)) byId.set(id, u);
    }
    const urls = [...byId.values()];

    // Download + OCR until we find a panel (cap to keep it bounded).
    const work = join(tmpdir(), `label-${asin}-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    const MAX = Math.min(urls.length, maxImages);

    // Gather candidates from each source, then pick the first PLAUSIBLE one.
    // A panel can belong to a different variant (e.g. a trial-size pouch photo
    // in the gallery): whey protein is >=20% protein by weight, so a total
    // protein far below 20% of the claimed package weight is implausible.
    const totalOf = (f) =>
      f.servingsPerContainer != null && f.proteinPerServingG != null
        ? f.servingsPerContainer * f.proteinPerServingG
        : null;
    const plausible = (f) => {
      if (!claimedWeightG) return true;
      const total = totalOf(f);
      if (total == null) return true; // not enough data to judge
      return total >= 0.2 * claimedWeightG;
    };

    const candidates = [];
    let panelFacts = null;
    for (let i = 0; i < MAX; i++) {
      let buf;
      try {
        buf = Buffer.from(await (await fetch(urls[i])).arrayBuffer());
      } catch { continue; }
      if (buf.length < 5000) continue;
      const fp = join(work, `img-${i}.jpg`);
      writeFileSync(fp, buf);

      const text = ocrImage(fp);
      const facts = parseFacts(text);
      if (facts && (facts.proteinPerServingG != null || facts.servingsPerContainer != null)) {
        panelFacts = { ...facts, panelImageIndex: i };
        break;
      }
    }
    if (panelFacts) candidates.push({ ...panelFacts, source: "facts-panel" });
    if (infoTable && (infoTable.proteinPerServingG != null || infoTable.servingsPerContainer != null)) {
      candidates.push({ ...infoTable, source: "info-table" });
    }

    const chosen = candidates.find(plausible);
    if (chosen) return finish(chosen, urls.length);
    if (candidates.length) {
      return finish({
        ...candidates[0], suspect: true,
        note: "label numbers implausible vs claimed package weight (likely a different variant's panel)",
      }, urls.length);
    }
    return finish({ found: false, source: null, note: "no facts panel OCR'd and no usable info-table rows" }, urls.length);
  } finally {
    await callBridge("tabs.close", { tabId }).catch(() => {});
  }

  function finish(facts, galleryCount) {
    const totalProteinG =
      facts.servingsPerContainer != null && facts.proteinPerServingG != null
        ? Math.round(facts.servingsPerContainer * facts.proteinPerServingG)
        : null;
    return {
      asin, found: facts.found !== false, price: price ?? null, galleryCount,
      claimedWeightG: claimedWeightG ?? null,
      servingsPerContainer: facts.servingsPerContainer ?? null,
      servingSizeG: facts.servingSizeG ?? null,
      proteinPerServingG: facts.proteinPerServingG ?? null,
      source: facts.source ?? null, panelImageIndex: facts.panelImageIndex ?? null,
      suspect: facts.suspect === true,
      totalProteinG,
      dollarsPerGramProtein: totalProteinG && price != null ? +(price / totalProteinG).toFixed(4) : null,
      ...(facts.note ? { note: facts.note } : {}),
    };
  }
}

// CLI entry
if (process.argv[1].endsWith("read-label.mjs")) {
  const asin = arg("asin");
  const price = arg("price") != null ? Number(arg("price")) : undefined;
  if (!asin) { console.error("usage: read-label.mjs --asin <ASIN> [--price <usd>]"); process.exit(1); }
  readLabel(asin, price, Number(arg("max-images", 14))).then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
}

export { readLabel };
