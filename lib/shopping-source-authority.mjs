const REGISTRY = Object.freeze({
  CPSC: Object.freeze({ authority_id: "CPSC", authority_type: "regulator", jurisdictions: ["US"], domains: ["cpsc.gov"] }),
  FDA: Object.freeze({ authority_id: "FDA", authority_type: "regulator", jurisdictions: ["US"], domains: ["fda.gov"] }),
  NHTSA: Object.freeze({ authority_id: "NHTSA", authority_type: "regulator", jurisdictions: ["US"], domains: ["nhtsa.gov"] }),
  UL: Object.freeze({ authority_id: "UL", authority_type: "certification_body", jurisdictions: ["US", "CA"], domains: ["ul.com"] }),
});

const normalized = (value) => String(value ?? "").trim().toUpperCase();
const category = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const US_CATEGORY_POLICY = Object.freeze([
  Object.freeze({
    id: "us_nhtsa_vehicle_products_v1",
    pattern: /(?:^|_)(?:vehicle|vehicles|automotive|automobile|car|cars|truck|trucks|motorcycle|motorcycles|trailer|trailers|tire|tires|car_seat|car_seats|vehicle_equipment|vehicle_part|vehicle_parts)(?:_|$)/,
    authorities: ["NHTSA"],
  }),
  Object.freeze({
    id: "us_fda_health_and_ingestible_products_v1",
    pattern: /(?:^|_)(?:food|foods|beverage|beverages|drink|drinks|dietary_supplement|dietary_supplements|supplement|supplements|drug|drugs|medicine|medicines|pharmaceutical|pharmaceuticals|medical_device|medical_devices|diagnostic|diagnostics|cosmetic|cosmetics|tobacco|pet_food)(?:_|$)/,
    authorities: ["FDA"],
  }),
  Object.freeze({
    id: "us_dual_health_consumer_products_v1",
    pattern: /(?:^|_)(?:health_device|health_devices|wellness_device|wellness_devices)(?:_|$)/,
    authorities: ["FDA", "CPSC"],
  }),
]);

const UNRESOLVED_CATEGORIES = new Set(["", "unknown", "other", "general", "misc", "miscellaneous", "product", "products"]);

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; }
}

function domainMatch(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function listShoppingSourceAuthorities() {
  return Object.values(REGISTRY).map((entry) => structuredClone(entry));
}

export function resolveShoppingSourceAuthority({ authority_id, url, jurisdiction = null, authority_type = null }) {
  const entry = REGISTRY[normalized(authority_id)];
  const host = hostname(url);
  if (!entry || !host || !entry.domains.some((domain) => domainMatch(host, domain))) return null;
  if (jurisdiction && !entry.jurisdictions.includes(normalized(jurisdiction))) return null;
  if (authority_type && entry.authority_type !== authority_type) return null;
  return { ...structuredClone(entry), matched_hostname: host };
}

export function resolveRequiredShoppingSafetyAuthorities({ jurisdiction, product_category }) {
  const country = normalized(jurisdiction);
  const normalizedCategory = category(product_category);
  if (country !== "US") return { status: "unresolved", policy_id: null, jurisdiction: country, product_category: normalizedCategory, authorities: [], reason: "jurisdiction_policy_not_registered" };
  if (UNRESOLVED_CATEGORIES.has(normalizedCategory)) return { status: "unresolved", policy_id: null, jurisdiction: country, product_category: normalizedCategory, authorities: [], reason: "product_category_too_broad" };
  const matches = US_CATEGORY_POLICY.filter((rule) => rule.pattern.test(normalizedCategory));
  if (matches.length) {
    return { status: "resolved", policy_id: matches.map((rule) => rule.id).sort().join("+"), jurisdiction: country, product_category: normalizedCategory, authorities: [...new Set(matches.flatMap((rule) => rule.authorities))].sort(), reason: null };
  }
  return { status: "resolved", policy_id: "us_cpsc_general_consumer_products_v1", jurisdiction: country, product_category: normalizedCategory, authorities: ["CPSC"], reason: null };
}
