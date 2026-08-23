import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const CORE_FIELDS = ["brand", "product_line", "model", "generation", "edition"];
const VARIANT_FIELDS = ["region", "capacity", "size", "color"];
const ALL_FIELDS = [...CORE_FIELDS, ...VARIANT_FIELDS, "condition", "bundle_count"];
const GLOBAL_CODE_TYPES = ["upc", "ean", "gtin"];
const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

function text(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[™®©]/g, "")
    .toLowerCase()
    .replace(/\beau\s+de\s+parfum(?:\s+spray)?\b|\bparfum\s+spray\b|\bedp\b/g, " eau de parfum ")
    .replace(/\beau\s+de\s+toilette\b|\bedt\b/g, " eau de toilette ")
    .replace(/\bgrey\b/g, "gray")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(value) {
  return text(value).replace(/[^a-z0-9]/g, "");
}

function edition(value) {
  const normalized = text(value);
  return !normalized || ["base", "original", "standard", "regular"].includes(normalized) ? "base" : normalized;
}

function region(value) {
  const normalized = text(value);
  const aliases = { us: "us", usa: "us", "united states": "us", uk: "uk", gb: "uk", "united kingdom": "uk", eu: "eu", europe: "eu", jp: "jp", japan: "jp" };
  return aliases[normalized] || normalized;
}

function condition(value) {
  const normalized = text(value).replace(/\s+/g, "_");
  return normalized === "renewed" ? "refurbished" : normalized;
}

function productCategory(value) {
  return text(value).replace(/\s+/g, "_") || null;
}

function measure(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ml|milliliters?|fl\s*oz|oz|g|grams?|kg|kilograms?|lb|lbs|pounds?|gb|tb)$/i);
  if (!match) return null;
  const number = Number(match[1]);
  const unit = match[2].replace(/\s+/g, "");
  if (/^(ml|milliliter)/.test(unit)) return { dimension: "volume", value: number };
  if (/^(floz|oz)$/.test(unit)) {
    const common = [[2, 60], [2.02, 60], [3.3, 100], [3.4, 100], [6.7, 200], [6.8, 200]].find(([oz]) => Math.abs(number - oz) < 0.011);
    return { dimension: "volume", value: common ? common[1] : number * 29.5735 };
  }
  if (/^(g|gram)/.test(unit)) return { dimension: "weight", value: number };
  if (/^(kg|kilogram)/.test(unit)) return { dimension: "weight", value: number * 1000 };
  if (/^(lb|lbs|pound)/.test(unit)) return { dimension: "weight", value: number * 453.592 };
  if (unit === "gb") return { dimension: "storage", value: number };
  if (unit === "tb") return { dimension: "storage", value: number * 1000 };
  return null;
}

function normalizedField(field, value) {
  if (value == null || value === "") return null;
  if (field === "brand" || field === "model") return compact(value);
  if (field === "edition") return edition(value);
  if (field === "region") return region(value);
  if (field === "condition") return condition(value);
  if (field === "capacity" || field === "size") return measure(value) || text(value);
  if (field === "bundle_count") return Number(value);
  return text(value);
}

function fieldEqual(field, left, right) {
  const a = normalizedField(field, left);
  const b = normalizedField(field, right);
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") {
    return typeof a === "object" && typeof b === "object" && a.dimension === b.dimension && Math.abs(a.value - b.value) <= Math.max(0.01, Math.abs(a.value) * 0.005);
  }
  return a === b;
}

function tradeCode(identity) {
  for (const key of GLOBAL_CODE_TYPES) {
    const raw = String(identity.identifiers?.[key] ?? "").replace(/\D/g, "");
    if (raw) return raw.replace(/^0+/, "") || "0";
  }
  return null;
}

function mpn(identity) {
  return compact(identity.identifiers?.mpn);
}

function canonicalIdentity(identity) {
  return {
    ...Object.fromEntries(ALL_FIELDS.map((field) => [field, normalizedField(field, identity[field])])),
    identifiers: { trade_item_code: tradeCode(identity), mpn: mpn(identity) || null },
    bundle_contents: (identity.bundle_contents || []).map(text).filter(Boolean).sort(),
    compatibility_keys: (identity.compatibility_keys || []).map(compact).filter(Boolean).sort(),
  };
}

export function canonicalizeProductIdentity(identity = {}) {
  return canonicalIdentity(identity);
}

function mismatchClass(field) {
  if (field === "edition") return "different_edition";
  if (field === "generation") return "different_generation";
  if (field === "condition") return "different_condition";
  if (field === "bundle_count" || field === "bundle_contents") return "different_bundle";
  if (VARIANT_FIELDS.includes(field)) return "different_variant";
  return "different_product";
}

export function validateIdentityResolution({ artifact, offer, evaluated_at = Date.now(), max_age_seconds = 3_600 }) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  if (!verifyShoppingArtifactAttestation("identity", artifact)) return null;
  if (!artifact?.evaluated_at || !artifact.target_product_id || !Array.isArray(artifact.resolutions) || !Number.isFinite(evaluatedAt)) return null;
  const artifactAt = Date.parse(artifact.evaluated_at);
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > max_age_seconds * 1_000) return null;
  if (!same(artifact.target_product_id, offer?.product_key)) return null;
  const resolution = artifact.resolutions.find((candidate) => same(candidate?.candidate_id, offer?.id));
  if (!resolution || resolution.classification !== "exact_match" || resolution.safe_to_compare_offers !== true) return null;
  if (offer?.variant != null && (!resolution.offer_variant || !same(resolution.offer_variant, offer.variant))) return null;
  if (!resolution.canonical?.condition || !same(resolution.canonical.condition, offer?.condition || "new")) return null;
  return resolution;
}

