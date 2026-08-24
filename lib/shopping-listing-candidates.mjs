import crypto from "node:crypto";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const TRACKING_KEYS = new Set(["ascsubtag", "camp", "creative", "creativeasin", "linkcode", "qid", "ref", "sr", "tag"]);
const RETAILER_PRODUCT_PATH = /(?:\/dp\/[A-Z0-9]{8,}|\/gp\/product\/[A-Z0-9]{8,}|\/itm\/(?:[^/]+\/)?[0-9]{8,}|\/ip\/(?:[^/]+\/)?[0-9]{5,}|\/site\/[^/]+\/[0-9]+\.p|\/-\/A-[0-9]{5,})/i;
const GENERIC_PRODUCT_PATH = /\/(?:products?|items?|p)\/[^/?#]{2,}/i;
const MONEY = /(?:^|\s)(?:US\s*)?\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)(?:\s|$)/i;

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function clean(value, max = 1_000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function normalizedListingUrl(value) {
  const url = safeHttpUrl(value);
  if (!url) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url.href;
}

function queryTokens(value) {
  return new Set(clean(value, 300).toLowerCase().match(/[a-z0-9]{2,}/g) || []);
}

function tokenOverlap(query, text) {
  if (query.size === 0) return 0;
  const haystack = queryTokens(text);
  let matches = 0;
  for (const token of query) if (haystack.has(token)) matches += 1;
  return matches / query.size;
}

function priceFromContext(context) {
  const match = MONEY.exec(context);
  if (!match) return null;
  const amount = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(amount) && amount >= 0 && amount <= 10_000_000
    ? { display: `$${amount.toFixed(2)}`, amount_usd: Math.round(amount * 100) / 100 }
    : null;
}

export function extractShoppingListingCandidates({ source_receipt, elements, query = "", max_candidates = 20 } = {}) {
  if (!verifyShoppingArtifactAttestation("browser_snapshot", source_receipt)) {
    throw coded("Listing candidates require a valid browser snapshot receipt", "shopping_listing_snapshot_invalid");
  }
  const limit = Math.max(1, Math.min(40, Number(max_candidates) || 20));
  const wanted = queryTokens(query);
  const deduped = new Map();
  for (const element of Array.isArray(elements) ? elements.slice(0, 500) : []) {
    if (element?.role !== "link") continue;
    const url = normalizedListingUrl(element.href);
    if (!url) continue;
    const pathname = new URL(url).pathname;
    const title = clean(element.name, 200);
    if (title.length < 3) continue;
    const context = clean(element.context || title, 1_000);
    const price = priceFromContext(context);
    const imageUrl = normalizedListingUrl(element.image);
    if (!RETAILER_PRODUCT_PATH.test(pathname) && !(GENERIC_PRODUCT_PATH.test(pathname) && (price || imageUrl))) continue;
    const overlap = tokenOverlap(wanted, `${title} ${context}`);
    const score = overlap * 100 + (price ? 8 : 0) + (imageUrl ? 4 : 0) + Math.min(title.length, 120) / 120;
    const candidate = {
      id: `listing_${crypto.createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
      ref: /^e\d+$/.test(String(element.ref || "")) ? element.ref : null,
      title,
      url,
      image: imageUrl,
      price,
      query_overlap: Math.round(overlap * 1_000) / 1_000,
      _score: score,
    };
    const previous = deduped.get(url);
    if (!previous || candidate._score > previous._score) deduped.set(url, candidate);
  }
  const candidates = [...deduped.values()]
    .sort((a, b) => b._score - a._score || a.url.localeCompare(b.url))
    .slice(0, limit)
    .map(({ _score, ...candidate }) => candidate);
  return attestShoppingArtifact("listing_candidates", {
    source_receipt,
    query: clean(query, 300),
    candidates,
    coverage: {
      observed_product_links: deduped.size,
      returned: candidates.length,
      truncated: deduped.size > candidates.length,
      exhaustive: false,
    },
    selects_product: false,
  });
}
