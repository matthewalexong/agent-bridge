import test from "node:test";
import assert from "node:assert/strict";
import { extractCheckoutEvidence, preflightShoppingCheckout } from "../lib/shopping-checkout.mjs";
import { composeShoppingDossier as composeShoppingDossierProduction } from "../lib/shopping-dossier.mjs";
import { attestShoppingArtifact } from "../lib/shopping-attestation.mjs";
import { createBrowserEvidenceRegistry, extractBrowserObservedCheckoutEvidence } from "../lib/shopping-browser-evidence.mjs";

const composeShoppingDossier = (input) => composeShoppingDossierProduction(input, { require_stage_attestations: false, require_decision_context: false });

function productClearance(productId) {
  const skipped = (reason) => ({ required: false, reason });
  return composeShoppingDossier({
    evaluated_at: "2026-08-22T20:00:00.000Z", phase: "product_recommendation", product_id: productId,
    applicability: {
      candidate_coverage: skipped("The caller supplied one exact product."), performance: skipped("No measured metric affects this checkout fixture."), value: skipped("No normalized value metric affects this fixture."), condition: skipped("Ordinary new inventory has no condition conflict."), promotion: skipped("No promotion affects the product decision."), review_integrity: skipped("No review-derived metric affects this fixture."), composition: skipped("No composition dependency affects this fixture."), privacy: skipped("No connected-data dependency affects this fixture."), compatibility: skipped("No compatibility dependency affects this fixture."), lifecycle: skipped("No lifecycle dependency affects this fixture."), preferences: skipped("The product was supplied exactly."), ownership: skipped("No ownership-cost dependency affects this fixture."), deal: skipped("Purchase timing was not requested."),
    },
    stages: {
      product_evidence: { artifact_id: `evidence-${productId}`, evaluated_at: "2026-08-22T20:00:00.000Z", product_id: productId, status: "verified" },
      safety: { artifact_id: `safety-${productId}`, evaluated_at: "2026-08-22T20:00:00.000Z", product_id: productId, action: "eligible", safety_cleared_for_ranking: true },
    },
  });
}

function reattest(input, kind) {
  input[kind] = attestShoppingArtifact(kind, input[kind]);
}

function signedCheckoutEvidence(text, capturedAt = "2026-08-22T20:00:00.000Z", url = "https://shop.example/checkout") {
  const registry = createBrowserEvidenceRegistry();
  registry.capture({ tab_id: 9, captured_at: capturedAt, snapshot: { snapshotId: `checkout-${capturedAt}`, title: "Checkout", url, text, truncated: false } });
  return extractBrowserObservedCheckoutEvidence(registry.resolve, { snapshot_id: `checkout-${capturedAt}`, evaluated_at: "2026-08-22T20:00:30.000Z" });
}

function bindCurrentCheckout(input, text = observedCheckoutText, url = "https://shop.example/checkout") {
  input.checkout_evidence = signedCheckoutEvidence(text, "2026-08-22T20:00:00.000Z", url);
  const receipt = input.checkout_evidence.source_receipt;
  input.merchant.assessments[0].evidence_scope = { checkout: Object.fromEntries(
    ["source_id", "snapshot_id", "url", "captured_at", "content_sha256"].map((field) => [field, receipt[field]]),
  ) };
  reattest(input, "merchant");
  return input.checkout_evidence;
}

const observedCheckoutText = "Offer ID: A\nProduct Key: mouse-x\nVariant: black\nCondition: new\nSeller: Acme\nMerchant of record: Example Store\nQuantity: 1\nUnit Price: $100.00\nStock: in stock\nReturn Policy: 30-day returns\nPayment Method: Visa ending 1234\nShipping Destination: Home ZIP 94107\nSubtotal: $100.00\nCoupon -$10.00\nCoupon code SAVE10 applied\nShipping: $0.00\nTax: $7.20\nFees: $0.00\nOrder total: $97.20\nArrives: Tuesday";

