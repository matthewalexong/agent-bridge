import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { writePrivateJsonAtomic } from "./auth-token.mjs";
import { bridgeDirectory } from "./config.mjs";
import { analyzeDealQuality } from "./shopping-deal-quality.mjs";
import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { verifyShoppingDossierStage } from "./shopping-dossier-stage.mjs";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OBSERVATIONS = 10_000;
const DEFAULT_MAX_PER_SCOPE = 365;
const DEFAULT_MAX_AGE_DAYS = 730;

const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const finiteMoney = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000_000;
const money = (value) => Math.round(value * 100) / 100;

function coded(message, code = "shopping_price_history_invalid") {
  return Object.assign(new Error(message), { code });
}

function historyFile(env) {
  return path.join(bridgeDirectory(env), "shopping-price-history.json");
}

function emptyState() {
  return { schema_version: SCHEMA_VERSION, revision: 0, observations: [] };
}

function validObservation(item) {
  return item && /^price_[a-f0-9]{32}$/.test(String(item.observation_id || ""))
    && clean(item.product_key) && clean(item.offer_id)
    && (item.variant == null || typeof item.variant === "string")
    && (item.condition == null || typeof item.condition === "string")
    && /^[A-Z]{3}$/.test(String(item.currency || ""))
    && finiteMoney(item.landed_total_usd)
    && Number.isFinite(Date.parse(item.observed_at || ""))
    && item.source?.source_type === "retailer"
    && clean(item.source?.id)
    && clean(item.source?.independence_key)
    && /^v1\.candidate_offers\.[a-f0-9]{64}$/.test(String(item.evidence?.candidate_offers_attestation || ""))
    && /^v1\.page_evidence\.[a-f0-9]{64}$/.test(String(item.evidence?.listing_evidence_attestation || ""))
    && /^v1\.dossier_stage\.[a-f0-9]{64}$/.test(String(item.evidence?.offer_stage_attestation || ""))
    && /^v1\.dossier_stage\.[a-f0-9]{64}$/.test(String(item.evidence?.fulfillment_stage_attestation || ""));
}

function validateState(state, maxObservations) {
  if (state?.schema_version !== SCHEMA_VERSION || !Number.isInteger(state?.revision) || state.revision < 0
    || !Array.isArray(state?.observations) || state.observations.length > maxObservations
    || !state.observations.every(validObservation)) {
    throw coded("Shopping price-history file is invalid");
  }
  return state;
}

async function prepareDirectory(env) {
  const directory = bridgeDirectory(env);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  return directory;
}

async function readState(env, maxObservations) {
  const target = historyFile(env);
  let stat;
  try { stat = await fs.lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    throw coded("Shopping price-history path is not a safe bounded regular file");
  }
  if (process.platform !== "win32") await fs.chmod(target, 0o600);
  return validateState(JSON.parse(await fs.readFile(target, "utf8")), maxObservations);
}

async function withLock(env, maxObservations, callback) {
  const directory = await prepareDirectory(env);
  const lockPath = path.join(directory, "shopping-price-history.lock");
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try { handle = await fs.open(lockPath, "wx", 0o600); } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) throw coded("Could not acquire the shopping price-history update lock", "shopping_price_history_lock_failed");
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.rm(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    const state = await readState(env, maxObservations);
    const result = await callback(state);
    if (result.write !== false) {
      state.revision += 1;
      await writePrivateJsonAtomic(historyFile(env), state);
    }
    return result.value;
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}

function exactVerifiedTotal(stages) {
  const offer = stages.offer;
  const fulfillment = stages.fulfillment;
  const range = fulfillment?.fully_landed_total_usd;
  if (offer?.landed_price_verified !== true || !finiteMoney(offer?.landed_total_usd)
    || fulfillment?.fully_landed_status !== "verified" || fulfillment?.safe_for_offer_comparison !== true
    || fulfillment?.action !== "eligible" || !range
    || ![range.low_usd, range.expected_usd, range.high_usd].every(finiteMoney)
    || range.low_usd !== range.expected_usd || range.expected_usd !== range.high_usd
    || Math.abs(range.expected_usd - offer.landed_total_usd) > 0.01) return null;
  return money(offer.landed_total_usd);
}

