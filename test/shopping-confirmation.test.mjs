import assert from "node:assert/strict";
import test from "node:test";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "../lib/shopping-attestation.mjs";
import { createShoppingConfirmationRegistry } from "../lib/shopping-confirmation.mjs";

const NOW = "2026-08-22T20:00:30.000Z";
const checkout = () => attestShoppingArtifact("checkout_preflight", {
  evaluated_at: NOW,
  status: "ready_for_confirmation",
  confirmation_required: true,
  purchase_allowed: false,
  confirmation_summary: {
    merchant: "Example Store",
    item: { id: "offer-a", product_key: "camera-x", quantity: 1, seller: "Example Store" },
    total_usd: 108,
    payment_method: "Visa ending 1234",
    shipping_destination: "Home ZIP 94107",
  },
});
const consent = (fields = {}) => attestShoppingArtifact("checkout_consent", {
  product_id: "camera-x",
  offer_id: "offer-a",
  evaluated_at: NOW,
  status: "ready_for_confirmation",
  consent_cleared_for_confirmation: true,
  confirmation_required: true,
  purchase_allowed: false,
  ...fields,
});

test("a new exact panel response creates a single-use audit receipt without purchase authority", async () => {
  let challenge;
  const registry = createShoppingConfirmationRegistry({
    resolve_panel_request: async (requestId) => ({ request_id: requestId, request_revision: 1, text: challenge.required_response, captured_at: "2026-08-22T20:00:40.000Z" }),
  });
  challenge = registry.issue({ checkout_preflight: checkout(), checkout_consent: consent(), evaluated_at: NOW });
  assert.equal(verifyShoppingArtifactAttestation("checkout_confirmation_challenge", challenge), true);
  assert.match(challenge.required_response, /^CONFIRM [A-F0-9]{12}$/);
  assert.equal(challenge.purchase_allowed, false);
  assert.equal(challenge.external_submission_allowed, false);

  const result = await registry.accept({ challenge, request_id: "panel-confirm-1", evaluated_at: "2026-08-22T20:00:45.000Z" });
  assert.equal(verifyShoppingArtifactAttestation("checkout_confirmation", result), true);
  assert.equal(result.product_id, "camera-x");
  assert.equal(result.offer_id, "offer-a");
  assert.equal(result.summary_sha256, challenge.summary_sha256);
  assert.equal(result.purchase_allowed, false);
  assert.equal(result.external_submission_allowed, false);
  await assert.rejects(() => registry.accept({ challenge, request_id: "panel-confirm-2", evaluated_at: "2026-08-22T20:00:46.000Z" }), { code: "shopping_confirmation_replayed" });
});

test("wrong, prior, expired, altered, and restarted-process confirmations fail closed", async () => {
  let response = "not the code";
  let capturedAt = "2026-08-22T20:00:40.000Z";
  const registry = createShoppingConfirmationRegistry({
    resolve_panel_request: async (requestId) => ({ request_id: requestId, request_revision: 1, text: response, captured_at: capturedAt }),
  });
  const challenge = registry.issue({ checkout_preflight: checkout(), checkout_consent: consent(), evaluated_at: NOW, expires_in_seconds: 60 });
  await assert.rejects(() => registry.accept({ challenge, request_id: "wrong", evaluated_at: "2026-08-22T20:00:45.000Z" }), { code: "shopping_confirmation_response_mismatch" });

  response = challenge.required_response;
  capturedAt = "2026-08-22T20:00:20.000Z";
  await assert.rejects(() => registry.accept({ challenge, request_id: "prior", evaluated_at: "2026-08-22T20:00:45.000Z" }), { code: "shopping_confirmation_message_stale" });
  capturedAt = "2026-08-22T20:00:40.000Z";
  await assert.rejects(() => registry.accept({ challenge, request_id: "expired", evaluated_at: "2026-08-22T20:02:00.000Z" }), { code: "shopping_confirmation_expired" });

  const altered = structuredClone(challenge);
  altered.offer_id = "offer-b";
  await assert.rejects(() => registry.accept({ challenge: altered, request_id: "altered", evaluated_at: "2026-08-22T20:00:45.000Z" }), { code: "shopping_confirmation_challenge_invalid" });

  const restarted = createShoppingConfirmationRegistry({ resolve_panel_request: async () => ({}) });
  await assert.rejects(() => restarted.accept({ challenge, request_id: "restart", evaluated_at: "2026-08-22T20:00:45.000Z" }), { code: "shopping_confirmation_challenge_not_found" });
});

test("challenge issuance rejects tampered, stale, non-ready, and wrong-subject artifacts", () => {
  const registry = createShoppingConfirmationRegistry({ resolve_panel_request: async () => ({}) });
  const tamperedCheckout = checkout();
  tamperedCheckout.confirmation_summary.total_usd = 1;
  assert.throws(() => registry.issue({ checkout_preflight: tamperedCheckout, checkout_consent: consent(), evaluated_at: NOW }), { code: "shopping_confirmation_checkout_invalid" });

  assert.throws(() => registry.issue({ checkout_preflight: checkout(), checkout_consent: consent({ offer_id: "offer-b" }), evaluated_at: NOW }), { code: "shopping_confirmation_subject_mismatch" });
  assert.throws(() => registry.issue({ checkout_preflight: checkout(), checkout_consent: consent({ status: "clarify_consent", consent_cleared_for_confirmation: false }), evaluated_at: NOW }), { code: "shopping_confirmation_consent_invalid" });
  assert.throws(() => registry.issue({ checkout_preflight: checkout(), checkout_consent: consent(), evaluated_at: "2026-08-22T20:10:00.000Z" }), { code: "shopping_confirmation_artifact_stale" });
});