const base = {
  expected: { offer_id: "A", destination_country: "US", product_key: "mouse-x", variant: "black", condition: "new", quantity: 1, seller: "Acme", max_total_usd: 120, offer_landed_total_usd: 100, max_price_increase_usd: 15, evaluated_at: "2026-08-22T20:00:30.000Z" },
  cart: {
    merchant: "Example Store",
    items: [{ id: "A", product_key: "mouse-x", variant: "black", condition: "new", quantity: 1, unit_price_usd: 100, seller: "Acme", seller_verified: true, stock: "in_stock", stock_verified: true }],
    discounts: [{ code: "SAVE10", amount_usd: 10, applied: true, eligible: true }],
    subtotal_usd: 100, shipping_usd: 0, tax_usd: 7.2, fees_usd: 0, reported_total_usd: 97.2, delivery_estimate: "Tuesday", return_policy: "30-day returns", return_policy_verified: true, payment_method_summary: "Visa ending 1234", shipping_destination_summary: "Home ZIP 94107", captured_at: "2026-08-22T20:00:00.000Z",
  },
  counterfeit: attestShoppingArtifact("counterfeit", { evaluated_at: "2026-08-22T20:00:00.000Z", assessments: [
    { offer_id: "A", product_id: "mouse-x", variant: "black", seller: "Acme", availability: { status: "in_stock", evidence_status: "verified" }, risk_status: "low", purchase_gate: "eligible_for_other_shopping_checks", distinctions: { identity_exact: true, condition: "new" } },
  ] }),
  merchant: attestShoppingArtifact("merchant", { evaluated_at: "2026-08-22T20:00:00.000Z", assessments: [
    { id: "A", status: "verified_established", purchase_gate: "eligible_for_other_shopping_checks", roles: { seller: { name: "Acme" }, merchant_of_record: { name: "Example Store" } } },
  ] }),
  protection: attestShoppingArtifact("protection", { evaluated_at: "2026-08-22T20:00:00.000Z", assessments: [
    { id: "A", product_id: "mouse-x", variant: "black", condition: "new", seller: "Acme", status: "eligible", purchase_gate: "eligible_for_offer_analysis", deadlines: { return_deadline: "2026-09-22T20:00:00.000Z", warranty_expiration: "2027-08-22T20:00:00.000Z" } },
  ] }),
  identity: attestShoppingArtifact("identity", { evaluated_at: "2026-08-22T20:00:00.000Z", target_product_id: "mouse-x", resolutions: [
    { candidate_id: "A", offer_variant: "black", classification: "exact_match", safe_to_compare_offers: true, confidence: 1, canonical: { condition: "new" } },
  ] }),
  safety: attestShoppingArtifact("safety", { evaluated_at: "2026-08-22T20:00:00.000Z", jurisdiction: "US", assessments: [
    { id: "A", product_key: "mouse-x", variant: "black", condition: "new", seller: "Acme", action: "eligible", safety_cleared_for_ranking: true, purchase_allowed: false, warnings: [] },
  ] }),
  product_clearance: productClearance("mouse-x"),
};

test("checkout evidence extracts every charge with provenance", () => {
  const result = extractCheckoutEvidence({
    url: "https://shop.example/checkout",
    page_text: "Subtotal: $100.00\nCoupon -$10.00\nShipping: FREE\nEstimated tax: $7.20\nFees: $0.00\nOrder total: $97.20\nArrives: Tuesday\nCoupon code SAVE10 applied",
  });
  assert.equal(result.facts.subtotal_usd.value, 100);
  assert.equal(result.facts.discount_usd.value, 10);
  assert.equal(result.facts.shipping_usd.value, 0);
  assert.equal(result.facts.tax_usd.value, 7.2);
  assert.equal(result.facts.fees_usd.value, 0);
  assert.equal(result.facts.total_usd.value, 97.2);
  assert.equal(result.facts.delivery.value, "Tuesday");
  assert.equal(result.facts.applied_coupon.value, "SAVE10");
  assert.deepEqual(result.warnings, []);
});

test("ready preflight reconciles totals but never authorizes purchase", () => {
  const result = preflightShoppingCheckout(base);
  assert.equal(result.status, "ready_for_confirmation");
  assert.equal(result.computed_total_usd, 97.2);
  assert.equal(result.confirmation_required, true);
  assert.equal(result.purchase_allowed, false);
  assert.equal(result.next_action, "present_to_user_for_explicit_confirmation");
  assert.equal(result.confirmation_summary.total_usd, 97.2);
  assert.equal(result.confirmation_summary.product_decision_clearance.dossier_id, base.product_clearance.dossier_id);
});

