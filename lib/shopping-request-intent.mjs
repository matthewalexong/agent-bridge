import crypto from "node:crypto";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { shoppingRequestReceiptSchema } from "./shopping-request-intent-schema.mjs";

const HINTS = Object.freeze({
  budget: /(?:[$€£¥₹]\s*\d|\b(?:budget|price|cost|cheaper?|afford)\b|\b(?:under|below|over|max(?:imum)?)\s+(?:[$€£¥₹]\s*)?\d[\d,]*(?:\.\d+)?\b(?!\s*(?:TB|GB|MB|kg|g|lbs?|oz|inches|inch|in|cm|mm|ft|hours?|hrs?|minutes?|mins?|watts?|W|kHz|Hz|mAh|Wh)\b))/i,
  deadline: /\b(?:arrive|delivery|deliver|deadline|by\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)|before\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)|asap|urgent|in time)\b/i,
  compatibility: /\b(?:compatible|compatibility|works? with|fit(?:s|ting)?|connect(?:s|or)?|support(?:s|ed)?|size|interface|port|ecosystem)\b/i,
  safety: /\b(?:safe|safety|recall|certif(?:ied|ication)|hazard|child|children|baby|pet|toxic|flammable)\b/i,
  composition: /\b(?:ingredient|allerg(?:y|ic|en)|material|leather|wool|latex|fragrance|chemical|formulation|cross[- ]contact|free[- ]of)\b/i,
  privacy: /\b(?:privacy|personal data|data sale|sell(?:ing)? (?:my )?data|(?:ad|online|location|data|cross[- ]site) track(?:ing|s)?|track(?:ing|s)? (?:me|users?|activity|behavio[u]?r|location)|telemetry|account required|cloud required|location data|data collection|data sharing)\b/i,
  condition: /\b(?:new|used|refurbished|renewed|open[- ]box|preowned|condition)\b/i,
  merchant: /\b(?:seller|retailer|merchant|authorized|marketplace|local store|official store)\b/i,
  fulfillment: /\b(?:shipping|deliver(?:y|ed|ing)?|return|import|duty|tax|fee|pickup|in stock|stock|warranty)\b/i,
  preference: /\b(?:prefer|like|dislike|favorite|colour|color|style|brand|lightweight|quiet|comfortable|aesthetic|appearance)\b/i,
  other: /\b(?:must|only|without|avoid|exclude|do not|don't|cannot|can't|required|requirement)\b/i,
});

function clean(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function clauseHints(text) {
  const hints = Object.entries(HINTS).filter(([kind, pattern]) => kind !== "other" && pattern.test(text)).map(([kind]) => kind);
  const privacyTracking = /\b(?:(?:ad|online|location|data|cross[- ]site) track(?:ing|s)?|track(?:ing|s)? (?:me|users?|activity|behavio[u]?r|location))\b/i.test(text);
  if (/\btrack(?:ed|ing)?\b/i.test(text) && !privacyTracking && !hints.includes("fulfillment")) hints.push("fulfillment");
  if (!hints.length && HINTS.other.test(text)) hints.push("other");
  return hints;
}

const CURRENCY = Object.freeze({ "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" });

function numeric(value) {
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function numericOperator(prefix) {
  const text = prefix.slice(-48).toLowerCase();
  if (/(?:at least|no less than|not (?:under|less than|below)|minimum|min\.?)[\s:]*$/.test(text)) return "gte";
  if (/(?:at most|no more than|not (?:over|more than|above)|up to|maximum|max\.?)[\s:]*$/.test(text)) return "lte";
  if (/(?:more than|greater than|over)[\s:]*$/.test(text)) return "gt";
  if (/(?:less than|under|below)[\s:]*$/.test(text)) return "lt";
  if (/(?:exactly|equal to)[\s:]*$/.test(text)) return "eq";
  if (/(?:around|about|approximately|approx\.?)[\s:]*$/.test(text)) return "approx";
  return "unknown";
}

function literal(kind, raw, start, end, operator, value, unit) {
  return { literal_id: `literal_${digest(`${kind}:${start}:${end}:${raw}:${operator}:${String(value)}:${unit || ""}`).slice(0, 24)}`, kind, raw, start, end, operator, value, unit };
}

function extractLiteralFacts(text, absoluteStart) {
  const facts = [];
  const occupied = [];
  const free = (start, end) => !occupied.some(([left, right]) => start < right && end > left);
  const add = (kind, match, operator, value, unit, rawOffset = 0, rawText = match[0]) => {
    const localStart = match.index + rawOffset;
    const localEnd = localStart + rawText.length;
    if (!free(localStart, localEnd)) return;
    occupied.push([localStart, localEnd]);
    facts.push(literal(kind, rawText, absoluteStart + localStart, absoluteStart + localEnd, operator, value, unit));
  };
  const scan = (pattern, callback) => { let match; while ((match = pattern.exec(text))) callback(match); };

  scan(/([$€£¥₹])\s*(\d[\d,]*(?:\.\d{1,2})?)/g, (match) => add("money", match, numericOperator(text.slice(0, match.index)), numeric(match[2]), CURRENCY[match[1]]));
  scan(/\b(USD|EUR|GBP|JPY|INR|CAD|AUD)\s*(\d[\d,]*(?:\.\d{1,2})?)\b/gi, (match) => add("money", match, numericOperator(text.slice(0, match.index)), numeric(match[2]), match[1].toUpperCase()));
  scan(/\b(\d[\d,]*(?:\.\d{1,2})?)\s*(USD|EUR|GBP|JPY|INR|CAD|AUD)\b/gi, (match) => add("money", match, numericOperator(text.slice(0, match.index)), numeric(match[1]), match[2].toUpperCase()));
  scan(/\b(\d+(?:\.\d+)?)\s*(%|percent\b)/gi, (match) => add("percentage", match, numericOperator(text.slice(0, match.index)), numeric(match[1]), "%"));
  scan(/\b(\d+(?:\.\d+)?)\s*(TB|GB|MB|kg|g|lbs?|oz|inches|inch|in|cm|mm|ft|hours?|hrs?|minutes?|mins?|watts?|W|kHz|Hz|mAh|Wh)\b/gi, (match) => add("measurement", match, numericOperator(text.slice(0, match.index)), numeric(match[1]), match[2].toLowerCase()));
  scan(/\b(\d+)\s*(items?|units?|packs?|pairs?|sets?|pieces?)\b/gi, (match) => add("quantity", match, numericOperator(text.slice(0, match.index)), numeric(match[1]), match[2].toLowerCase()));
  scan(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b/gi, (match) => {
    const prefix = text.slice(Math.max(0, match.index - 24), match.index);
    if (/\b(?:by|before|arrive|deliver|deadline)\b/i.test(prefix)) add("deadline", match, "by", match[1].toLowerCase(), "date");
  });
  scan(/\b(?:must not|do not|don't|cannot|can't|without|avoid|exclude|no(?!\s+(?:more|less)\s+than))\b/gi, (match) => add("negation", match, "not_allowed", false, null));
  return facts.sort((left, right) => left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind));
}

export function inventoryShoppingRequestClauses(text) {
  const source = clean(text);
  if (!source || source.length > 20_000) throw Object.assign(new Error("Shopping request text is empty or too large"), { code: "shopping_request_invalid" });
  const clauses = [];
  const boundary = /(?:[.!?;]+(?=\s|$)|\n+)/g;
  let cursor = 0;
  let match;
  const add = (rawStart, rawEnd) => {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/.test(source[start])) start++;
    while (end > start && /[\s.!?;]/.test(source[end - 1])) end--;
    if (end <= start) return;
    const clauseText = source.slice(start, end);
    const clause_id = `clause_${digest(`${clauses.length}:${start}:${end}:${clauseText}`).slice(0, 24)}`;
    clauses.push({ clause_id, index: clauses.length, start, end, text: clauseText, constraint_hints: clauseHints(clauseText), literal_facts: extractLiteralFacts(clauseText, start) });
  };
  while ((match = boundary.exec(source))) {
    add(cursor, match.index + match[0].length);
    cursor = match.index + match[0].length;
  }
  add(cursor, source.length);
  if (!clauses.length) throw Object.assign(new Error("Shopping request has no usable clauses"), { code: "shopping_request_invalid" });
  return { text: source, clauses };
}

