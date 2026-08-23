import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { validateCheckoutTermsEvidence } from "./shopping-checkout-terms-evidence.mjs";

const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function origin(url) {
  try { return new URL(url).origin.toLowerCase(); } catch { return null; }
}

const CHANGED_FIELDS = Object.freeze([
  ["purchase_type", (item) => item.purchase?.type],
  ["terms_version", (item) => item.purchase?.terms_version],
  ["initial_charge", (item) => item.purchase?.initial_charge?.amount_usd],
  ["recurring_amount", (item) => item.purchase?.recurring?.amount_usd],
  ["recurring_cadence", (item) => item.purchase?.recurring?.cadence],
  ["first_recurring_charge", (item) => item.purchase?.recurring?.first_charge_at],
  ["auto_renewal", (item) => item.purchase?.recurring?.auto_renews],
  ["post_intro_price", (item) => item.purchase?.recurring?.price_after_intro_usd],
  ["minimum_commitment", (item) => item.purchase?.recurring?.minimum_cycles],
  ["cancellation_method", (item) => item.purchase?.cancellation?.method],
  ["cancellation_deadline", (item) => item.purchase?.cancellation?.deadline],
  ["cancellation_fee", (item) => item.purchase?.cancellation?.fee_usd],
  ["trial_end", (item) => item.purchase?.trial?.ends_at],
  ["trial_conversion", (item) => item.purchase?.trial?.converts_automatically],
]);

function disclosedFields(artifact) {
  return new Set((artifact.term_changes || []).filter((item) => item.changed === true && item.user_notified === true).map((item) => clean(item.field)));
}

function urgencyById(artifact) {
  return new Map((artifact.urgency_claims || []).map((item) => [clean(item.id), item]));
}

function addOnsById(artifact) {
  return new Map((artifact.add_ons || []).map((item) => [clean(item.id), item]));
}

