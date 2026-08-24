import crypto from "node:crypto";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { extractShoppingPageEvidence } from "./shopping-page-evidence.mjs";
import { extractCheckoutEvidence } from "./shopping-checkout.mjs";
import { extractCheckoutTermsEvidence } from "./shopping-checkout-terms-evidence.mjs";
import { extractShoppingListingCandidates } from "./shopping-listing-candidates.mjs";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

export function createBrowserEvidenceRegistry({ max_entries = 100, max_age_seconds = 300 } = {}) {
  const entries = new Map();

  function capture({ tab_id, snapshot, captured_at = null }) {
    if (!Number.isInteger(tab_id) || tab_id < 0 || !snapshot?.snapshotId || typeof snapshot.text !== "string" || !snapshot.url) {
      throw coded("Browser snapshot cannot issue a shopping evidence receipt", "shopping_snapshot_invalid");
    }
    const captured = new Date(captured_at || Date.now());
    if (!Number.isFinite(captured.getTime())) throw coded("Browser snapshot capture time is invalid", "shopping_snapshot_invalid");
    const elements = Array.isArray(snapshot.elements)
      ? snapshot.elements.slice(0, 500).map((element) => ({
        ref: typeof element?.ref === "string" ? element.ref.slice(0, 20) : null,
        role: typeof element?.role === "string" ? element.role.slice(0, 40) : null,
        name: typeof element?.name === "string" ? element.name.slice(0, 200) : "",
        href: typeof element?.href === "string" ? element.href.slice(0, 4_000) : null,
        image: typeof element?.image === "string" ? element.image.slice(0, 4_000) : null,
        context: typeof element?.context === "string" ? element.context.slice(0, 1_000) : "",
      }))
      : [];
    const receipt = attestShoppingArtifact("browser_snapshot", {
      source_id: snapshot.snapshotId,
      snapshot_id: snapshot.snapshotId,
      tab_id,
      url: snapshot.url,
      title: snapshot.title || null,
      captured_at: captured.toISOString(),
      truncated: snapshot.truncated === true,
      content_sha256: crypto.createHash("sha256").update(snapshot.text).digest("hex"),
      elements_sha256: crypto.createHash("sha256").update(JSON.stringify(elements)).digest("hex"),
    });
    entries.set(snapshot.snapshotId, { receipt, text: snapshot.text, elements });
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return receipt;
  }

  function resolve(snapshot_id, { evaluated_at = Date.now(), allowed_age_seconds = max_age_seconds } = {}) {
    const entry = entries.get(snapshot_id);
    if (!entry || !verifyShoppingArtifactAttestation("browser_snapshot", entry.receipt)) throw coded("Take a fresh browser_snapshot before extracting shopping evidence", "shopping_snapshot_receipt_not_found");
    const evaluated = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
    const captured = Date.parse(entry.receipt.captured_at);
    const ageLimit = Math.min(max_age_seconds, allowed_age_seconds) * 1_000;
    if (!Number.isFinite(evaluated) || !Number.isFinite(captured) || captured > evaluated + 5_000 || evaluated - captured > ageLimit) {
      entries.delete(snapshot_id);
      throw coded("Browser snapshot receipt is stale; take a fresh browser_snapshot", "shopping_snapshot_receipt_stale");
    }
    return structuredClone(entry);
  }

  function clear() {
    entries.clear();
  }

  return { capture, resolve, clear, size: () => entries.size };
}

export function extractBrowserObservedShoppingPageEvidence(resolveSnapshot, input) {
  if (typeof resolveSnapshot !== "function") throw coded("Browser evidence registry is unavailable", "shopping_snapshot_registry_unavailable");
  const observed = resolveSnapshot(input.snapshot_id, { allowed_age_seconds: input.max_snapshot_age_seconds, evaluated_at: input.evaluated_at });
  return pageEvidenceFromObserved(observed, input);
}

export function extractBrowserObservedListingCandidates(resolveSnapshot, input) {
  if (typeof resolveSnapshot !== "function") throw coded("Browser evidence registry is unavailable", "shopping_snapshot_registry_unavailable");
  const observed = resolveSnapshot(input.snapshot_id, { allowed_age_seconds: input.max_snapshot_age_seconds, evaluated_at: input.evaluated_at });
  return extractShoppingListingCandidates({
    source_receipt: observed.receipt,
    elements: observed.elements,
    query: input.query,
    max_candidates: input.max_candidates,
  });
}