function explicitFactValue(fact) {
  return fact?.status === "explicit" && fact.value != null ? clean(fact.value) : null;
}

function listingScope(listing, deal) {
  const identity = listing?.facts?.identity || {};
  const observedValues = new Set(Object.values(identity).flatMap((fact) => {
    const value = explicitFactValue(fact);
    return value ? [value] : [];
  }));
  const requestedVariant = clean(deal?.current_variant) || null;
  const observedCondition = explicitFactValue(identity.condition || listing?.facts?.condition);
  const requestedCondition = clean(deal?.current_condition) || null;
  if (requestedVariant && !observedValues.has(requestedVariant)) return null;
  if (requestedCondition && observedCondition !== requestedCondition) return null;
  return { variant: requestedVariant, condition: requestedCondition || observedCondition };
}

function candidateFor(candidateOffers, offerId) {
  if (!verifyShoppingArtifactAttestation("candidate_offers", candidateOffers)) return null;
  const matches = (candidateOffers.offers || []).filter((item) => item?.candidate_id === offerId && verifyShoppingArtifactAttestation("page_evidence", item?.listing_evidence));
  return matches.length === 1 ? matches[0] : null;
}

function safeRecordInput({ dossier, stages, candidate_offers }) {
  if (dossier?.phase !== "offer_recommendation" || !clean(dossier?.product_id) || !clean(dossier?.offer_id)) return null;
  if ((dossier?.decision?.blockers || []).length || (dossier?.decision?.clarifications || []).length) return null;
  if ((dossier?.decision?.research || []).some((item) => item !== "deal:research_more")) return null;
  const required = ["identity", "merchant", "counterfeit", "protection", "fulfillment", "offer", "deal"];
  if (!required.every((name) => verifyShoppingDossierStage(name, stages?.[name], dossier.decision_context_id))) return null;
  const { identity, merchant, counterfeit, protection, fulfillment, offer, deal } = stages;
  const sameScope = required.every((name) => stages[name].product_id === dossier.product_id && stages[name].offer_id === dossier.offer_id);
  const total = exactVerifiedTotal(stages);
  if (!sameScope || total == null || identity.classification !== "exact_match" || identity.safe_to_compare_offers !== true
    || merchant.purchase_gate !== "eligible_for_other_shopping_checks"
    || !["low", "acceptable"].includes(counterfeit.risk_status)
    || !["not_required", "satisfied"].includes(counterfeit.authorization_requirement_status)
    || counterfeit.purchase_gate !== "eligible_for_other_shopping_checks"
    || protection.status !== "eligible" || offer.action !== "select" || offer.selected_offer !== dossier.offer_id || offer.stock !== "in_stock"
    || deal.current_landed_price_verified !== true || deal.current_exact_identity !== true || deal.current_stock !== "in_stock"
    || deal.current_risk_status !== counterfeit.risk_status || Math.abs(deal.current_landed_total_usd - total) > 0.01) return null;
  const candidate = candidateFor(candidate_offers, dossier.offer_id);
  if (!candidate) return null;
  const scope = listingScope(candidate.listing_evidence, deal);
  if (!scope) return null;
  const observedAt = new Date(Math.max(Date.parse(offer.evaluated_at), Date.parse(fulfillment.evaluated_at), Date.parse(candidate.listing_evidence.source?.captured_at || 0))).toISOString();
  let url = null;
  let independenceKey = clean(dossier.offer_id);
  try {
    const parsed = new URL(candidate.listing_evidence.source?.url);
    if (["http:", "https:"].includes(parsed.protocol)) {
      independenceKey = parsed.hostname.toLowerCase().replace(/^www\./, "");
      parsed.search = "";
      parsed.hash = "";
      url = parsed.toString();
    }
  } catch {}
  const identityPayload = { product_key: dossier.product_id, offer_id: dossier.offer_id, variant: scope.variant, condition: scope.condition, currency: deal.current_currency, landed_total_usd: total, observed_at: observedAt, listing_attestation: candidate.listing_evidence.artifact_attestation };
  const observationId = `price_${crypto.createHash("sha256").update(JSON.stringify(identityPayload)).digest("hex").slice(0, 32)}`;
  return {
    observation_id: observationId,
    product_key: dossier.product_id,
    offer_id: dossier.offer_id,
    variant: scope.variant,
    condition: scope.condition,
    currency: deal.current_currency,
    landed_total_usd: total,
    observed_at: observedAt,
    source: { id: `signed-${dossier.offer_id}`, source_type: "retailer", ...(url ? { url } : {}), independence_key: independenceKey },
    evidence: {
      candidate_offers_attestation: candidate_offers.artifact_attestation,
      listing_evidence_attestation: candidate.listing_evidence.artifact_attestation,
      offer_stage_attestation: offer.artifact_attestation,
      fulfillment_stage_attestation: fulfillment.artifact_attestation,
    },
  };
}

