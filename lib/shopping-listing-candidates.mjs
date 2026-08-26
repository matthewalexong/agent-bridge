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

export function shoppingListingUrlKey(value) {
  const normalized = normalizedListingUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const amazon = /\/(?:dp|gp\/product)\/([A-Z0-9]{8,})/i.exec(path);
  if (amazon && /(?:^|\.)amazon\./i.test(url.hostname)) return `amazon:${amazon[1].toUpperCase()}`;
  const ebay = /\/itm\/(?:[^/]+\/)?([0-9]{8,})/i.exec(path);
  if (ebay && /(?:^|\.)ebay\./i.test(url.hostname)) return `ebay:${ebay[1]}`;
  const walmart = /\/ip\/(?:[^/]+\/)?([0-9]{5,})/i.exec(path);
  if (walmart && /(?:^|\.)walmart\./i.test(url.hostname)) return `walmart:${walmart[1]}`;
  const bestBuy = /\/site\/[^/]+\/([0-9]+)\.p/i.exec(path);
  if (bestBuy && /(?:^|\.)bestbuy\./i.test(url.hostname)) return `bestbuy:${bestBuy[1]}`;
  const target = /\/-\/A-([0-9]{5,})/i.exec(path);
  if (target && /(?:^|\.)target\./i.test(url.hostname)) return `target:${target[1]}`;
  url.pathname = path;
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
  const candidateSetId = `cset_${crypto.createHash("sha256").update(JSON.stringify({
    snapshot_id: source_receipt.snapshot_id,
    query: clean(query, 300),
    candidate_ids: candidates.map((candidate) => candidate.id),
  })).digest("hex").slice(0, 24)}`;
  return attestShoppingArtifact("listing_candidates", {
    candidate_set_id: candidateSetId,
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

export function createShoppingExactPageCandidateSet({ page_evidence, query = "" } = {}) {
  if (!Array.isArray(page_evidence) || page_evidence.length < 1 || page_evidence.length > 5) {
    throw coded("Exact-page candidate creation requires 1-5 page-evidence artifacts", "shopping_exact_page_candidates_invalid");
  }
  const candidates = [];
  const sourceReceipts = [];
  const seen = new Set();
  for (const evidence of page_evidence) {
    const receipt = evidence?.source_receipt;
    const url = normalizedListingUrl(evidence?.source?.url);
    const key = shoppingListingUrlKey(url);
    if (!verifyShoppingArtifactAttestation("page_evidence", evidence) ||
        !verifyShoppingArtifactAttestation("browser_snapshot", receipt) ||
        evidence?.source?.page_kind !== "retailer_listing" || !url || !key || seen.has(key)) {
      throw coded("Exact-page candidates require unique signed retailer product pages", "shopping_exact_page_candidates_invalid");
    }
    seen.add(key);
    sourceReceipts.push(receipt);
    const priceFact = evidence?.facts?.price_usd;
    const amount = priceFact && ["explicit", "derived"].includes(priceFact.status) && Number.isFinite(priceFact.value)
      ? Number(priceFact.value)
      : null;
    const title = clean(receipt.title || new URL(url).hostname, 200);
    candidates.push({
      id: `listing_${crypto.createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
      ref: null,
      title,
      url,
      image: null,
      price: amount == null ? null : { display: `$${amount.toFixed(2)}`, amount_usd: amount },
      query_overlap: tokenOverlap(queryTokens(query), title),
    });
  }
  const candidateSetId = `cset_${crypto.createHash("sha256").update(JSON.stringify({
    snapshot_ids: sourceReceipts.map((receipt) => receipt.snapshot_id),
    query: clean(query, 300),
    candidate_ids: candidates.map((candidate) => candidate.id),
  })).digest("hex").slice(0, 24)}`;
  return attestShoppingArtifact("listing_candidates", {
    candidate_set_id: candidateSetId,
    ...(sourceReceipts.length === 1 ? { source_receipt: sourceReceipts[0] } : { source_receipts: sourceReceipts }),
    query: clean(query, 300),
    candidates,
    coverage: { source_pages: sourceReceipts.length, merchant_domains: new Set(candidates.map((candidate) => new URL(candidate.url).hostname)).size, returned: candidates.length, exhaustive: false },
    selects_product: false,
  });
}

function sourceRecord(artifact) {
  const receipt = artifact.source_receipt;
  let hostname = null;
  try { hostname = new URL(receipt.url).hostname.toLowerCase(); } catch {}
  return { candidate_set_id: artifact.candidate_set_id, snapshot_id: receipt.snapshot_id, page_url: receipt.url, hostname };
}

function diverseCandidates(candidates, limit) {
  const groups = new Map();
  for (const candidate of candidates) {
    let hostname = "unknown";
    try { hostname = new URL(candidate.url).hostname.toLowerCase(); } catch {}
    if (!groups.has(hostname)) groups.set(hostname, []);
    groups.get(hostname).push(candidate);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      (b.query_overlap || 0) - (a.query_overlap || 0) ||
      Number(Boolean(b.price)) - Number(Boolean(a.price)) ||
      Number(Boolean(b.image)) - Number(Boolean(a.image)) ||
      a.url.localeCompare(b.url));
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const selected = [];
  for (let index = 0; selected.length < limit; index += 1) {
    let added = false;
    for (const [, group] of orderedGroups) {
      if (group[index]) {
        selected.push(group[index]);
        added = true;
        if (selected.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return selected;
}

export function fuseShoppingCandidateSets(artifacts, { query = "", max_candidates = 20 } = {}) {
  if (!Array.isArray(artifacts) || artifacts.length < 2 || artifacts.length > 8) {
    throw coded("Candidate fusion requires 2-8 source sets", "shopping_candidate_fusion_invalid");
  }
  const sourceIds = new Set();
  for (const artifact of artifacts) {
    if (!verifyShoppingArtifactAttestation("listing_candidates", artifact) ||
        !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt) ||
        sourceIds.has(artifact.candidate_set_id)) {
      throw coded("Candidate fusion source is invalid or repeated", "shopping_candidate_fusion_invalid");
    }
    sourceIds.add(artifact.candidate_set_id);
  }
  const wanted = queryTokens(query);
  const byUrl = new Map();
  for (const artifact of artifacts) {
    const source = sourceRecord(artifact);
    for (const candidate of artifact.candidates || []) {
      const existing = byUrl.get(candidate.url);
      const sources = existing?.sources || [];
      if (!sources.some((item) => item.snapshot_id === source.snapshot_id)) sources.push(source);
      const overlap = wanted.size > 0 ? tokenOverlap(wanted, candidate.title) : candidate.query_overlap || 0;
      const next = { ...candidate, query_overlap: Math.round(overlap * 1_000) / 1_000, sources };
      if (!existing || overlap > (existing.query_overlap || 0) || (!existing.price && candidate.price)) byUrl.set(candidate.url, next);
      else existing.sources = sources;
    }
  }
  const limit = Math.max(1, Math.min(40, Number(max_candidates) || 20));
  const unique = [...byUrl.values()];
  const candidates = diverseCandidates(unique, limit);
  const sourceReceipts = artifacts.map((artifact) => artifact.source_receipt);
  const candidateSetId = `cset_${crypto.createHash("sha256").update(JSON.stringify({
    source_candidate_set_ids: [...sourceIds].sort(),
    query: clean(query, 300),
    candidate_ids: candidates.map((candidate) => candidate.id),
  })).digest("hex").slice(0, 24)}`;
  return attestShoppingArtifact("listing_candidates", {
    candidate_set_id: candidateSetId,
    source_receipts: sourceReceipts,
    source_candidate_set_ids: [...sourceIds],
    query: clean(query, 300),
    candidates,
    coverage: {
      source_pages: artifacts.length,
      merchant_domains: new Set(unique.map((candidate) => { try { return new URL(candidate.url).hostname.toLowerCase(); } catch { return "unknown"; } })).size,
      input_candidates: artifacts.reduce((sum, artifact) => sum + (artifact.candidates?.length || 0), 0),
      unique_candidates: unique.length,
      returned: candidates.length,
      truncated: unique.length > candidates.length,
      exhaustive: false,
    },
    selects_product: false,
  });
}
