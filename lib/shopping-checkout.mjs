import { validateCounterfeitAssessment } from "./shopping-counterfeit.mjs";
import { validateMerchantTrustAssessment } from "./shopping-merchant-trust.mjs";
import { validateProtectionAssessment } from "./shopping-protection.mjs";
import { validateIdentityResolution } from "./shopping-identity.mjs";
import { validateSafetyAssessment } from "./shopping-safety.mjs";
import { validateProductClearance } from "./shopping-dossier.mjs";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const cents = (value) => Math.round(value * 100) / 100;
const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

function money(value) {
  const number = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? cents(number) : null;
}

function fact(text, patterns, transform = money) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = transform(match[1] ?? match[0]);
    if (value == null || value === "") continue;
    return { value, status: "explicit", evidence: [{ excerpt: match[0].replace(/\s+/g, " ").trim().slice(0, 300), start: match.index ?? 0 }] };
  }
  return { value: null, status: "unknown", evidence: [] };
}

export function extractCheckoutEvidence({ page_text = "", url = null, captured_at = null }) {
  const text = String(page_text).slice(0, 200_000);
  const subtotal = fact(text, [/(?:^|\n)\s*(?:items?\s+)?subtotal\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im]);
  let shipping = fact(text, [/(?:^|\n)\s*(?:shipping|delivery)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im]);
  const free = /(?:^|\n)\s*(?:shipping|delivery)\s*[:\-]?\s*free\b/im.exec(text);
  if (shipping.status === "unknown" && free) shipping = { value: 0, status: "explicit", evidence: [{ excerpt: free[0].replace(/\s+/g, " ").trim(), start: free.index ?? 0 }] };
  const tax = fact(text, [/(?:^|\n)\s*(?:estimated\s+)?tax(?:es)?\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im]);
  let fees = fact(text, [/(?:^|\n)\s*(?:service\s+fees?|fees?)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im]);
  const noFees = /(?:^|\n)\s*(?:service\s+fees?|fees?)\s*[:\-]?\s*(?:none|\$?0(?:\.00)?)\b/im.exec(text);
  if (fees.status === "unknown" && noFees) fees = { value: 0, status: "explicit", evidence: [{ excerpt: noFees[0].replace(/\s+/g, " ").trim(), start: noFees.index ?? 0 }] };
  const total = fact(text, [/(?:^|\n)\s*(?:order\s+total|grand\s+total|total)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im]);
  const discount = fact(text, [/(?:^|\n)\s*(?:discount|promo(?:tion)?|coupon)\b[^\n$-]*(?:-\s*\$|\$\s*-)([\d,]+(?:\.\d{1,2})?)/im]);
  const delivery = fact(text, [
    /(?:arrives?|get it by|(?:estimated\s+)?delivery\s+(?:date|window))\s*[:\-]?\s*([^\n]{3,120})/i,
    /(?:^|\n)\s*delivery\s*:\s*(?!free\b|\$)([^\n]{3,120})/im,
  ], (value) => String(value).replace(/\s+/g, " ").trim());
  const coupon = fact(text, [/(?:promo|coupon)\s+code\s+([A-Za-z0-9_-]{2,40})\s+(?:applied|accepted)/i], (value) => String(value));
  const offerId = fact(text, [/(?:^|\n)\s*offer\s+id\s*[:#-]\s*([^\n|•]{1,160})/im], (value) => String(value).trim());
  const productKey = fact(text, [/(?:^|\n)\s*product\s+key\s*[:#-]\s*([^\n|•]{1,160})/im], (value) => String(value).trim());
  const variant = fact(text, [/(?:^|\n)\s*variant\s*[:#-]\s*([^\n|•]{1,160})/im], (value) => String(value).trim());
  const condition = fact(text, [/(?:^|\n)\s*condition\s*[:#-]\s*(new|used|open[\s-]*box|refurbished|renewed)/im], (value) => String(value).trim().toLowerCase().replace(/[\s-]+/g, "_").replace("renewed", "refurbished"));
  const seller = fact(text, [/(?:^|\n)\s*(?:sold\s+by|seller)\s*[:#-]\s*([^\n|•]{1,300})/im], (value) => String(value).trim());
  const merchant = fact(text, [/(?:^|\n)\s*(?:merchant\s+of\s+record|merchant)\s*[:#-]\s*([^\n|•]{1,300})/im], (value) => String(value).trim());
  const quantity = fact(text, [/(?:^|\n)\s*quantity\s*[:#-]\s*(\d{1,7})\b/im], (value) => Number(value));
  const unitPrice = fact(text, [/(?:^|\n)\s*unit\s+price\s*[:#-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im]);
  const stock = fact(text, [/(?:^|\n)\s*(?:stock|availability)\s*[:#-]\s*(in\s+stock|out\s+of\s+stock|sold\s+out|currently\s+unavailable)/im], (value) => /out|sold|unavailable/i.test(value) ? "out_of_stock" : "in_stock");
  const returnPolicy = fact(text, [/(?:^|\n)\s*return\s+policy\s*[:#-]\s*([^\n|•]{1,500})/im], (value) => String(value).trim());
  const paymentMethod = fact(text, [/(?:^|\n)\s*payment\s+method\s*[:#-]\s*([^\n|•]{1,300})/im], (value) => /\b\d{12,19}\b/.test(value) ? null : String(value).trim());
  const shippingDestination = fact(text, [/(?:^|\n)\s*shipping\s+destination(?:\s+summary)?\s*[:#-]\s*([^\n|•]{1,500})/im], (value) => {
    const cleaned = String(value).trim();
    return /\b\d{1,6}\s+[A-Za-z][^\n]{0,120}\b(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd)\b/i.test(cleaned) ? null : cleaned;
  });
  return {
    source: { url, captured_at },
    facts: { offer_id: offerId, product_key: productKey, variant, condition, seller, merchant_of_record: merchant, quantity, unit_price_usd: unitPrice, stock, return_policy: returnPolicy, payment_method: paymentMethod, shipping_destination: shippingDestination, subtotal_usd: subtotal, discount_usd: discount, shipping_usd: shipping, tax_usd: tax, fees_usd: fees, total_usd: total, delivery, applied_coupon: coupon },
    warnings: [
      ...(subtotal.status === "unknown" ? ["subtotal_unresolved"] : []),
      ...(shipping.status === "unknown" ? ["shipping_unresolved"] : []),
      ...(tax.status === "unknown" ? ["tax_unresolved"] : []),
      ...(fees.status === "unknown" ? ["fees_unresolved"] : []),
      ...(total.status === "unknown" ? ["total_unresolved"] : []),
      ...(delivery.status === "unknown" ? ["delivery_unresolved"] : []),
    ],
  };
}

function validateCheckoutEvidence(artifact, evaluatedAt, maxAgeSeconds) {
  if (!verifyShoppingArtifactAttestation("checkout_evidence", artifact)
    || !verifyShoppingArtifactAttestation("browser_snapshot", artifact?.source_receipt)) return null;
  const captured = Date.parse(artifact.source?.captured_at || "");
  const receiptCaptured = Date.parse(artifact.source_receipt?.captured_at || "");
  if (!Number.isFinite(captured) || captured !== receiptCaptured
    || artifact.source?.url !== artifact.source_receipt?.url
    || artifact.source_receipt?.truncated === true
    || captured > evaluatedAt + 5_000 || evaluatedAt - captured > maxAgeSeconds * 1_000) return null;
  return artifact;
}

const explicitCheckoutFact = (artifact, name) => artifact?.facts?.[name]?.status === "explicit" ? artifact.facts[name].value : null;

export function preflightShoppingCheckout({ expected = {}, cart = {}, checkout_evidence = null, counterfeit = null, merchant = null, protection = null, identity = null, safety = null, product_clearance = null }) {
  const mismatches = [];
  const unresolved = [];
  const evaluated = Date.parse(expected.evaluated_at || new Date().toISOString());
  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length) mismatches.push("cart_empty");
  const item = expected.offer_id ? items.find((candidate) => same(candidate.id, expected.offer_id)) : items[0];
  const signedCheckout = checkout_evidence == null ? null : validateCheckoutEvidence(checkout_evidence, evaluated, expected.max_evidence_age_seconds ?? 120);
  if (checkout_evidence != null && !signedCheckout) unresolved.push("checkout_evidence_unverified");
  if (!item && items.length) mismatches.push("expected_offer_missing");
  if (expected.offer_id && expected.allow_additional_items !== true && items.some((candidate) => !same(candidate.id, expected.offer_id))) mismatches.push("unexpected_cart_items");
  let counterfeitResult = null;
  let merchantResult = null;
  let protectionResult = null;
  let identityResult = null;
  let safetyResult = null;
  let productClearanceResult = null;
  if (item) {
    if (expected.product_key && !same(item.product_key, expected.product_key)) mismatches.push("product_mismatch");
    if (expected.variant && !same(item.variant, expected.variant)) mismatches.push("variant_mismatch");
    if (expected.condition && !same(item.condition, expected.condition)) mismatches.push("condition_mismatch");
    if (finite(expected.quantity) && item.quantity !== expected.quantity) mismatches.push("quantity_mismatch");
    if (expected.seller && !same(item.seller, expected.seller)) mismatches.push("seller_mismatch");
    else if (expected.seller && item.seller_verified !== true) unresolved.push("seller_unverified");
    if (item.stock === "out_of_stock") mismatches.push("out_of_stock");
    else if (item.stock !== "in_stock" || item.stock_verified !== true) unresolved.push("stock_unverified");
    if (signedCheckout) {
      const signedOfferId = explicitCheckoutFact(signedCheckout, "offer_id");
      const signedProductKey = explicitCheckoutFact(signedCheckout, "product_key");
      const signedVariant = explicitCheckoutFact(signedCheckout, "variant");
      const signedCondition = explicitCheckoutFact(signedCheckout, "condition");
      const signedSeller = explicitCheckoutFact(signedCheckout, "seller");
      const signedQuantity = explicitCheckoutFact(signedCheckout, "quantity");
      const signedUnitPrice = explicitCheckoutFact(signedCheckout, "unit_price_usd");
      const signedStock = explicitCheckoutFact(signedCheckout, "stock");
      for (const [value, code] of [[signedOfferId, "checkout_offer_evidence_unresolved"], [signedProductKey, "checkout_product_evidence_unresolved"], [signedSeller, "checkout_seller_evidence_unresolved"], [signedQuantity, "checkout_quantity_evidence_unresolved"], [signedUnitPrice, "checkout_unit_price_evidence_unresolved"], [signedStock, "checkout_stock_evidence_unresolved"]]) if (value == null) unresolved.push(code);
      if (signedOfferId != null && !same(signedOfferId, item.id)) mismatches.push("checkout_offer_evidence_mismatch");
      if (signedProductKey != null && !same(signedProductKey, item.product_key)) mismatches.push("checkout_product_evidence_mismatch");
      if ((expected.variant || item.variant) && signedVariant == null) unresolved.push("checkout_variant_evidence_unresolved");
      else if (signedVariant != null && !same(signedVariant, item.variant)) mismatches.push("checkout_variant_evidence_mismatch");
      if ((expected.condition || item.condition) && signedCondition == null) unresolved.push("checkout_condition_evidence_unresolved");
      else if (signedCondition != null && !same(signedCondition, item.condition)) mismatches.push("checkout_condition_evidence_mismatch");
      if (signedSeller != null && !same(signedSeller, item.seller)) mismatches.push("checkout_seller_evidence_mismatch");
      if (signedQuantity != null && signedQuantity !== item.quantity) mismatches.push("checkout_quantity_evidence_mismatch");
      if (signedUnitPrice != null && (!finite(item.unit_price_usd) || Math.abs(signedUnitPrice - item.unit_price_usd) > 0.01)) mismatches.push("checkout_unit_price_evidence_mismatch");
      if (signedStock === "out_of_stock") mismatches.push("checkout_stock_evidence_out_of_stock");
      else if (signedStock != null && signedStock !== item.stock) mismatches.push("checkout_stock_evidence_mismatch");
    }
    counterfeitResult = validateCounterfeitAssessment({ artifact: counterfeit, offer: item, evaluated_at: evaluated, max_age_seconds: expected.max_counterfeit_age_seconds ?? 3_600 });
    if (!counterfeitResult) unresolved.push("counterfeit_risk_unverified");
    else if (counterfeitResult.risk_status === "elevated") mismatches.push("counterfeit_risk_elevated");
    else if (counterfeitResult.risk_status === "unknown") unresolved.push("counterfeit_risk_unresolved");
    if (counterfeitResult?.availability?.status === "out_of_stock") mismatches.push("ranking_availability_out_of_stock");
    else if (counterfeitResult?.availability?.status !== "in_stock" || counterfeitResult?.availability?.evidence_status !== "verified") unresolved.push("ranking_availability_unverified");
    if (counterfeitResult?.authorization_requirement?.status === "failed") mismatches.push("authorized_seller_requirement_failed");
    else if (counterfeitResult?.authorization_requirement?.status === "unknown") unresolved.push("authorized_seller_requirement_unresolved");
    merchantResult = validateMerchantTrustAssessment({ artifact: merchant, offer: item, merchant_of_record: cart.merchant, checkout_evidence: signedCheckout, evaluated_at: evaluated, max_age_seconds: expected.max_merchant_age_seconds ?? 3_600 });
    if (!merchantResult) unresolved.push("merchant_trust_unverified");
    else if (merchantResult.purchase_gate === "avoid_offer") mismatches.push("merchant_trust_rejected");
    else if (merchantResult.purchase_gate === "research_more") unresolved.push("merchant_trust_unresolved");
    protectionResult = validateProtectionAssessment({ artifact: protection, offer: item, evaluated_at: evaluated, max_age_seconds: expected.max_protection_age_seconds ?? 3_600 });
    if (!protectionResult) unresolved.push("purchase_protection_unverified");
    else if (protectionResult.purchase_gate === "avoid_offer") mismatches.push("purchase_protection_rejected");
    else if (protectionResult.purchase_gate === "research_more") unresolved.push("purchase_protection_unresolved");
    identityResult = validateIdentityResolution({ artifact: identity, offer: item, evaluated_at: evaluated, max_age_seconds: expected.max_identity_age_seconds ?? 3_600 });
    if (!identityResult) unresolved.push("canonical_identity_unverified");
    safetyResult = validateSafetyAssessment({ artifact: safety, offer: item, jurisdiction: expected.destination_country, evaluated_at: evaluated, max_age_seconds: expected.max_safety_age_seconds ?? 86_400 });
    if (!safetyResult) unresolved.push("official_product_safety_unverified");
    else if (safetyResult.action === "avoid_product") mismatches.push("official_product_safety_blocked");
    else if (safetyResult.action === "research_more") unresolved.push("official_product_safety_unresolved");
    else if (safetyResult.action === "clarify_tradeoff") unresolved.push("official_product_safety_clarification_required");
    productClearanceResult = validateProductClearance({ artifact: product_clearance, product_id: item.product_key, evaluated_at: evaluated, max_age_seconds: expected.max_product_clearance_age_seconds ?? 3_600 });
    if (!productClearanceResult) unresolved.push("product_decision_clearance_unverified");
  }

  const calculatedSubtotal = items.every((entry) => finite(entry.unit_price_usd) && finite(entry.quantity))
    ? cents(items.reduce((sum, entry) => sum + entry.unit_price_usd * entry.quantity, 0))
    : null;
  if (calculatedSubtotal == null) unresolved.push("item_prices_unresolved");
  if (!finite(cart.subtotal_usd)) unresolved.push("subtotal_unresolved");
  else if (calculatedSubtotal != null && Math.abs(cart.subtotal_usd - calculatedSubtotal) > 0.01) mismatches.push("subtotal_mismatch");

  const discounts = Array.isArray(cart.discounts) ? cart.discounts : [];
  const appliedDiscount = cents(discounts.filter((entry) => entry.applied === true).reduce((sum, entry) => sum + (finite(entry.amount_usd) ? entry.amount_usd : 0), 0));
  if (discounts.some((entry) => entry.applied === true && entry.eligible === false)) mismatches.push("ineligible_discount_applied");
  if (expected.required_coupon_code && !discounts.some((entry) => same(entry.code, expected.required_coupon_code) && entry.applied === true && entry.eligible !== false)) mismatches.push("required_coupon_not_applied");
  if (signedCheckout) {
    const signedDiscount = explicitCheckoutFact(signedCheckout, "discount_usd");
    const signedCoupon = explicitCheckoutFact(signedCheckout, "applied_coupon");
    if (appliedDiscount > 0 && signedDiscount == null) unresolved.push("checkout_discount_evidence_unresolved");
    else if (signedDiscount != null && Math.abs(signedDiscount - appliedDiscount) > 0.01) mismatches.push("checkout_discount_evidence_mismatch");
    const appliedCodes = discounts.filter((entry) => entry.applied === true && entry.code).map((entry) => entry.code);
    if (appliedCodes.length && signedCoupon == null) unresolved.push("checkout_coupon_evidence_unresolved");
    else if (signedCoupon != null && !appliedCodes.some((code) => same(code, signedCoupon))) mismatches.push("checkout_coupon_evidence_mismatch");
    const signedDelivery = explicitCheckoutFact(signedCheckout, "delivery");
    if (expected.require_delivery_estimate !== false && signedDelivery == null) unresolved.push("checkout_delivery_evidence_unresolved");
    else if (signedDelivery != null && cart.delivery_estimate && !same(signedDelivery, cart.delivery_estimate)) mismatches.push("checkout_delivery_evidence_mismatch");
  }

  for (const [field, code] of [["shipping_usd", "shipping_unresolved"], ["tax_usd", "tax_unresolved"], ["fees_usd", "fees_unresolved"], ["reported_total_usd", "total_unresolved"]]) {
    if (!finite(cart[field])) unresolved.push(code);
  }
  if (expected.require_delivery_estimate !== false && !cart.delivery_estimate) unresolved.push("delivery_unresolved");
  if (expected.require_return_policy !== false && (!cart.return_policy || cart.return_policy_verified !== true)) unresolved.push("return_policy_unverified");
  if (expected.require_payment_method !== false && !cart.payment_method_summary) unresolved.push("payment_method_unresolved");
  if (expected.require_shipping_destination !== false && !cart.shipping_destination_summary) unresolved.push("shipping_destination_unresolved");
  if (!cart.merchant) unresolved.push("merchant_unresolved");
  if (signedCheckout) {
    const continuity = [
      ["merchant_of_record", cart.merchant, true, "checkout_merchant_evidence"],
      ["return_policy", cart.return_policy, expected.require_return_policy !== false, "checkout_return_policy_evidence"],
      ["payment_method", cart.payment_method_summary, expected.require_payment_method !== false, "checkout_payment_method_evidence"],
      ["shipping_destination", cart.shipping_destination_summary, expected.require_shipping_destination !== false, "checkout_shipping_destination_evidence"],
    ];
    for (const [factName, submitted, required, code] of continuity) {
      const observed = explicitCheckoutFact(signedCheckout, factName);
      if (required && observed == null) unresolved.push(`${code}_unresolved`);
      else if (observed != null && !same(observed, submitted)) mismatches.push(`${code}_mismatch`);
    }
  }

  const captured = Date.parse(cart.captured_at || "");
  if (!Number.isFinite(captured)) unresolved.push("checkout_timestamp_unresolved");
  else if (!Number.isFinite(evaluated) || captured > evaluated + 5_000) mismatches.push("checkout_timestamp_invalid");
  else if ((evaluated - captured) / 1000 > (expected.max_evidence_age_seconds ?? 120)) mismatches.push("checkout_evidence_stale");

  const computedTotal = [cart.subtotal_usd, cart.shipping_usd, cart.tax_usd, cart.fees_usd].every(finite)
    ? cents(cart.subtotal_usd - appliedDiscount + cart.shipping_usd + cart.tax_usd + cart.fees_usd)
    : null;
  if (computedTotal != null && finite(cart.reported_total_usd) && Math.abs(computedTotal - cart.reported_total_usd) > 0.01) mismatches.push("total_mismatch");
  if (signedCheckout) {
    for (const [factName, cartField, code] of [["subtotal_usd", "subtotal_usd", "checkout_subtotal_evidence_mismatch"], ["shipping_usd", "shipping_usd", "checkout_shipping_evidence_mismatch"], ["tax_usd", "tax_usd", "checkout_tax_evidence_mismatch"], ["fees_usd", "fees_usd", "checkout_fees_evidence_mismatch"], ["total_usd", "reported_total_usd", "checkout_total_evidence_mismatch"]]) {
      const signedValue = explicitCheckoutFact(signedCheckout, factName);
      if (signedValue == null) unresolved.push(`${code.replace("_mismatch", "_unresolved")}`);
      else if (!finite(cart[cartField]) || Math.abs(signedValue - cart[cartField]) > 0.01) mismatches.push(code);
    }
    const signedCaptured = signedCheckout.source?.captured_at;
    if (cart.captured_at && signedCaptured !== cart.captured_at) mismatches.push("checkout_timestamp_evidence_mismatch");
  }
  if (finite(expected.max_total_usd) && finite(cart.reported_total_usd) && (expected.max_total_operator === "lt" ? cart.reported_total_usd >= expected.max_total_usd : cart.reported_total_usd > expected.max_total_usd)) mismatches.push("max_total_exceeded");
  const priceChange = finite(expected.offer_landed_total_usd) && finite(cart.reported_total_usd)
    ? cents(cart.reported_total_usd - expected.offer_landed_total_usd)
    : null;
  if (finite(expected.max_price_increase_usd) && priceChange != null && priceChange > expected.max_price_increase_usd) mismatches.push("price_increase_exceeded");

  const uniqueMismatch = [...new Set(mismatches)];
  const uniqueUnresolved = [...new Set(unresolved)];
  const status = uniqueMismatch.length ? "mismatch" : uniqueUnresolved.length ? "needs_verification" : "ready_for_confirmation";
  return attestShoppingArtifact("checkout_preflight", {
    evaluated_at: new Date(evaluated).toISOString(),
    status,
    calculated_subtotal_usd: calculatedSubtotal,
    applied_discount_usd: appliedDiscount,
    computed_total_usd: computedTotal,
    reported_total_usd: finite(cart.reported_total_usd) ? cart.reported_total_usd : null,
    price_change_usd: priceChange,
    mismatches: uniqueMismatch,
    unresolved: uniqueUnresolved,
    confirmation_required: true,
    purchase_allowed: false,
    next_action: status === "ready_for_confirmation" ? "present_to_user_for_explicit_confirmation" : status === "mismatch" ? "stop_and_resolve_mismatch" : "verify_missing_checkout_facts",
    confirmation_summary: status === "ready_for_confirmation" ? {
      merchant: cart.merchant || null,
      item: item ? { id: item.id, product_key: item.product_key || null, variant: item.variant || null, condition: item.condition || null, quantity: item.quantity, seller: item.seller || null } : null,
      total_usd: cart.reported_total_usd,
      delivery_estimate: cart.delivery_estimate || null,
      return_policy: cart.return_policy || null,
      payment_method: cart.payment_method_summary || null,
      shipping_destination: cart.shipping_destination_summary || null,
      captured_at: cart.captured_at || null,
      authenticity: counterfeitResult ? { risk_status: counterfeitResult.risk_status, authorized_seller_requirement: counterfeitResult.authorization_requirement?.status || "not_required", ranking_availability: counterfeitResult.availability?.status || "unknown", evaluated_at: counterfeit.evaluated_at } : null,
      merchant_trust: merchantResult ? { status: merchantResult.status, merchant_of_record: merchantResult.roles.merchant_of_record.name, evaluated_at: merchant.evaluated_at } : null,
      purchase_protection: protectionResult ? { status: protectionResult.status, return_deadline: protectionResult.deadlines?.return_deadline ?? null, warranty_expiration: protectionResult.deadlines?.warranty_expiration ?? null, evaluated_at: protection.evaluated_at } : null,
      canonical_identity: identityResult ? { classification: identityResult.classification, confidence: identityResult.confidence, evaluated_at: identity.evaluated_at } : null,
      official_safety: safetyResult ? { action: safetyResult.action, warnings: safetyResult.warnings || [], jurisdiction: safety.jurisdiction, evaluated_at: safety.evaluated_at } : null,
      product_decision_clearance: productClearanceResult ? { dossier_id: productClearanceResult.dossier_id, product_id: productClearanceResult.product_id, evaluated_at: productClearanceResult.evaluated_at } : null,
    } : null,
  });
}