test("signed checkout evidence binds exact item, stock, and every displayed charge", () => {
  const input = structuredClone(base);
  bindCurrentCheckout(input);
  let result = preflightShoppingCheckout(input);
  assert.equal(result.status, "ready_for_confirmation");

  input.cart.reported_total_usd = 98.2;
  result = preflightShoppingCheckout(input);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("checkout_total_evidence_mismatch"));

  const stockLie = structuredClone(base);
  bindCurrentCheckout(stockLie, observedCheckoutText.replace("Stock: in stock", "Stock: out of stock"));
  result = preflightShoppingCheckout(stockLie);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("checkout_stock_evidence_out_of_stock"));

  const tampered = structuredClone(base);
  bindCurrentCheckout(tampered);
  tampered.checkout_evidence.facts.total_usd.value = 1;
  result = preflightShoppingCheckout(tampered);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("checkout_evidence_unverified"));
});

test("signed checkout evidence blocks transcribed identity and confirmation-detail substitutions", () => {
  const mutations = [
    [(input) => { input.cart.items[0].variant = "white"; }, "checkout_variant_evidence_mismatch"],
    [(input) => { input.cart.items[0].condition = "used"; }, "checkout_condition_evidence_mismatch"],
    [(input) => { input.cart.merchant = "Different Merchant"; }, "checkout_merchant_evidence_mismatch"],
    [(input) => { input.cart.return_policy = "Final sale"; }, "checkout_return_policy_evidence_mismatch"],
    [(input) => { input.cart.payment_method_summary = "Mastercard ending 9999"; }, "checkout_payment_method_evidence_mismatch"],
    [(input) => { input.cart.shipping_destination_summary = "Other ZIP 10001"; }, "checkout_shipping_destination_evidence_mismatch"],
  ];
  for (const [mutate, expectedCode] of mutations) {
    const input = structuredClone(base);
    bindCurrentCheckout(input);
    mutate(input);
    const result = preflightShoppingCheckout(input);
    assert.equal(result.status, "mismatch", expectedCode);
    assert.ok(result.mismatches.includes(expectedCode), expectedCode);
  }
});

test("checkout cannot inherit merchant clearance from another signed snapshot or lookalike origin", () => {
  const changedSnapshot = structuredClone(base);
  bindCurrentCheckout(changedSnapshot);
  changedSnapshot.checkout_evidence = signedCheckoutEvidence(`${observedCheckoutText}\nSecurity badge: verified`);
  let result = preflightShoppingCheckout(changedSnapshot);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("merchant_trust_unverified"));

  const lookalike = structuredClone(base);
  bindCurrentCheckout(lookalike);
  lookalike.checkout_evidence = signedCheckoutEvidence(observedCheckoutText, "2026-08-22T20:00:00.000Z", "https://shop-example.invalid/checkout");
  result = preflightShoppingCheckout(lookalike);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("merchant_trust_unverified"));
});

test("checkout requires the same fresh exact-product decision clearance used before offer ranking", () => {
  const missing = structuredClone(base);
  delete missing.product_clearance;
  let result = preflightShoppingCheckout(missing);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("product_decision_clearance_unverified"));

  const stale = structuredClone(base);
  stale.product_clearance.evaluated_at = "2026-08-22T18:00:00.000Z";
  result = preflightShoppingCheckout(stale);
  assert.ok(result.unresolved.includes("product_decision_clearance_unverified"));

  const swapped = structuredClone(base);
  swapped.product_clearance.product_id = "mouse-y";
  swapped.product_clearance.decision.selected_product = "mouse-y";
  result = preflightShoppingCheckout(swapped);
  assert.ok(result.unresolved.includes("product_decision_clearance_unverified"));

  const uncleared = structuredClone(base);
  uncleared.product_clearance.decision.action = "research_more";
  result = preflightShoppingCheckout(uncleared);
  assert.ok(result.unresolved.includes("product_decision_clearance_unverified"));

  const forged = structuredClone(base);
  forged.product_clearance.clearance_attestation = `v1.${"0".repeat(64)}`;
  result = preflightShoppingCheckout(forged);
  assert.ok(result.unresolved.includes("product_decision_clearance_unverified"));
});

test("unknown charges and delivery prevent confirmation", () => {
  const input = structuredClone(base);
  input.cart.tax_usd = null;
  input.cart.delivery_estimate = null;
  const result = preflightShoppingCheckout(input);
  assert.equal(result.status, "needs_verification");
  assert.deepEqual(result.unresolved, ["tax_unresolved", "delivery_unresolved"]);
  assert.equal(result.confirmation_summary, null);
});

