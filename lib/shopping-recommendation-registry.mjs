import crypto from "node:crypto";
import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function candidateId(dossier) {
  if (dossier?.phase === "product_recommendation" && dossier?.decision?.action === "recommend_product") return dossier.decision.selected_product;
  if (dossier?.phase === "offer_recommendation" && dossier?.decision?.action === "recommend_offer") return dossier.decision.selected_offer;
  return null;
}

function eligible(dossier) {
  const decision = dossier?.decision || {};
  const candidate_id = candidateId(dossier);
  return /^listing_[a-f0-9]{16}$/.test(String(candidate_id || ""))
    && typeof dossier?.dossier_id === "string"
    && [decision.blockers, decision.research, decision.clarifications].every((items) => Array.isArray(items) && items.length === 0)
    && decision.purchase_allowed === false
    && decision.model_override_allowed === false;
}

function explicitFact(artifact, name) {
  const fact = artifact?.facts?.[name];
  return fact && ["explicit", "derived"].includes(fact.status) ? fact.value : null;
}

function offerFacts(offer) {
  const evidence = offer.listing_evidence;
  const price = explicitFact(evidence, "price_usd");
  const seller = explicitFact(evidence, "seller");
  const stock = explicitFact(evidence, "stock");
  return {
    evidence_attestation: evidence.artifact_attestation,
    item_price_usd: Number.isFinite(price) && price >= 0 ? Number(price) : null,
    seller: typeof seller === "string" && seller.trim() ? seller.trim().replace(/\s+/g, " ").slice(0, 120) : null,
    stock: ["in_stock", "out_of_stock"].includes(stock) ? stock : "unknown",
  };
}

function recommendationSummary(candidate_id, facts, stages = {}) {
  const landed = stages.offer?.landed_price_verified === true && Number.isFinite(stages.offer?.landed_total_usd)
    ? Number(stages.offer.landed_total_usd)
    : null;
  const evidence_links = ["safety", "counterfeit", "protection", "fulfillment"]
    .flatMap((stage) => stages[stage]?.evidence_links || [])
    .filter((link, index, all) => link?.url && all.findIndex((item) => item.kind === link.kind && item.url === link.url) === index);
  return {
    candidate_id,
    landed_total_usd: landed,
    item_price_usd: facts.item_price_usd,
    seller: facts.seller,
    stock: facts.stock !== "unknown" ? facts.stock : stages.offer?.stock === "in_stock" ? "in_stock" : "unknown",
    exact_identity: stages.identity?.classification === "exact_match" && stages.identity?.safe_to_compare_offers === true,
    safety_cleared: stages.safety?.action === "eligible" && stages.safety?.safety_cleared_for_ranking === true,
    counterfeit_risk: ["low", "acceptable"].includes(stages.counterfeit?.risk_status) ? stages.counterfeit.risk_status : null,
    seller_authorization_verified: stages.counterfeit?.authorization_requirement_status === "satisfied",
    protection_requirements_met: stages.protection?.status === "eligible",
    return_window_days: Number.isInteger(stages.protection?.return_window_days) ? stages.protection.return_window_days : null,
    warranty_duration_months: Number.isInteger(stages.protection?.warranty_duration_months) ? stages.protection.warranty_duration_months : null,
    buyer_protection_days: Number.isInteger(stages.protection?.buyer_protection_days) ? stages.protection.buyer_protection_days : null,
    delivery_earliest_at: stages.fulfillment?.delivery_earliest_at || null,
    delivery_latest_at: stages.fulfillment?.delivery_latest_at || null,
    tracking_available: stages.fulfillment?.tracking_available ?? null,
    evidence_links,
  };
}

function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

function shortDate(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(parsed) : null;
}