export function createShoppingCheckoutPatternRegistry({ max_scopes = 100, max_observations_per_scope = 20 } = {}) {
  const scopes = new Map();

  function observe({ terms_evidence, evaluated_at = Date.now() }) {
    const artifact = validateCheckoutTermsEvidence(terms_evidence, evaluated_at, 120);
    if (!artifact || !clean(artifact.product_id) || !clean(artifact.offer_id)) throw coded("Fresh exact checkout terms evidence is required for pattern observation", "shopping_checkout_pattern_terms_invalid");
    const checkoutOrigin = origin(artifact.source?.url);
    if (!checkoutOrigin) throw coded("Checkout pattern origin is invalid", "shopping_checkout_pattern_scope_invalid");
    const scopeKey = `${checkoutOrigin}|${clean(artifact.product_id)}|${clean(artifact.offer_id)}`;
    let state = scopes.get(scopeKey);
    if (!state) {
      state = { observations: [], byAttestation: new Map(), addOns: new Map(), persistentFlags: new Set() };
      scopes.set(scopeKey, state);
      while (scopes.size > max_scopes) scopes.delete(scopes.keys().next().value);
    }
    const observationKey = artifact.artifact_attestation;
    const contentKey = artifact.source_receipt.content_sha256;
    if (state.byAttestation.has(observationKey)) return structuredClone(state.byAttestation.get(observationKey));

    const capturedAt = Date.parse(artifact.source.captured_at);
    const previous = state.observations.at(-1) || null;
    if (previous && capturedAt < previous.capturedAt) throw coded("Checkout observations must be submitted in capture order", "shopping_checkout_pattern_out_of_order");
    const flags = [];
    const blockers = [];
    const warnings = [];
    const currentDisclosures = disclosedFields(artifact);

    if (previous) {
      for (const [field, read] of CHANGED_FIELDS) {
        if (!same(read(previous.artifact), read(artifact))) {
          flags.push(`checkout_term_changed:${field}`);
          if (!currentDisclosures.has(field) && !currentDisclosures.has("all_terms")) blockers.push(`checkout_term_change_undisclosed:${field}`);
        }
      }
      const priorUrgency = urgencyById(previous.artifact);
      for (const claim of artifact.urgency_claims || []) {
        const prior = priorUrgency.get(clean(claim.id));
        if (!prior || prior.type !== claim.type) continue;
        const elapsedSeconds = Math.max(0, (capturedAt - previous.capturedAt) / 1000);
        if (claim.type === "countdown") {
          const remainingReset = Number.isFinite(prior.remaining_seconds) && Number.isFinite(claim.remaining_seconds)
            && claim.remaining_seconds > Math.max(0, prior.remaining_seconds - elapsedSeconds) + 3;
          const expiryReset = prior.expires_at && claim.expires_at && Date.parse(claim.expires_at) > Date.parse(prior.expires_at) + 3_000;
          if (remainingReset || expiryReset) flags.push(`urgency_reset:${claim.id}`);
        }
        if (claim.type === "scarcity" && Number.isFinite(prior.count) && Number.isFinite(claim.count) && claim.count > prior.count && claim.restock_observed !== true) flags.push(`scarcity_count_increased:${claim.id}`);
      }
    }

    const currentAddOns = addOnsById(artifact);
    for (const [id, history] of state.addOns) {
      const selected = currentAddOns.get(id)?.selected === true;
      if (!selected && history.everSelected) history.seenDeselectedAfterSelection = true;
      if (selected && history.seenDeselectedAfterSelection) flags.push(`selected_add_on_reappeared:${currentAddOns.get(id)?.id || id}`);
    }
    for (const [id, addOn] of currentAddOns) {
      const history = state.addOns.get(id) || { everSelected: false, seenDeselectedAfterSelection: false };
      if (addOn.selected === true && history.seenDeselectedAfterSelection) flags.push(`selected_add_on_reappeared:${addOn.id}`);
      if (addOn.selected === true) history.everSelected = true;
      else if (history.everSelected) history.seenDeselectedAfterSelection = true;
      state.addOns.set(id, history);
    }

    for (const flag of flags) {
      if (flag.startsWith("urgency_reset:") || flag.startsWith("scarcity_count_increased:") || flag.startsWith("selected_add_on_reappeared:")) state.persistentFlags.add(flag);
    }
    const uniqueFlags = [...new Set([...flags, ...state.persistentFlags])];
    for (const flag of uniqueFlags) {
      if (flag.startsWith("urgency_reset:") || flag.startsWith("scarcity_count_increased:")) warnings.push(`${flag}:observed_pattern_not_fraud_finding`);
      else if (flag.startsWith("selected_add_on_reappeared:")) warnings.push(`${flag}:fresh_acceptance_required`);
    }
    const urgencyClaims = (artifact.urgency_claims || []).map((claim) => {
      const reset = uniqueFlags.includes(`urgency_reset:${claim.id}`) || uniqueFlags.includes(`scarcity_count_increased:${claim.id}`);
      return { ...claim, evidence_status: reset ? "conflict" : previous ? "verified" : "unknown", resets_observed: reset };
    });
    const result = attestShoppingArtifact("checkout_pattern_evidence", {
      evaluated_at: new Date(typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at)).toISOString(),
      product_id: artifact.product_id,
      offer_id: artifact.offer_id,
      checkout_origin: checkoutOrigin,
      latest_terms_attestation: artifact.artifact_attestation,
      latest_content_sha256: contentKey,
      observation_count: state.observations.length + 1,
      flags: uniqueFlags,
      blockers: [...new Set(blockers)],
      warnings: [...new Set(warnings)],
      urgency_claims: urgencyClaims,
      urgency_may_override_gates: false,
      purchase_allowed: false,
    });
    state.observations.push({ artifact: structuredClone(artifact), capturedAt });
    while (state.observations.length > max_observations_per_scope) state.observations.shift();
    state.byAttestation.set(observationKey, result);
    while (state.byAttestation.size > max_observations_per_scope * 2) state.byAttestation.delete(state.byAttestation.keys().next().value);
    return structuredClone(result);
  }

  return { observe, size: () => scopes.size };
}

export function validateCheckoutPatternEvidence(pattern, termsEvidence, evaluated_at = Date.now(), max_age_seconds = 120) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  const patternAt = Date.parse(pattern?.evaluated_at || "");
  return verifyShoppingArtifactAttestation("checkout_pattern_evidence", pattern)
    && verifyShoppingArtifactAttestation("checkout_terms_evidence", termsEvidence)
    && pattern.latest_terms_attestation === termsEvidence.artifact_attestation
    && pattern.latest_content_sha256 === termsEvidence.source_receipt?.content_sha256
    && clean(pattern.product_id) === clean(termsEvidence.product_id)
    && clean(pattern.offer_id) === clean(termsEvidence.offer_id)
    && pattern.checkout_origin === origin(termsEvidence.source?.url)
    && Number.isFinite(evaluatedAt) && Number.isFinite(patternAt)
    && patternAt <= evaluatedAt + 5_000 && evaluatedAt - patternAt <= max_age_seconds * 1_000;
}