test("variant, seller, quantity, and stock changes stop checkout", () => {
  const input = structuredClone(base);
  Object.assign(input.cart.items[0], { variant: "white", seller: "Other", quantity: 2, stock: "out_of_stock" });
  input.cart.subtotal_usd = 200;
  input.cart.reported_total_usd = 197.2;
  const result = preflightShoppingCheckout(input);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("variant_mismatch"));
  assert.ok(result.mismatches.includes("seller_mismatch"));
  assert.ok(result.mismatches.includes("quantity_mismatch"));
  assert.ok(result.mismatches.includes("out_of_stock"));
});

test("bad arithmetic, ineligible coupons, and missing required coupons stop checkout", () => {
  const input = structuredClone(base);
  input.expected.required_coupon_code = "MUSTSAVE";
  input.cart.discounts[0].eligible = false;
  input.cart.reported_total_usd = 95;
  const result = preflightShoppingCheckout(input);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("ineligible_discount_applied"));
  assert.ok(result.mismatches.includes("required_coupon_not_applied"));
  assert.ok(result.mismatches.includes("total_mismatch"));
});

test("price and budget increases are explicit blockers", () => {
  const input = structuredClone(base);
  input.cart.tax_usd = 25;
  input.cart.reported_total_usd = 115;
  input.expected.max_total_usd = 110;
  input.expected.max_price_increase_usd = 10;
  const result = preflightShoppingCheckout(input);
  assert.ok(result.mismatches.includes("max_total_exceeded"));
  assert.ok(result.mismatches.includes("price_increase_exceeded"));
});

test("checkout preserves strict under-budget semantics at the exact boundary", () => {
  const inclusive = structuredClone(base);
  inclusive.expected.max_total_usd = 97.2;
  inclusive.expected.max_total_operator = "lte";
  assert.equal(preflightShoppingCheckout(inclusive).status, "ready_for_confirmation");
  const strict = structuredClone(inclusive);
  strict.expected.max_total_operator = "lt";
  assert.ok(preflightShoppingCheckout(strict).mismatches.includes("max_total_exceeded"));
});

test("unexpected items and stale checkout evidence stop confirmation", () => {
  const input = structuredClone(base);
  input.cart.items.push({ id: "EXTRA", product_key: "warranty", quantity: 1, unit_price_usd: 20, stock: "in_stock", stock_verified: true });
  input.cart.subtotal_usd = 120;
  input.cart.reported_total_usd = 117.2;
  input.cart.captured_at = "2026-08-22T19:00:00.000Z";
  const result = preflightShoppingCheckout(input);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("unexpected_cart_items"));
  assert.ok(result.mismatches.includes("checkout_evidence_stale"));
});

test("unverified seller, returns, payment, and destination remain unresolved", () => {
  const input = structuredClone(base);
  input.cart.items[0].seller_verified = false;
  input.cart.return_policy_verified = false;
  input.cart.payment_method_summary = null;
  input.cart.shipping_destination_summary = null;
  const result = preflightShoppingCheckout(input);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("seller_unverified"));
  assert.ok(result.unresolved.includes("return_policy_unverified"));
  assert.ok(result.unresolved.includes("payment_method_unresolved"));
  assert.ok(result.unresolved.includes("shipping_destination_unresolved"));
});

test("checkout cannot confirm without fresh exact seller authenticity clearance", () => {
  const missing = structuredClone(base);
  delete missing.counterfeit;
  let result = preflightShoppingCheckout(missing);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("counterfeit_risk_unverified"));

  const stale = structuredClone(base);
  stale.counterfeit.evaluated_at = "2026-08-22T18:00:00.000Z";
  reattest(stale, "counterfeit");
  result = preflightShoppingCheckout(stale);
  assert.ok(result.unresolved.includes("counterfeit_risk_unverified"));

  const swapped = structuredClone(base);
  swapped.cart.items[0].seller = "Different Seller";
  swapped.cart.items[0].seller_verified = true;
  result = preflightShoppingCheckout(swapped);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("seller_mismatch"));
  assert.ok(result.unresolved.includes("counterfeit_risk_unverified"));
});

test("unknown authenticity needs research and elevated risk stops checkout", () => {
  const unknown = structuredClone(base);
  unknown.counterfeit.assessments[0].risk_status = "unknown";
  unknown.counterfeit.assessments[0].purchase_gate = "research_more";
  reattest(unknown, "counterfeit");
  let result = preflightShoppingCheckout(unknown);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("counterfeit_risk_unresolved"));

  const elevated = structuredClone(base);
  elevated.counterfeit.assessments[0].risk_status = "elevated";
  elevated.counterfeit.assessments[0].purchase_gate = "avoid_offer";
  reattest(elevated, "counterfeit");
  result = preflightShoppingCheckout(elevated);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("counterfeit_risk_elevated"));
  assert.equal(result.confirmation_summary, null);
});

