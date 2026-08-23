const ALLOWED_LANES = new Set(["discovery", "product_evidence", "safety", "offer_risk", "price_logistics"]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function queryKey(value) {
  return clean(value).toLowerCase();
}

export function parseSearchBatchDirective(text) {
  const match = String(text ?? "").match(/^\s*SEARCH_BATCH:\s*([^\n]+)\s*$/im);
  if (!match) return null;
  let input;
  try { input = JSON.parse(match[1]); } catch { return { error: "invalid_search_batch_json", items: [] }; }
  if (!Array.isArray(input)) return { error: "invalid_search_batch_shape", items: [] };
  const items = [];
  for (const raw of input.slice(0, 4)) {
    const item = typeof raw === "string" ? { lane: "discovery", query: raw } : raw;
    const lane = clean(item?.lane).toLowerCase();
    const query = clean(item?.query);
    if (!ALLOWED_LANES.has(lane) || !query || query.length > 2_000) return { error: "invalid_search_batch_item", items: [] };
    items.push({ lane, query });
  }
  if (!items.length) return { error: "empty_search_batch", items: [] };
  return { error: null, items };
}

export async function executeSearchBatch(items, search, { cache = new Map(), max_items = 4 } = {}) {
  const grouped = new Map();
  for (const item of items.slice(0, max_items)) {
    const normalizedQuery = clean(item.query);
    const key = queryKey(normalizedQuery);
    if (!key) continue;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.lanes.includes(item.lane)) existing.lanes.push(item.lane);
    } else grouped.set(key, { key, query: normalizedQuery, lanes: [item.lane] });
  }
  const tasks = [...grouped.values()].map(async (item) => {
    const cached = cache.has(item.key);
    if (!cached) cache.set(item.key, Promise.resolve().then(() => search(item.query)));
    try {
      return { query: item.query, lanes: item.lanes, status: "complete", cached, results: await cache.get(item.key) };
    } catch (error) {
      cache.delete(item.key);
      return { query: item.query, lanes: item.lanes, status: "error", cached, error: error?.message || String(error), results: null };
    }
  });
  return Promise.all(tasks);
}

export function formatSearchBatchResults(entries) {
  return entries.map((entry) => [
    `LANES: ${entry.lanes.join(", ")}`,
    `QUERY: ${entry.query}`,
    entry.status === "complete" ? String(entry.results) : `SEARCH ERROR: ${entry.error}`,
  ].join("\n")).join("\n\n---\n\n");
}
