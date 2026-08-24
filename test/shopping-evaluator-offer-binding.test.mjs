import test from "node:test";
import assert from "node:assert/strict";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { projectShoppingEvaluatorOfferInput, validateShoppingEvaluatorOfferBinding } from "../lib/shopping-evaluator-offer-binding.mjs";

function evidence(sourceId) {
  return attestShoppingArtifact("page_evidence", {
    source: { url: `https://shop.example/items/${sourceId}`, page_kind: "retailer_listing", captured_at: "2026-08-24T12:00:00.000Z" },
    extraction_scope: { directory_complete: false },
    facts: { title: { value: sourceId } },
    source_receipt: { source_id: sourceId },
  });
}

function artifact() {
  const a = evidence("a");
  const b = evidence("b");
  return attestShoppingArtifact("candidate_offers", {
    candidate_set_id: "set-1",
    evaluated_at: "2026-08-24T12:00:00.000Z",
    offers: [
      { candidate_id: "offer-a", listing_evidence: a },
      { candidate_id: "offer-b", listing_evidence: b },
    ],
  });
}

const context = { phase: "offer_recommendation", offer_id: "offer-a" };
const subject = { product_id: "camera-x", offer_id: "offer-a" };

test("exact-offer binding accepts signed shortlist IDs with their authoritative listing evidence", () => {
  const candidate_offers = artifact();
  assert.deepEqual(validateShoppingEvaluatorOfferBinding({
    candidate_offers, decision_context: context, stage: "counterfeit", subject,
    input: { offers: [{ id: "offer-a", listing_evidence: candidate_offers.offers[0].listing_evidence }] },
  }), ["offer-a"]);
});

test("exact-offer binding rejects cross-candidate evidence substitution", () => {
  const candidate_offers = artifact();
  assert.throws(() => validateShoppingEvaluatorOfferBinding({
    candidate_offers, decision_context: context, stage: "counterfeit", subject,
    input: { offers: [{ id: "offer-a", listing_evidence: candidate_offers.offers[1].listing_evidence }] },
  }), { code: "shopping_candidate_offer_evidence_mismatch" });
});

test("exact-offer binding rejects unknown, duplicate, and omitted subject IDs", () => {
  const candidate_offers = artifact();
  const run = (offers) => validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context: context, stage: "fulfillment", subject, input: { offers } });
  assert.throws(() => run([{ id: "offer-x", listing_evidence: candidate_offers.offers[0].listing_evidence }]), { code: "shopping_candidate_offer_id_mismatch" });
  assert.throws(() => run([
    { id: "offer-a", listing_evidence: candidate_offers.offers[0].listing_evidence },
    { id: "offer-a", listing_evidence: candidate_offers.offers[0].listing_evidence },
  ]), { code: "shopping_candidate_offer_id_duplicate" });
  assert.throws(() => run([{ id: "offer-b", listing_evidence: candidate_offers.offers[1].listing_evidence }]), { code: "shopping_candidate_offer_subject_omitted" });
});

test("offer phases require signed candidate offers for raw listing evaluators", () => {
  assert.throws(() => validateShoppingEvaluatorOfferBinding({
    candidate_offers: null, decision_context: context, stage: "merchant", subject, input: {},
  }), { code: "shopping_candidate_offers_required" });
  assert.doesNotThrow(() => validateShoppingEvaluatorOfferBinding({
    candidate_offers: null, decision_context: { phase: "product_recommendation", offer_id: null }, stage: "safety", subject: { product_id: "camera-x" }, input: {},
  }));
});

test("promotion binds its direct offer ID and listing evidence", () => {
  const candidate_offers = artifact();
  assert.deepEqual(validateShoppingEvaluatorOfferBinding({
    candidate_offers, decision_context: context, stage: "promotion", subject,
    input: { offer_id: "offer-a", listing_evidence: candidate_offers.offers[0].listing_evidence },
  }), ["offer-a"]);
  assert.throws(() => validateShoppingEvaluatorOfferBinding({
    candidate_offers, decision_context: context, stage: "promotion", subject,
    input: { offer_id: "offer-b", listing_evidence: candidate_offers.offers[1].listing_evidence },
  }), { code: "shopping_candidate_offer_id_mismatch" });
});

test("exact-offer binding rejects a modified candidate-offers artifact", () => {
  const candidate_offers = artifact();
  candidate_offers.offers[0].candidate_id = "offer-x";
  assert.throws(() => validateShoppingEvaluatorOfferBinding({
    candidate_offers, decision_context: context, stage: "counterfeit", subject,
    input: { offers: [] },
  }), { code: "shopping_candidate_offers_invalid" });
});