export function formatShoppingRecommendationSummary(summaries) {
  const lines = (summaries || []).map((summary, index) => {
    const details = [];
    if (Number.isFinite(summary?.landed_total_usd)) details.push(`${money(summary.landed_total_usd)} landed total`);
    else if (Number.isFinite(summary?.item_price_usd)) details.push(`${money(summary.item_price_usd)} item price`);
    if (summary?.seller) details.push(`sold by ${summary.seller}`);
    details.push(summary?.stock === "in_stock" ? "in stock" : "availability unknown");
    const earliest = shortDate(summary?.delivery_earliest_at);
    const latest = shortDate(summary?.delivery_latest_at);
    if (earliest && latest) details.push(earliest === latest ? `delivery ${latest}` : `delivery ${earliest}–${latest}`);
    if (Number.isInteger(summary?.return_window_days)) details.push(`${summary.return_window_days}-day returns`);
    if (Number.isInteger(summary?.warranty_duration_months)) details.push(`${summary.warranty_duration_months}-month warranty`);
    if (Number.isInteger(summary?.buyer_protection_days)) details.push(`${summary.buyer_protection_days}-day buyer protection`);
    if (summary?.tracking_available === true) details.push("tracking available");
    if (summary?.exact_identity) details.push("exact identity matched");
    if (summary?.safety_cleared) details.push("safety checks cleared");
    if (summary?.counterfeit_risk) details.push(`counterfeit risk ${summary.counterfeit_risk}`);
    if (summary?.seller_authorization_verified) details.push("seller authorization verified");
    if (summary?.protection_requirements_met) details.push("protection requirements met");
    return `${summaries.length > 1 ? `Card ${index + 1} — ` : ""}${details.slice(0, 12).join(" · ")}`;
  }).filter((line) => line && !/^(Card \d+ — )?$/.test(line));
  return lines.length ? `Verified details: ${lines.join("\n")}` : "";
}

