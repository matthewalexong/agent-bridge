import crypto from "node:crypto";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { issueShoppingRequestReceipt } from "./shopping-request-intent.mjs";

const clean = (value) => String(value ?? "").normalize("NFKC").trim();

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function milliseconds(value, code) {
  const parsed = typeof value === "number" ? value : Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw coded("Shopping confirmation time is invalid", code);
  return parsed;
}

function validateReadyArtifacts(checkout, consent, evaluatedAt, maxAgeSeconds) {
  if (!verifyShoppingArtifactAttestation("checkout_preflight", checkout)
    || checkout?.status !== "ready_for_confirmation"
    || checkout?.confirmation_required !== true
    || checkout?.purchase_allowed !== false
    || !checkout?.confirmation_summary?.item?.id
    || !checkout?.confirmation_summary?.item?.product_key) {
    throw coded("A ready process-attested checkout preflight is required", "shopping_confirmation_checkout_invalid");
  }
  if (!verifyShoppingArtifactAttestation("checkout_consent", consent)
    || consent?.status !== "ready_for_confirmation"
    || consent?.consent_cleared_for_confirmation !== true
    || consent?.confirmation_required !== true
    || consent?.purchase_allowed !== false) {
    throw coded("A ready process-attested checkout consent result is required", "shopping_confirmation_consent_invalid");
  }
  const item = checkout.confirmation_summary.item;
  if (clean(consent.product_id).toLowerCase() !== clean(item.product_key).toLowerCase()
    || clean(consent.offer_id).toLowerCase() !== clean(item.id).toLowerCase()) {
    throw coded("Checkout and consent subjects do not match", "shopping_confirmation_subject_mismatch");
  }
  for (const artifact of [checkout, consent]) {
    const artifactAt = milliseconds(artifact.evaluated_at, "shopping_confirmation_artifact_stale");
    if (artifactAt > evaluatedAt + 5_000 || evaluatedAt - artifactAt > maxAgeSeconds * 1_000) {
      throw coded("Checkout confirmation inputs are stale or future-dated", "shopping_confirmation_artifact_stale");
    }
  }
}

export function createShoppingConfirmationRegistry({ resolve_panel_request, max_entries = 100 } = {}) {
  const entries = new Map();

  function issue({ checkout_preflight, checkout_consent, evaluated_at = Date.now(), expires_in_seconds = 300 }) {
    const evaluatedAt = milliseconds(evaluated_at, "shopping_confirmation_time_invalid");
    if (!Number.isInteger(expires_in_seconds) || expires_in_seconds < 30 || expires_in_seconds > 900) {
      throw coded("Shopping confirmation expiry must be 30-900 seconds", "shopping_confirmation_expiry_invalid");
    }
    validateReadyArtifacts(checkout_preflight, checkout_consent, evaluatedAt, expires_in_seconds);
    const code = crypto.randomBytes(6).toString("hex").toUpperCase();
    const challengeId = `shopping_confirmation_${crypto.randomBytes(16).toString("hex")}`;
    const summaryDigest = digest({ checkout_preflight, checkout_consent });
    const item = checkout_preflight.confirmation_summary.item;
    const challenge = attestShoppingArtifact("checkout_confirmation_challenge", {
      challenge_id: challengeId,
      product_id: item.product_key,
      offer_id: item.id,
      issued_at: new Date(evaluatedAt).toISOString(),
      expires_at: new Date(evaluatedAt + expires_in_seconds * 1_000).toISOString(),
      summary_sha256: summaryDigest,
      checkout_preflight_attestation: checkout_preflight.artifact_attestation,
      checkout_consent_attestation: checkout_consent.artifact_attestation,
      confirmation_code: code,
      required_response: `CONFIRM ${code}`,
      confirmation_summary: checkout_preflight.confirmation_summary,
      purchase_allowed: false,
      external_submission_allowed: false,
    });
    entries.set(challengeId, { challenge, status: "issued" });
    while (entries.size > max_entries) entries.delete(entries.keys().next().value);
    return structuredClone(challenge);
  }

  async function accept({ challenge, request_id, evaluated_at = Date.now() }) {
    const evaluatedAt = milliseconds(evaluated_at, "shopping_confirmation_time_invalid");
    if (!verifyShoppingArtifactAttestation("checkout_confirmation_challenge", challenge)) {
      throw coded("Shopping confirmation challenge is forged or altered", "shopping_confirmation_challenge_invalid");
    }
    const entry = entries.get(challenge.challenge_id);
    if (!entry || entry.challenge.artifact_attestation !== challenge.artifact_attestation) {
      throw coded("Shopping confirmation challenge is not active in this process", "shopping_confirmation_challenge_not_found");
    }
    if (entry.status !== "issued") throw coded("Shopping confirmation challenge was already consumed", "shopping_confirmation_replayed");
    const issuedAt = milliseconds(challenge.issued_at, "shopping_confirmation_challenge_invalid");
    const expiresAt = milliseconds(challenge.expires_at, "shopping_confirmation_challenge_invalid");
    if (evaluatedAt < issuedAt || evaluatedAt > expiresAt) throw coded("Shopping confirmation challenge expired", "shopping_confirmation_expired");
    if (typeof resolve_panel_request !== "function") throw coded("Panel confirmation resolution is unavailable", "shopping_confirmation_unavailable");

    entry.status = "resolving";
    try {
      const request = await resolve_panel_request(request_id);
      const receipt = issueShoppingRequestReceipt(request);
      const capturedAt = milliseconds(receipt.captured_at, "shopping_confirmation_message_invalid");
      if (capturedAt < issuedAt || capturedAt > expiresAt || capturedAt > evaluatedAt + 5_000) {
        throw coded("Confirmation message is not new and within the challenge window", "shopping_confirmation_message_stale");
      }
      if (clean(receipt.text).toUpperCase() !== challenge.required_response) {
        throw coded("Confirmation message must exactly match the one-time response", "shopping_confirmation_response_mismatch");
      }
      const confirmation = attestShoppingArtifact("checkout_confirmation", {
        confirmation_id: `checkout_confirmation_${digest(`${challenge.challenge_id}:${receipt.artifact_id}`).slice(0, 32)}`,
        challenge_id: challenge.challenge_id,
        product_id: challenge.product_id,
        offer_id: challenge.offer_id,
        summary_sha256: challenge.summary_sha256,
        user_message_receipt_id: receipt.artifact_id,
        user_message_sha256: receipt.message_sha256,
        confirmed_at: receipt.captured_at,
        recorded_at: new Date(evaluatedAt).toISOString(),
        purchase_allowed: false,
        external_submission_allowed: false,
        next_action: "retain_as_audit_receipt_and_request_separate_order_submission_authority",
      });
      entry.status = "consumed";
      entry.confirmation = confirmation;
      return structuredClone(confirmation);
    } catch (error) {
      entry.status = "issued";
      throw error;
    }
  }

  return { issue, accept, size: () => entries.size };
}
