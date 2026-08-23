import { verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const money = (value) => {
  const parsed = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
};

function explicit(text, pattern, transform = clean) {
  const match = pattern.exec(text);
  if (!match) return null;
  const value = transform(match[1] ?? match[0]);
  return value == null || value === "" ? null : value;
}

function yesNo(value) {
  if (/^(?:yes|true|enabled)$/i.test(clean(value))) return true;
  if (/^(?:no|false|disabled)$/i.test(clean(value))) return false;
  return null;
}

function iso(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseKeyValues(line) {
  const result = {};
  for (const piece of line.split(";")) {
    const match = /^\s*([a-z][a-z0-9 _-]{0,50})\s*=\s*(.*?)\s*$/i.exec(piece);
    if (match) result[clean(match[1]).toLowerCase().replace(/[\s-]+/g, "_")] = clean(match[2]);
  }
  return result;
}

function parseAddOns(text, sourceId) {
  const results = [];
  for (const match of text.matchAll(/(?:^|\n)\s*add[- ]on\s*:\s*([^\n]{1,1000})/gi)) {
    const fields = parseKeyValues(match[1]);
    const amount = money(fields.amount);
    const selected = yesNo(fields.selected);
    const optional = yesNo(fields.optional);
    const preselected = yesNo(fields.preselected);
    if (!fields.id || !fields.kind || amount == null || selected == null || optional == null || preselected == null) continue;
    const addOn = { id: fields.id, kind: fields.kind.toLowerCase().replace(/[\s-]+/g, "_"), selected, optional, preselected, amount_usd: amount, evidence_status: "verified", source_id: sourceId };
    if (fields.recurring_amount || fields.recurring_cadence) {
      const recurringAmount = money(fields.recurring_amount);
      if (recurringAmount != null && fields.recurring_cadence) addOn.recurring = { amount_usd: recurringAmount, cadence: fields.recurring_cadence.toLowerCase(), evidence_status: "verified", source_id: sourceId };
    }
    results.push(addOn);
  }
  return results;
}

function parseTermChanges(text) {
  const results = [];
  for (const match of text.matchAll(/(?:^|\n)\s*term\s+change\s*:\s*([^\n]{1,1000})/gi)) {
    const fields = parseKeyValues(match[1]);
    const notified = yesNo(fields.disclosed ?? fields.user_notified);
    if (fields.field && notified != null) results.push({ field: fields.field, changed: true, user_notified: notified });
  }
  return results;
}

function parseUrgencyClaims(text, sourceId) {
  const results = [];
  for (const match of text.matchAll(/(?:^|\n)\s*urgency\s+claim\s*:\s*([^\n]{1,1000})/gi)) {
    const fields = parseKeyValues(match[1]);
    if (!fields.id || !fields.type) continue;
    const claim = { id: fields.id, type: fields.type.toLowerCase().replace(/[\s-]+/g, "_"), source_id: sourceId };
    if (fields.remaining_seconds != null && Number.isInteger(Number(fields.remaining_seconds)) && Number(fields.remaining_seconds) >= 0) claim.remaining_seconds = Number(fields.remaining_seconds);
    if (fields.count != null && Number.isInteger(Number(fields.count)) && Number(fields.count) >= 0) claim.count = Number(fields.count);
    if (fields.expires_at) {
      const expiresAt = iso(fields.expires_at);
      if (!expiresAt) continue;
      claim.expires_at = expiresAt;
    }
    if (fields.restock_observed != null) {
      const restock = yesNo(fields.restock_observed);
      if (restock == null) continue;
      claim.restock_observed = restock;
    }
    if (claim.type === "countdown" && claim.remaining_seconds == null && !claim.expires_at) continue;
    if (claim.type === "scarcity" && claim.count == null) continue;
    results.push(claim);
  }
  return results;
}

export function extractCheckoutTermsEvidence({ page_text = "", url = null, captured_at = null, source_id = null }) {
  const text = String(page_text).slice(0, 200_000);
  const offerId = explicit(text, /(?:^|\n)\s*offer\s+id\s*[:#-]\s*([^\n|•]{1,160})/im);
  const productId = explicit(text, /(?:^|\n)\s*product\s+key\s*[:#-]\s*([^\n|•]{1,160})/im);
  const type = explicit(text, /(?:^|\n)\s*purchase\s+type\s*[:#-]\s*(one[- ]time|subscription|trial[- ]to[- ]paid|membership|installment|preorder\s+deposit)/im, (value) => clean(value).toLowerCase().replace(/[\s-]+/g, "_").replace("preorder_deposit", "preorder_deposit"));
  const termsVersion = explicit(text, /(?:^|\n)\s*terms\s+version\s*[:#-]\s*([^\n|•]{1,160})/im);
  const termsComplete = /(?:^|\n)\s*terms\s+inventory\s*[:#-]\s*complete\b/im.test(text);
  const addOnMarkerComplete = /(?:^|\n)\s*add[- ]on\s+inventory\s*[:#-]\s*complete\b/im.test(text);
  const termChangeMarkerComplete = /(?:^|\n)\s*term\s+change\s+inventory\s*[:#-]\s*complete\b/im.test(text);
  const urgencyMarkerComplete = /(?:^|\n)\s*urgency\s+inventory\s*[:#-]\s*complete\b/im.test(text);
  const addOns = parseAddOns(text, source_id);
  const termChanges = parseTermChanges(text);
  const urgencyClaims = parseUrgencyClaims(text, source_id);
  const rawAddOnCount = [...text.matchAll(/(?:^|\n)\s*add[- ]on\s*:\s*[^\n]+/gi)].length;
  const rawTermChangeCount = [...text.matchAll(/(?:^|\n)\s*term\s+change\s*:\s*[^\n]+/gi)].length;
  const rawUrgencyCount = [...text.matchAll(/(?:^|\n)\s*urgency\s+claim\s*:\s*[^\n]+/gi)].length;
  const addOnInventoryComplete = addOnMarkerComplete && addOns.length === rawAddOnCount;
  const termChangeInventoryComplete = termChangeMarkerComplete && termChanges.length === rawTermChangeCount;
  const urgencyInventoryComplete = urgencyMarkerComplete && urgencyClaims.length === rawUrgencyCount;
  const initialCharge = explicit(text, /(?:^|\n)\s*initial\s+charge\s*[:#-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im, money);
  const purchase = {
    type,
    terms_version: termsVersion,
    disclosed_at: captured_at,
    terms_inventory_complete: termsComplete,
    evidence_status: termsComplete && type && termsVersion ? "verified" : "unknown",
    source_id: termsComplete && type && termsVersion ? source_id : undefined,
    initial_charge: initialCharge == null ? { amount_usd: null, evidence_status: "unknown" } : { amount_usd: initialCharge, evidence_status: "verified", source_id },
  };

  if (["subscription", "trial_to_paid", "membership"].includes(type)) {
    const recurringAmount = explicit(text, /(?:^|\n)\s*recurring\s+charge\s*[:#-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im, money);
    const cadence = explicit(text, /(?:^|\n)\s*recurring\s+cadence\s*[:#-]\s*(weekly|monthly|quarterly|semiannual|annual|custom)/im, (value) => clean(value).toLowerCase());
    const firstCharge = explicit(text, /(?:^|\n)\s*first\s+recurring\s+charge\s*[:#-]\s*([^\n|•]{4,100})/im, iso);
    const autoRenews = explicit(text, /(?:^|\n)\s*auto[- ]renews?\s*[:#-]\s*(yes|no|true|false|enabled|disabled)/im, yesNo);
    if (recurringAmount != null && cadence && firstCharge && autoRenews != null) {
      purchase.recurring = { amount_usd: recurringAmount, cadence, first_charge_at: firstCharge, auto_renews: autoRenews, evidence_status: "verified", source_id };
      const introCycles = explicit(text, /(?:^|\n)\s*intro(?:ductory)?\s+cycles\s*[:#-]\s*(\d{1,6})\b/im, Number);
      const postIntro = explicit(text, /(?:^|\n)\s*post[- ]intro\s+price\s*[:#-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im, money);
      const minimumCycles = explicit(text, /(?:^|\n)\s*minimum\s+cycles\s*[:#-]\s*(\d{1,6})\b/im, Number);
      if (introCycles != null) purchase.recurring.intro_cycles = introCycles;
      if (postIntro != null) purchase.recurring.price_after_intro_usd = postIntro;
      if (minimumCycles != null) purchase.recurring.minimum_cycles = minimumCycles;
    }
    const cancellationMethod = explicit(text, /(?:^|\n)\s*cancellation\s+method\s*[:#-]\s*(online|email|phone|mail|in[- ]person|not\s+available|unknown)/im, (value) => clean(value).toLowerCase().replace(/[\s-]+/g, "_"));
    const cancellationComplete = /(?:^|\n)\s*cancellation\s+terms\s*[:#-]\s*complete\b/im.test(text);
    if (cancellationMethod) {
      purchase.cancellation = { method: cancellationMethod, terms_complete: cancellationComplete, evidence_status: cancellationComplete ? "verified" : "unknown", source_id: cancellationComplete ? source_id : undefined };
      const deadline = explicit(text, /(?:^|\n)\s*cancellation\s+deadline\s*[:#-]\s*([^\n|•]{1,500})/im);
      const fee = explicit(text, /(?:^|\n)\s*cancellation\s+fee\s*[:#-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im, money);
      if (deadline) purchase.cancellation.deadline = deadline;
      if (fee != null) purchase.cancellation.fee_usd = fee;
    }
  }

  if (type === "trial_to_paid") {
    const endsAt = explicit(text, /(?:^|\n)\s*trial\s+ends\s*[:#-]\s*([^\n|•]{4,100})/im, iso);
    const converts = explicit(text, /(?:^|\n)\s*trial\s+converts\s+automatically\s*[:#-]\s*(yes|no|true|false)/im, yesNo);
    if (endsAt && converts != null) purchase.trial = { ends_at: endsAt, converts_automatically: converts, evidence_status: "verified", source_id };
  }

  if (["installment", "preorder_deposit"].includes(type)) {
    const complete = /(?:^|\n)\s*commitment\s+terms\s*[:#-]\s*complete\b/im.test(text);
    const count = explicit(text, /(?:^|\n)\s*installment\s+count\s*[:#-]\s*(\d{1,6})\b/im, Number);
    const finalAt = explicit(text, /(?:^|\n)\s*final\s+payment\s*[:#-]\s*([^\n|•]{4,100})/im, iso);
    const refundable = explicit(text, /(?:^|\n)\s*(?:deposit\s+)?refundable\s*[:#-]\s*(yes|no|true|false)/im, yesNo);
    purchase.commitment = { terms_complete: complete, evidence_status: complete ? "verified" : "unknown", source_id: complete ? source_id : undefined };
    if (count != null) purchase.commitment.installment_count = count;
    if (finalAt) purchase.commitment.final_payment_at = finalAt;
    if (refundable != null) purchase.commitment.refundable = refundable;
  }

  return {
    source: { url, captured_at, source_id },
    product_id: productId,
    offer_id: offerId,
    purchase,
    add_on_inventory_complete: addOnInventoryComplete,
    add_ons: addOns,
    term_change_inventory_complete: termChangeInventoryComplete,
    term_changes: termChanges,
    urgency_inventory_complete: urgencyInventoryComplete,
    urgency_claims: urgencyClaims,
  };
}

export function validateCheckoutTermsEvidence(artifact, evaluated_at = Date.now(), max_age_seconds = 120) {
  const evaluatedAt = typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at || "");
  const capturedAt = Date.parse(artifact?.source?.captured_at || "");
  const receiptAt = Date.parse(artifact?.source_receipt?.captured_at || "");
  if (!verifyShoppingArtifactAttestation("checkout_terms_evidence", artifact)
    || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)
    || artifact?.source_receipt?.truncated === true
    || artifact?.source?.source_id !== artifact?.source_receipt?.source_id
    || artifact?.source?.url !== artifact?.source_receipt?.url
    || capturedAt !== receiptAt
    || !Number.isFinite(evaluatedAt) || !Number.isFinite(capturedAt)
    || capturedAt > evaluatedAt + 5_000 || evaluatedAt - capturedAt > max_age_seconds * 1_000) return null;
  return artifact;
}

export function checkoutConsentInputFromTermsEvidence({ terms_evidence, acknowledgement_receipt = null, policy = {}, evaluated_at = Date.now() }) {
  const artifact = validateCheckoutTermsEvidence(terms_evidence, evaluated_at, policy.max_evidence_age_seconds ?? 120);
  if (!artifact) throw Object.assign(new Error("Fresh complete process-attested checkout terms evidence is required"), { code: "shopping_checkout_terms_evidence_invalid" });
  return {
    product_id: artifact.product_id,
    offer_id: artifact.offer_id,
    evaluated_at: new Date(typeof evaluated_at === "number" ? evaluated_at : Date.parse(evaluated_at)).toISOString(),
    captured_at: artifact.source.captured_at,
    policy,
    purchase: artifact.purchase,
    add_on_inventory_complete: artifact.add_on_inventory_complete,
    add_ons: artifact.add_ons,
    term_change_inventory_complete: artifact.term_change_inventory_complete,
    term_changes: artifact.term_changes,
    urgency_inventory_complete: artifact.urgency_inventory_complete,
    urgency_claims: artifact.urgency_claims,
    acknowledgement_receipt,
  };
}