function pageEvidenceFromObserved(observed, input) {
  if ((input.directory_complete === true || input.page_kind === "checkout") && observed.receipt.truncated === true) throw coded("A truncated browser snapshot cannot prove complete shopping evidence", "shopping_snapshot_incomplete");
  const extracted = extractShoppingPageEvidence({
    page_text: observed.text,
    url: observed.receipt.url,
    captured_at: observed.receipt.captured_at,
    page_kind: input.page_kind,
    seller_query: input.seller_query,
    directory_complete: input.directory_complete,
  });
  return attestShoppingArtifact("page_evidence", { ...extracted, source_receipt: observed.receipt });
}

export function createShoppingPageEvidenceLedger({ resolve_snapshot, max_entries = 500 } = {}) {
  if (typeof resolve_snapshot !== "function") throw coded("Browser evidence registry is unavailable", "shopping_snapshot_registry_unavailable");
  const entries = new Map();
  let hits = 0;
  let misses = 0;
  const scopeKey = (observed, input) => JSON.stringify([
    observed.receipt.snapshot_id,
    observed.receipt.content_sha256,
    input.page_kind || "retailer_listing",
    String(input.seller_query || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " "),
    input.directory_complete === true,
  ]);

  function extract(input) {
    const observed = resolve_snapshot(input.snapshot_id, { allowed_age_seconds: input.max_snapshot_age_seconds, evaluated_at: input.evaluated_at });
    const key = scopeKey(observed, input);
    if (entries.has(key)) {
      hits += 1;
      return structuredClone(entries.get(key));
    }
    misses += 1;
    const artifact = pageEvidenceFromObserved(observed, input);
    entries.set(key, artifact);
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return structuredClone(artifact);
  }

  function clear() { entries.clear(); hits = 0; misses = 0; }
  function stats() { return { entries: entries.size, hits, misses }; }
  return { extract, clear, stats };
}

export async function captureBrowserSnapshotsBatch(items, { snapshot, capture, max_total_chars = 120_000 } = {}) {
  if (typeof snapshot !== "function" || typeof capture !== "function") throw coded("Browser snapshot batch dependencies are unavailable", "shopping_snapshot_registry_unavailable");
  if (!Array.isArray(items) || !items.length || items.length > 8) throw coded("Browser snapshot batch must contain 1-8 tabs", "browser_snapshot_batch_invalid");
  if (new Set(items.map((item) => item.tabId)).size !== items.length) throw coded("Browser snapshot batch cannot repeat a tab", "browser_snapshot_batch_invalid");
  if (items.reduce((sum, item) => sum + (item.maxChars || 15_000), 0) > max_total_chars) throw coded("Browser snapshot batch exceeds the total character budget", "browser_snapshot_batch_invalid");
  return Promise.all(items.map(async (item) => {
    try {
      const result = await snapshot(item);
      const evidence_receipt = capture({ tab_id: item.tabId, snapshot: result, captured_at: result.captured_at || result.capturedAt || null });
      return { tab_id: item.tabId, status: "complete", snapshot: { ...result, evidence_receipt } };
    } catch (error) {
      return { tab_id: item.tabId, status: "error", error: { code: error?.code || "bridge_error", message: error?.message || String(error) } };
    }
  }));
}

export function extractBrowserObservedCheckoutEvidence(resolveSnapshot, input) {
  if (typeof resolveSnapshot !== "function") throw coded("Browser evidence registry is unavailable", "shopping_snapshot_registry_unavailable");
  const observed = resolveSnapshot(input.snapshot_id, { allowed_age_seconds: input.max_snapshot_age_seconds, evaluated_at: input.evaluated_at });
  if (observed.receipt.truncated === true) throw coded("A truncated checkout snapshot cannot prove cart completeness", "shopping_snapshot_incomplete");
  const extracted = extractCheckoutEvidence({ page_text: observed.text, url: observed.receipt.url, captured_at: observed.receipt.captured_at });
  return attestShoppingArtifact("checkout_evidence", { ...extracted, source_receipt: observed.receipt });
}

export function extractBrowserObservedCheckoutTermsEvidence(resolveSnapshot, input) {
  if (typeof resolveSnapshot !== "function") throw coded("Browser evidence registry is unavailable", "shopping_snapshot_registry_unavailable");
  const observed = resolveSnapshot(input.snapshot_id, { allowed_age_seconds: input.max_snapshot_age_seconds, evaluated_at: input.evaluated_at });
  if (observed.receipt.truncated === true) throw coded("A truncated checkout snapshot cannot prove complete terms or add-on inventories", "shopping_snapshot_incomplete");
  const extracted = extractCheckoutTermsEvidence({ page_text: observed.text, url: observed.receipt.url, captured_at: observed.receipt.captured_at, source_id: observed.receipt.source_id });
  return attestShoppingArtifact("checkout_terms_evidence", { ...extracted, source_receipt: observed.receipt });
}
