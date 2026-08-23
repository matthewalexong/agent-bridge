import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { assessCounterfeitRisk } from "./shopping-counterfeit.mjs";

const same = (left, right) => String(left ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  === String(right ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function evaluatedMillis(value) {
  const result = value == null ? Date.now() : Date.parse(value);
  if (!Number.isFinite(result)) throw coded("Counterfeit evaluation time is invalid", "shopping_counterfeit_evidence_invalid");
  return result;
}

function validatePageEvidence(artifact, { evaluated_at, max_age_seconds, kinds, required = true } = {}) {
  if (artifact == null && !required) return null;
  if (!verifyShoppingArtifactAttestation("page_evidence", artifact)
    || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)) {
    throw coded("Counterfeit facts require an untampered shopping_page_evidence artifact", "shopping_counterfeit_page_evidence_invalid");
  }
  if (!kinds.includes(artifact?.source?.page_kind)) {
    throw coded(`Unexpected page evidence kind: ${artifact?.source?.page_kind || "missing"}`, "shopping_counterfeit_page_evidence_scope");
  }
  const captured = Date.parse(artifact.source?.captured_at || "");
  const receiptCaptured = Date.parse(artifact.source_receipt?.captured_at || "");
  const evaluated = evaluatedMillis(evaluated_at);
  if (!Number.isFinite(captured) || captured !== receiptCaptured
    || artifact.source?.url !== artifact.source_receipt?.url
    || artifact.source_receipt?.source_id !== artifact.source_receipt?.snapshot_id
    || captured > evaluated + 5_000 || evaluated - captured > max_age_seconds * 1_000) {
    throw coded("Counterfeit page evidence is stale or has inconsistent provenance", "shopping_counterfeit_page_evidence_stale");
  }
  return artifact;
}

function explicit(fact) {
  return fact?.status === "explicit" ? fact.value : null;
}

function deriveAuthorization(artifact, seller) {
  if (!artifact) return { status: "unknown", evidence_status: "unknown" };
  if (!same(artifact.extraction_scope?.seller_query, seller)) {
    throw coded("Authorized-seller evidence is scoped to a different seller", "shopping_counterfeit_page_evidence_scope");
  }
  const authorization = artifact.facts?.authorization;
  if (authorization?.value === "explicit_match" && authorization.status === "explicit") {
    return { status: "authorized", evidence_status: "verified" };
  }
  if (authorization?.value === "no_match" && authorization.status === "derived" && artifact.extraction_scope?.directory_complete === true) {
    return { status: "unauthorized", evidence_status: "verified" };
  }
  return { status: "unknown", evidence_status: "unknown" };
}

function deriveWarranty(listing, warrantyPage) {
  const values = [warrantyPage, listing]
    .map((artifact) => explicit(artifact?.facts?.manufacturer_warranty))
    .filter((value) => typeof value === "boolean");
  if (!values.length) return { applies: null, evidence_status: "unknown" };
  if (new Set(values).size > 1) return { applies: null, evidence_status: "conflict" };
  return { applies: values[0], evidence_status: "verified" };
}

function deriveLandedPrice(listing) {
  const price = explicit(listing.facts?.price_usd);
  const shipping = explicit(listing.facts?.shipping_usd);
  if (!Number.isFinite(price) || !Number.isFinite(shipping)) return { landed_total_usd: null, landed_price_verified: false };
  return { landed_total_usd: Math.round((price + shipping) * 100) / 100, landed_price_verified: true };
}

function deriveAvailability(listing) {
  const stock = explicit(listing.facts?.stock);
  return ["in_stock", "out_of_stock"].includes(stock)
    ? { status: stock, evidence_status: "verified" }
    : { status: "unknown", evidence_status: "unknown" };
}

function resolveIdentity(identity, offerId, evaluatedAt, maxAgeSeconds) {
  if (!verifyShoppingArtifactAttestation("identity", identity)) {
    throw coded("Counterfeit assessment requires an untampered identity artifact", "shopping_counterfeit_identity_invalid");
  }
  const artifactAt = Date.parse(identity.evaluated_at || "");
  if (!Number.isFinite(artifactAt) || artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > maxAgeSeconds * 1_000) {
    throw coded("Counterfeit identity evidence is stale", "shopping_counterfeit_identity_stale");
  }
  const resolution = identity.resolutions?.find((item) => same(item?.candidate_id, offerId));
  if (!resolution) throw coded("Identity artifact does not cover the counterfeit offer", "shopping_counterfeit_identity_scope");
  return resolution;
}

export function assessCounterfeitRiskFromEvidence(input) {
  const evaluatedAt = evaluatedMillis(input.evaluated_at);
  const evaluatedIso = new Date(evaluatedAt).toISOString();
  const maxPageAge = input.max_page_evidence_age_seconds ?? 300;
  const maxIdentityAge = input.max_identity_age_seconds ?? 3_600;
  const offers = (input.offers || []).map((offer) => {
    const listing = validatePageEvidence(offer.listing_evidence, {
      evaluated_at: evaluatedIso,
      max_age_seconds: maxPageAge,
      kinds: ["retailer_listing"],
    });
    const authorizationPage = validatePageEvidence(offer.authorization_evidence, {
      evaluated_at: evaluatedIso,
      max_age_seconds: maxPageAge,
      kinds: ["manufacturer_authorized_sellers"],
      required: false,
    });
    const warrantyPage = validatePageEvidence(offer.warranty_evidence, {
      evaluated_at: evaluatedIso,
      max_age_seconds: maxPageAge,
      kinds: ["manufacturer_warranty"],
      required: false,
    });
    const seller = explicit(listing.facts?.seller);
    if (typeof seller !== "string" || !seller.trim()) {
      throw coded("The signed listing does not expose a seller; take a seller-visible snapshot", "shopping_counterfeit_seller_unresolved");
    }
    const identity = resolveIdentity(input.identity, offer.id, evaluatedAt, maxIdentityAge);
    const exactProduct = identity.classification === "exact_match" && identity.safe_to_compare_offers === true;
    const condition = ["new", "used", "open_box", "refurbished"].includes(identity.canonical?.condition)
      ? identity.canonical.condition : "new";
    const returnDays = explicit(listing.facts?.return_days);
    return {
      id: offer.id,
      product_id: input.identity.target_product_id,
      variant: identity.offer_variant ?? null,
      seller,
      ...deriveLandedPrice(listing),
      availability: deriveAvailability(listing),
      exact_product: exactProduct,
      authorization: deriveAuthorization(authorizationPage, seller),
      warranty: deriveWarranty(listing, warrantyPage),
      identifiers: { conflict: null, evidence_status: "unknown" },
      packaging_signals: [],
      complaints: [],
      sold_by_platform: null,
      fulfilled_by_platform: null,
      gray_market_disclosed: false,
      user_accepts_gray_market: false,
      returnable: Number.isInteger(returnDays) ? returnDays > 0 : null,
      condition,
    };
  });
  return assessCounterfeitRisk({
    evaluated_at: evaluatedIso,
    category: input.category,
    requirements: input.requirements || {},
    authorized_market_median_usd: null,
    authorized_market_median_verified: false,
    offers,
  });
}