export function resolveProductIdentities({ target = {}, target_product_id = null, candidates = [], required_fields = null, flexible_fields = [], mode = "exact_product", evaluated_at = null }) {
  const required = (required_fields || ALL_FIELDS.filter((field) => target[field] != null && target[field] !== ""))
    .filter((field) => !flexible_fields.includes(field));
  const canonicalTarget = canonicalIdentity(target);
  const targetCompatibility = compact(target.compatibility_key);

  const resolutions = candidates.map((candidate) => {
    const canonical = canonicalIdentity(candidate);
    const reasons = [];
    const identifier_matches = [];
    const identifier_conflicts = [];
    if (canonicalTarget.identifiers.trade_item_code && canonical.identifiers.trade_item_code) {
      (canonicalTarget.identifiers.trade_item_code === canonical.identifiers.trade_item_code ? identifier_matches : identifier_conflicts).push("trade_item_code");
    }
    if (canonicalTarget.identifiers.mpn && canonical.identifiers.mpn) {
      (canonicalTarget.identifiers.mpn === canonical.identifiers.mpn ? identifier_matches : identifier_conflicts).push("mpn");
    }
    if (identifier_conflicts.length) {
      return { candidate_id: candidate.id, offer_variant: candidate.offer_variant ?? null, classification: "identity_conflict", safe_to_compare_offers: false, confidence: 1, matched_fields: [], missing_fields: [], mismatched_fields: [], identifier_matches, identifier_conflicts, reasons: [`Conflicting stable identifiers: ${identifier_conflicts.join(", ")}.`], canonical };
    }

    const missing_fields = required.filter((field) => candidate[field] == null || candidate[field] === "");
    const mismatched_fields = required.filter((field) => !missing_fields.includes(field) && !fieldEqual(field, target[field], candidate[field]));
    const matched_fields = required.filter((field) => !missing_fields.includes(field) && !mismatched_fields.includes(field));

    const targetBundle = canonicalTarget.bundle_contents;
    const candidateBundle = canonical.bundle_contents;
    if (targetBundle.length && !candidateBundle.length) missing_fields.push("bundle_contents");
    else if (targetBundle.length && JSON.stringify(targetBundle) !== JSON.stringify(candidateBundle)) mismatched_fields.push("bundle_contents");

    if (mismatched_fields.length) {
      const priority = ["edition", "generation", "condition", "bundle_count", "bundle_contents", ...CORE_FIELDS, ...VARIANT_FIELDS];
      const decisive = priority.find((field) => mismatched_fields.includes(field)) || mismatched_fields[0];
      if (mode === "compatible_part" && targetCompatibility && canonical.compatibility_keys.includes(targetCompatibility) && ["brand", "product_line", "model"].includes(decisive)) {
        return { candidate_id: candidate.id, offer_variant: candidate.offer_variant ?? null, classification: "compatible_alternative", safe_to_compare_offers: false, confidence: 0.8, matched_fields, missing_fields, mismatched_fields, identifier_matches, identifier_conflicts, reasons: ["Compatibility is explicit, but product identity differs; user acceptance is required."], canonical };
      }
      reasons.push(`${decisive} does not match the requested identity.`);
      return { candidate_id: candidate.id, offer_variant: candidate.offer_variant ?? null, classification: mismatchClass(decisive), safe_to_compare_offers: false, confidence: 1, matched_fields, missing_fields, mismatched_fields: [...new Set(mismatched_fields)], identifier_matches, identifier_conflicts, reasons, canonical };
    }

    if (missing_fields.length) {
      return { candidate_id: candidate.id, offer_variant: candidate.offer_variant ?? null, classification: "insufficient_evidence", safe_to_compare_offers: false, confidence: Math.min(0.5, matched_fields.length / Math.max(1, required.length)), matched_fields, missing_fields, mismatched_fields: [], identifier_matches, identifier_conflicts, reasons: [`Missing required identity fields: ${missing_fields.join(", ")}.`], canonical };
    }

    return { candidate_id: candidate.id, offer_variant: candidate.offer_variant ?? null, classification: "exact_match", safe_to_compare_offers: true, confidence: identifier_matches.length ? 1 : Math.min(0.95, 0.75 + required.length * 0.03), matched_fields, missing_fields: [], mismatched_fields: [], identifier_matches, identifier_conflicts, reasons: [identifier_matches.length ? `Stable identifier match: ${identifier_matches.join(", ")}.` : "All required identity fields match exactly after normalization."], canonical };
  });
  return attestShoppingArtifact("identity", { evaluated_at: new Date(evaluated_at || Date.now()).toISOString(), target_product_id, product_category: productCategory(target.product_category), canonical_target: canonicalTarget, required_fields: required, flexible_fields, resolutions });
}