function publicObservation(item) {
  return {
    product_key: item.product_key,
    ...(item.variant ? { variant: item.variant } : {}),
    ...(item.condition ? { condition: item.condition } : {}),
    currency: item.currency,
    landed_total_usd: item.landed_total_usd,
    verified: true,
    observed_at: item.observed_at,
    source: item.source,
  };
}

export function createShoppingPriceHistoryLedger({ env = process.env, clock = Date.now, max_observations = DEFAULT_MAX_OBSERVATIONS, max_per_scope = DEFAULT_MAX_PER_SCOPE, max_age_days = DEFAULT_MAX_AGE_DAYS } = {}) {
  if (!Number.isInteger(max_observations) || max_observations < 1 || max_observations > 100_000
    || !Number.isInteger(max_per_scope) || max_per_scope < 1 || max_per_scope > 10_000
    || !Number.isInteger(max_age_days) || max_age_days < 1 || max_age_days > 3650) throw coded("Shopping price-history bounds are invalid");

  async function record(input) {
    const observation = safeRecordInput(input);
    if (!observation) return { recorded: false, reason: "evidence_not_eligible" };
    return withLock(env, max_observations, async (state) => {
      if (state.observations.some((item) => item.observation_id === observation.observation_id)) {
        return { write: false, value: { recorded: false, reason: "duplicate", observation_count: state.observations.length } };
      }
      const cutoff = clock() - max_age_days * 86_400_000;
      state.observations = state.observations.filter((item) => Date.parse(item.observed_at) >= cutoff);
      state.observations.push(observation);
      const scope = (item) => [clean(item.product_key), clean(item.variant), clean(item.condition), item.currency].join("|");
      const currentScope = scope(observation);
      const sameScope = state.observations.filter((item) => scope(item) === currentScope);
      if (sameScope.length > max_per_scope) {
        const remove = new Set(sameScope.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)).slice(0, sameScope.length - max_per_scope).map((item) => item.observation_id));
        state.observations = state.observations.filter((item) => !remove.has(item.observation_id));
      }
      state.observations.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
      state.observations = state.observations.slice(-max_observations);
      return { value: { recorded: true, observation_count: state.observations.length } };
    });
  }

  async function evaluate(input) {
    const state = await readState(env, max_observations);
    const processObservations = state.observations.filter((item) => clean(item.product_key) === clean(input?.current?.product_key)).map(publicObservation);
    const processResult = analyzeDealQuality({ ...input, observations: processObservations });
    if (processResult.history.sufficient) return { ...processResult, history_provenance: "process_verified" };
    return { ...analyzeDealQuality(input), history_provenance: "caller_supplied" };
  }

  async function inspect() {
    const state = await readState(env, max_observations);
    return structuredClone(state);
  }

  return { record, evaluate, inspect };
}