test("exact-offer projection injects authoritative listing evidence once from the signed artifact", () => {
  const candidate_offers = artifact();
  const raw = { offers: [{ id: "offer-a" }, { id: "offer-b", authorization_evidence: { marker: "separate" } }] };
  const projected = projectShoppingEvaluatorOfferInput({ candidate_offers, stage: "counterfeit", input: raw });
  assert.equal(projected.offers[0].listing_evidence.artifact_attestation, candidate_offers.offers[0].listing_evidence.artifact_attestation);
  assert.equal(projected.offers[1].listing_evidence.artifact_attestation, candidate_offers.offers[1].listing_evidence.artifact_attestation);
  assert.equal(raw.offers[0].listing_evidence, undefined, "projection must not inflate or mutate the caller payload");
});

test("exact-offer projection never overwrites caller-supplied substituted evidence", () => {
  const candidate_offers = artifact();
  const substituted = { offers: [{ id: "offer-a", listing_evidence: candidate_offers.offers[1].listing_evidence }] };
  const projected = projectShoppingEvaluatorOfferInput({ candidate_offers, stage: "counterfeit", input: substituted });
  assert.equal(projected.offers[0].listing_evidence.artifact_attestation, candidate_offers.offers[1].listing_evidence.artifact_attestation);
  assert.throws(() => validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context: context, stage: "counterfeit", subject, input: projected }), { code: "shopping_candidate_offer_evidence_mismatch" });
});

test("promotion projection injects its direct authoritative listing evidence", () => {
  const candidate_offers = artifact();
  const projected = projectShoppingEvaluatorOfferInput({ candidate_offers, stage: "promotion", input: { offer_id: "offer-a" } });
  assert.equal(projected.listing_evidence.artifact_attestation, candidate_offers.offers[0].listing_evidence.artifact_attestation);
});

test("condition and deal stages preserve the exact signed subject ID", () => {
  const candidate_offers = artifact();
  assert.deepEqual(validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context: context, stage: "condition", subject, input: { offer: { id: "offer-a" } } }), ["offer-a"]);
  assert.deepEqual(validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context: context, stage: "deal", subject, input: { current: { offer_id: "offer-a" } } }), ["offer-a"]);
  assert.throws(() => validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context: context, stage: "condition", subject, input: { offer: { id: "offer-b" } } }), { code: "shopping_candidate_offer_id_mismatch" });
  assert.throws(() => validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context: context, stage: "deal", subject, input: { current: { offer_id: "offer-b" } } }), { code: "shopping_candidate_offer_id_mismatch" });
});

test("offer analysis accepts only unique signed shortlist IDs and must include its subject", () => {
  const candidate_offers = artifact();
  const run = (offers) => validateShoppingEvaluatorOfferBinding({ candidate_offers, decision_context: context, stage: "offer", subject, input: { offers } });
  assert.deepEqual(run([{ id: "offer-a" }, { id: "offer-b" }]), ["offer-a", "offer-b"]);
  assert.throws(() => run([{ id: "offer-a" }, { id: "offer-a" }]), { code: "shopping_candidate_offer_id_duplicate" });
  assert.throws(() => run([{ id: "offer-b" }]), { code: "shopping_candidate_offer_subject_omitted" });
  assert.throws(() => run([{ id: "offer-a" }, { id: "offer-x" }]), { code: "shopping_candidate_offer_id_mismatch" });
});

test("checkout binds the expected offer while allowing explicitly handled extra cart items", () => {
  const candidate_offers = artifact();
  const run = (expectedId, items) => validateShoppingEvaluatorOfferBinding({
    candidate_offers, decision_context: { phase: "checkout_review", offer_id: "offer-a" }, stage: "checkout", subject,
    input: { expected: { offer_id: expectedId }, cart: { items } },
  });
  assert.deepEqual(run("offer-a", [{ id: "offer-a" }, { id: "user-added-accessory" }]), ["offer-a"]);
  assert.throws(() => run("offer-b", [{ id: "offer-b" }]), { code: "shopping_candidate_offer_id_mismatch" });
  assert.throws(() => run("offer-a", [{ id: "user-added-accessory" }]), { code: "shopping_candidate_offer_subject_omitted" });
});

test("checkout consent keeps signed terms and pattern evidence on one exact offer", () => {
  const candidate_offers = artifact();
  const run = (termsId, patternId) => validateShoppingEvaluatorOfferBinding({
    candidate_offers, decision_context: { phase: "checkout_review", offer_id: "offer-a" }, stage: "checkout_consent", subject,
    input: { terms_evidence: { offer_id: termsId }, pattern_evidence: { offer_id: patternId } },
  });
  assert.deepEqual(run("offer-a", "offer-a"), ["offer-a"]);
  assert.throws(() => run("offer-a", "offer-b"), { code: "shopping_candidate_offer_id_mismatch" });
});

test("offer and checkout phases require candidate offers for every derived offer stage", () => {
  for (const stage of ["condition", "offer", "deal", "checkout", "checkout_consent"]) {
    assert.throws(() => validateShoppingEvaluatorOfferBinding({ candidate_offers: null, decision_context: context, stage, subject, input: {} }), { code: "shopping_candidate_offers_required" });
  }
});