test("checkout cannot use a current raw stock claim to repair unresolved ranking availability", () => {
  const unknown = structuredClone(base);
  unknown.counterfeit.assessments[0].availability = { status: "unknown", evidence_status: "unknown" };
  reattest(unknown, "counterfeit");
  let result = preflightShoppingCheckout(unknown);
  assert.equal(unknown.cart.items[0].stock, "in_stock");
  assert.equal(unknown.cart.items[0].stock_verified, true);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("ranking_availability_unverified"));

  const unavailable = structuredClone(base);
  unavailable.counterfeit.assessments[0].availability = { status: "out_of_stock", evidence_status: "verified" };
  reattest(unavailable, "counterfeit");
  result = preflightShoppingCheckout(unavailable);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("ranking_availability_out_of_stock"));
});

test("checkout enforces the signed authorized-seller requirement separately from counterfeit risk", () => {
  const failed = structuredClone(base);
  Object.assign(failed.counterfeit.assessments[0], {
    risk_status: "acceptable",
    purchase_gate: "avoid_offer",
    authorization_requirement: { required: true, status: "failed", gate: "avoid_offer" },
    requirement_failures: ["authorized_seller_required"],
  });
  reattest(failed, "counterfeit");
  let result = preflightShoppingCheckout(failed);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("authorized_seller_requirement_failed"));
  assert.ok(!result.mismatches.includes("counterfeit_risk_elevated"));

  const unresolved = structuredClone(base);
  Object.assign(unresolved.counterfeit.assessments[0], {
    risk_status: "low",
    purchase_gate: "research_more",
    authorization_requirement: { required: true, status: "unknown", gate: "research_more" },
    requirement_unknowns: ["authorized_seller_required"],
  });
  reattest(unresolved, "counterfeit");
  result = preflightShoppingCheckout(unresolved);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("authorized_seller_requirement_unresolved"));
  assert.ok(!result.unresolved.includes("counterfeit_risk_unresolved"));

  const satisfied = structuredClone(base);
  Object.assign(satisfied.counterfeit.assessments[0], {
    authorization_requirement: { required: true, status: "satisfied", gate: "eligible_for_other_shopping_checks" },
  });
  reattest(satisfied, "counterfeit");
  result = preflightShoppingCheckout(satisfied);
  assert.equal(result.status, "ready_for_confirmation");
  assert.equal(result.confirmation_summary.authenticity.authorized_seller_requirement, "satisfied");

  const contradictory = structuredClone(base);
  Object.assign(contradictory.counterfeit.assessments[0], {
    purchase_gate: "avoid_offer",
    authorization_requirement: { required: false, status: "failed", gate: "avoid_offer" },
  });
  reattest(contradictory, "counterfeit");
  result = preflightShoppingCheckout(contradictory);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("counterfeit_risk_unverified"));
});

test("checkout revalidates merchant of record and recourse clearance", () => {
  const missing = structuredClone(base);
  delete missing.merchant;
  let result = preflightShoppingCheckout(missing);
  assert.equal(result.status, "needs_verification");
  assert.ok(result.unresolved.includes("merchant_trust_unverified"));

  const merchantSwap = structuredClone(base);
  merchantSwap.cart.merchant = "Different Merchant";
  result = preflightShoppingCheckout(merchantSwap);
  assert.ok(result.unresolved.includes("merchant_trust_unverified"));

  const stale = structuredClone(base);
  stale.merchant.evaluated_at = "2026-08-22T18:00:00.000Z";
  reattest(stale, "merchant");
  result = preflightShoppingCheckout(stale);
  assert.ok(result.unresolved.includes("merchant_trust_unverified"));

  const unknown = structuredClone(base);
  unknown.merchant.assessments[0].status = "unknown";
  unknown.merchant.assessments[0].purchase_gate = "research_more";
  reattest(unknown, "merchant");
  result = preflightShoppingCheckout(unknown);
  assert.ok(result.unresolved.includes("merchant_trust_unresolved"));

  const rejected = structuredClone(base);
  rejected.merchant.assessments[0].status = "elevated";
  rejected.merchant.assessments[0].purchase_gate = "avoid_offer";
  reattest(rejected, "merchant");
  result = preflightShoppingCheckout(rejected);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("merchant_trust_rejected"));
});