export function classifyShoppingInteractionStage(inventory) {
  const text = clean(inventory?.text);
  const clauses = Array.isArray(inventory?.clauses) ? inventory.clauses : [];
  const explicitOfferRequest = /\b(?:find|show|compare|recommend|list|search for|look for|shop for|where (?:can|should) I buy|best|cheapest|lowest[- ]price|deal|in stock|availability|available|product links?|exact offers?|current options?)\b/i.test(text);
  const decisionConstraintPresent = clauses.some((clause) => (clause?.constraint_hints?.length || 0) > 0 || (clause?.literal_facts?.length || 0) > 0);
  if (explicitOfferRequest || decisionConstraintPresent) {
    return {
      mode: "offer_research",
      exact_offer_research_ready: true,
      reason: explicitOfferRequest ? "explicit_offer_request" : "decision_constraint_present",
    };
  }
  return { mode: "category_exploration", exact_offer_research_ready: false, reason: "broad_or_ambiguous" };
}

export function issueShoppingRequestReceipt({ request_id, request_revision = 1, text, captured_at }) {
  const inventory = inventoryShoppingRequestClauses(text);
  const interaction_stage = classifyShoppingInteractionStage(inventory);
  const captured = new Date(captured_at || "");
  if (!clean(request_id) || !Number.isInteger(request_revision) || request_revision < 1 || !Number.isFinite(captured.getTime())) throw Object.assign(new Error("Shopping request provenance is invalid"), { code: "shopping_request_invalid" });
  const message_sha256 = digest(inventory.text);
  return attestShoppingArtifact("shopping_request", {
    artifact_id: `shopping_request_${digest(`${request_id}:${request_revision}:${captured.toISOString()}:${message_sha256}`).slice(0, 32)}`,
    request_id: clean(request_id),
    request_revision,
    captured_at: captured.toISOString(),
    message_sha256,
    ...inventory,
    interaction_stage,
  });
}

export function verifyShoppingRequestReceipt(receipt) {
  const parsed = shoppingRequestReceiptSchema.safeParse(receipt);
  if (!parsed.success || !verifyShoppingArtifactAttestation("shopping_request", receipt)) return false;
  let rebuilt;
  try { rebuilt = issueShoppingRequestReceipt({ request_id: receipt.request_id, request_revision: receipt.request_revision, text: receipt.text, captured_at: receipt.captured_at }); } catch { return false; }
  return rebuilt.artifact_id === receipt.artifact_id
    && rebuilt.message_sha256 === receipt.message_sha256
    && JSON.stringify(stable(rebuilt.clauses)) === JSON.stringify(stable(receipt.clauses));
}