export function appendShoppingRecommendationSummary(text, summaries, max_chars = 20_000) {
  const suffix = formatShoppingRecommendationSummary(summaries);
  if (!suffix) return String(text || "");
  if (suffix.length >= max_chars) return `${suffix.slice(0, Math.max(0, max_chars - 1)).trimEnd()}…`;
  const separator = "\n\n";
  const budget = Math.max(0, max_chars - suffix.length - separator.length);
  const original = String(text || "");
  const prefix = original.length <= budget ? original : `${original.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
  return `${prefix}${separator}${suffix}`.slice(0, max_chars);
}

export function shoppingRecommendationCardDetails(summary) {
  const protections = [];
  if (Number.isInteger(summary?.return_window_days)) protections.push(`${summary.return_window_days}-day returns`);
  if (Number.isInteger(summary?.warranty_duration_months)) protections.push(`${summary.warranty_duration_months}-month warranty`);
  if (Number.isInteger(summary?.buyer_protection_days)) protections.push(`${summary.buyer_protection_days}-day buyer protection`);
  const checks = [];
  if (summary?.exact_identity) checks.push("Exact item");
  if (summary?.safety_cleared) checks.push("Safety checked");
  if (summary?.seller_authorization_verified) checks.push("Authorized seller");
  else if (summary?.counterfeit_risk === "low") checks.push("Low counterfeit risk");
  const earliest = shortDate(summary?.delivery_earliest_at);
  const latest = shortDate(summary?.delivery_latest_at);
  return {
    verification: "Verified pick",
    ...(Number.isFinite(summary?.landed_total_usd) ? { landed_total: money(summary.landed_total_usd) } : {}),
    ...(earliest && latest ? { delivery: earliest === latest ? `Delivery ${latest}` : `Delivery ${earliest}–${latest}` } : {}),
    ...(protections.length ? { protections: protections.slice(0, 3) } : {}),
    ...(checks.length ? { checks: checks.slice(0, 3) } : {}),
  };
}

const EVIDENCE_TITLES = Object.freeze({
  safety_authority: "Evidence · Official safety search",
  safety_notice: "Evidence · Official safety notice",
  certification: "Evidence · Certification record",
  safety_remediation: "Evidence · Safety remediation",
  authorization: "Evidence · Authorized seller directory",
  return_policy: "Evidence · Return policy",
  warranty: "Evidence · Warranty policy",
  repairability: "Evidence · Repairability information",
});

const EVIDENCE_PRIORITY = Object.freeze(["safety_notice", "safety_authority", "authorization", "return_policy", "warranty", "certification", "safety_remediation", "repairability"]);

export function shoppingRecommendationEvidenceCards(summaries, max_cards = 4) {
  const priority = new Map(EVIDENCE_PRIORITY.map((kind, index) => [kind, index]));
  const links = (summaries || []).flatMap((summary) => summary?.evidence_links || [])
    .filter((link) => EVIDENCE_TITLES[link?.kind] && typeof link.url === "string")
    .filter((link, index, all) => all.findIndex((item) => item.url === link.url) === index)
    .sort((left, right) => (priority.get(left.kind) ?? 999) - (priority.get(right.kind) ?? 999));
  return links.slice(0, Math.max(0, max_cards)).map((link) => ({ url: link.url, title: EVIDENCE_TITLES[link.kind] }));
}

export function createShoppingRecommendationRegistry({ max_entries = 128, max_age_ms = 15 * 60 * 1_000, now = () => Date.now() } = {}) {
  if (!Number.isInteger(max_entries) || max_entries < 1 || max_entries > 1_024 || !Number.isInteger(max_age_ms) || max_age_ms < 10_000 || max_age_ms > 3_600_000) {
    throw coded("Recommendation registry bounds are invalid", "shopping_recommendation_registry_invalid");
  }
  const entries = new Map();
  const contexts = new Map();

  function bindCandidateOffers(context_id, artifact) {
    const contextId = String(context_id || "");
    const offers = artifact?.offers;
    const current = now();
    const evaluatedAt = Date.parse(artifact?.evaluated_at || "");
    if (!contextId || !verifyShoppingArtifactAttestation("candidate_offers", artifact)
      || !/^cset_[a-f0-9]{24}$/.test(String(artifact?.candidate_set_id || ""))
      || !Array.isArray(offers) || offers.length < 1 || offers.length > 5
      || new Set(offers.map((offer) => offer?.candidate_id)).size !== offers.length
      || offers.some((offer) => !/^listing_[a-f0-9]{16}$/.test(String(offer?.candidate_id || ""))
        || !verifyShoppingArtifactAttestation("page_evidence", offer?.listing_evidence))
      || !Number.isFinite(evaluatedAt) || evaluatedAt > current + 300_000 || current - evaluatedAt > max_age_ms) {
      throw coded("Recommendation evidence requires fresh signed exact candidate offers", "shopping_recommendation_offer_binding_invalid");
    }
    const prior = contexts.get(contextId);
    if (prior && prior.artifact_attestation !== artifact.artifact_attestation) {
      throw coded("A decision context cannot mix different exact candidate-offer evidence", "shopping_recommendation_offer_binding_conflict");
    }
    const binding = {
      stored_at: current,
      artifact_attestation: artifact.artifact_attestation,
      candidate_set_id: artifact.candidate_set_id,
      offers: new Map(offers.map((offer) => [offer.candidate_id, offerFacts(offer)])),
    };
    contexts.delete(contextId);
    contexts.set(contextId, binding);
    while (contexts.size > max_entries) contexts.delete(contexts.keys().next().value);
    return true;
  }

  function store(dossier, stages = {}) {
    if (!eligible(dossier)) return null;
    const evaluatedAt = Date.parse(dossier.evaluated_at || "");
    const current = now();
    if (!Number.isFinite(evaluatedAt) || evaluatedAt > current + 300_000 || current - evaluatedAt > max_age_ms) return null;
    const candidate_id = candidateId(dossier);
    const context = contexts.get(String(dossier?.decision_context_id || ""));
    const facts = context?.offers.get(candidate_id);
    if (!context || current - context.stored_at > max_age_ms || !facts) return null;
    if (!Number.isFinite(facts.item_price_usd) || !facts.seller || facts.stock !== "in_stock") return null;
    const recommendation_id = `shopping_recommendation_${crypto.randomBytes(16).toString("hex")}`;
    const reference = { recommendation_id, dossier_id: dossier.dossier_id, phase: dossier.phase, candidate_id };
    entries.set(recommendation_id, { issued_at: current, reference, binding: {
      candidate_set_id: context.candidate_set_id,
      candidate_id,
      evidence_attestation: facts.evidence_attestation,
      candidate_offers_attestation: context.artifact_attestation,
    }, summary: recommendationSummary(candidate_id, facts, stages) });
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return structuredClone(reference);
  }

  function authorize(reference, candidate_id, card_binding) {
    const entry = entries.get(String(reference?.recommendation_id || ""));
    if (!entry) throw coded("Recommendation reference is unknown in this process; rerun final dossier composition", "shopping_recommendation_reference_unknown");
    if (JSON.stringify(reference) !== JSON.stringify(entry.reference) || candidate_id !== entry.reference.candidate_id) {
      throw coded("Recommendation reference is altered or selects a different candidate", "shopping_recommendation_reference_mismatch");
    }
    if (JSON.stringify(card_binding) !== JSON.stringify(entry.binding)) {
      throw coded("Verified card evidence differs from the final dossier evidence", "shopping_recommendation_card_evidence_mismatch");
    }
    if (now() - entry.issued_at > max_age_ms) {
      entries.delete(entry.reference.recommendation_id);
      throw coded("Recommendation reference expired; refresh final evidence and dossier", "shopping_recommendation_reference_expired");
    }
    entries.delete(entry.reference.recommendation_id);
    entries.set(entry.reference.recommendation_id, entry);
    return structuredClone(entry.summary);
  }

  return { bindCandidateOffers, store, authorize };
}