test("checkout revalidates exact-offer return and warranty protection", () => {
  const missing = structuredClone(base);
  delete missing.protection;
  let result = preflightShoppingCheckout(missing);
  assert.ok(result.unresolved.includes("purchase_protection_unverified"));

  const stale = structuredClone(base);
  stale.protection.evaluated_at = "2026-08-22T18:00:00.000Z";
  reattest(stale, "protection");
  result = preflightShoppingCheckout(stale);
  assert.ok(result.unresolved.includes("purchase_protection_unverified"));

  const wrongConditionScope = structuredClone(base);
  wrongConditionScope.protection.assessments[0].condition = "open_box";
  reattest(wrongConditionScope, "protection");
  result = preflightShoppingCheckout(wrongConditionScope);
  assert.ok(result.unresolved.includes("purchase_protection_unverified"));

  const research = structuredClone(base);
  research.protection.assessments[0].status = "needs_research";
  research.protection.assessments[0].purchase_gate = "research_more";
  reattest(research, "protection");
  result = preflightShoppingCheckout(research);
  assert.ok(result.unresolved.includes("purchase_protection_unresolved"));

  const rejected = structuredClone(base);
  rejected.protection.assessments[0].status = "rejected";
  rejected.protection.assessments[0].purchase_gate = "avoid_offer";
  reattest(rejected, "protection");
  result = preflightShoppingCheckout(rejected);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("purchase_protection_rejected"));
});

test("checkout cannot confirm a lookalike or identity-scope swap", () => {
  const missing = structuredClone(base);
  delete missing.identity;
  let result = preflightShoppingCheckout(missing);
  assert.ok(result.unresolved.includes("canonical_identity_unverified"));

  const lookalike = structuredClone(base);
  lookalike.identity.resolutions[0].classification = "different_edition";
  lookalike.identity.resolutions[0].safe_to_compare_offers = false;
  reattest(lookalike, "identity");
  result = preflightShoppingCheckout(lookalike);
  assert.ok(result.unresolved.includes("canonical_identity_unverified"));

  const variantSwap = structuredClone(base);
  variantSwap.identity.resolutions[0].offer_variant = "white";
  reattest(variantSwap, "identity");
  result = preflightShoppingCheckout(variantSwap);
  assert.ok(result.unresolved.includes("canonical_identity_unverified"));

  const stale = structuredClone(base);
  stale.identity.evaluated_at = "2026-08-22T18:00:00.000Z";
  reattest(stale, "identity");
  result = preflightShoppingCheckout(stale);
  assert.ok(result.unresolved.includes("canonical_identity_unverified"));
});

test("checkout revalidates official safety jurisdiction and action", () => {
  const missing = structuredClone(base);
  delete missing.safety;
  let result = preflightShoppingCheckout(missing);
  assert.ok(result.unresolved.includes("official_product_safety_unverified"));

  const wrongJurisdiction = structuredClone(base);
  wrongJurisdiction.safety.jurisdiction = "CA";
  reattest(wrongJurisdiction, "safety");
  result = preflightShoppingCheckout(wrongJurisdiction);
  assert.ok(result.unresolved.includes("official_product_safety_unverified"));

  const stale = structuredClone(base);
  stale.safety.evaluated_at = "2026-08-20T18:00:00.000Z";
  reattest(stale, "safety");
  result = preflightShoppingCheckout(stale);
  assert.ok(result.unresolved.includes("official_product_safety_unverified"));

  const wrongSerial = structuredClone(base);
  wrongSerial.cart.items[0].serial_number = "UNIT-200";
  wrongSerial.safety.assessments[0].serial_number = "UNIT-100";
  reattest(wrongSerial, "safety");
  result = preflightShoppingCheckout(wrongSerial);
  assert.ok(result.unresolved.includes("official_product_safety_unverified"));

  const recalled = structuredClone(base);
  recalled.safety.assessments[0].action = "avoid_product";
  recalled.safety.assessments[0].safety_cleared_for_ranking = false;
  reattest(recalled, "safety");
  result = preflightShoppingCheckout(recalled);
  assert.equal(result.status, "mismatch");
  assert.ok(result.mismatches.includes("official_product_safety_blocked"));

  const certificationUnknown = structuredClone(base);
  certificationUnknown.safety.assessments[0].action = "research_more";
  certificationUnknown.safety.assessments[0].safety_cleared_for_ranking = false;
  reattest(certificationUnknown, "safety");
  result = preflightShoppingCheckout(certificationUnknown);
  assert.ok(result.unresolved.includes("official_product_safety_unresolved"));
});
