const UNKNOWN = Object.freeze({ value: null, status: "unknown", evidence: [] });

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function factFromMatch(text, match, transform = (value) => clean(value)) {
  if (!match) return { ...UNKNOWN };
  const raw = match[1] ?? match[0];
  const value = transform(raw);
  if (value == null || value === "") return { ...UNKNOWN };
  const start = match.index ?? text.indexOf(match[0]);
  return {
    value,
    status: "explicit",
    evidence: [{ excerpt: clean(match[0]).slice(0, 300), start: Math.max(0, start) }],
  };
}

function derivedFact(value, excerpt) {
  if (value == null || value === "") return { ...UNKNOWN };
  return { value, status: "derived", evidence: [{ excerpt: clean(excerpt).slice(0, 300), start: 0 }] };
}

function listingOfferScope(text) {
  const markers = [
    /\n\s*Frequently Asked Questions\s*\n/i,
    /\n\s*Legal\s*\n/i,
  ];
  let end = text.length;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index < end) end = match.index;
  }
  return text.slice(0, end);
}

function appleMacStudioConfiguration(pathname) {
  const match = /\/(m\d+)-(max|ultra)-chip-(\d+)-core-cpu-(\d+)-core-gpu-(\d+)gb-memory-(\d+(?:tb|gb))-storage(?:\/|$)/i.exec(pathname || "");
  if (!match) return null;
  const chip = `${match[1].toUpperCase()} ${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}`;
  return {
    chip,
    cpu_cores: Number(match[3]),
    gpu_cores: Number(match[4]),
    memory_gb: Number(match[5]),
    storage: match[6].toUpperCase(),
    title: `Apple Mac Studio ${chip}, ${match[3]}-core CPU, ${match[4]}-core GPU, ${match[5]}GB unified memory, ${match[6].toUpperCase()} storage`,
  };
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    pattern.lastIndex = 0;
    if (match) return match;
  }
  return null;
}

function money(value) {
  const number = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function normalizedName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function collectMentions(text, code, patterns, limit = 8) {
  const mentions = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      mentions.push({ code, excerpt: clean(match[0]).slice(0, 300), start: match.index ?? 0 });
      if (mentions.length >= limit) return mentions;
    }
  }
  return mentions;
}

function parsePromotionLines(text) {
  const allowedTypes = new Set(["automatic_discount", "coupon", "instant_discount", "membership_price", "subscription_price", "cashback", "rebate", "store_credit", "loyalty_points", "trade_in", "bundle_credit", "gift_card", "financing"]);
  const allowedApplications = new Set(["applied", "available", "rejected", "unknown"]);
  const records = [];
  for (const match of text.matchAll(/(?:^|\n)\s*Promotion\s*[:#-]\s*([^\n]{1,2000})/gim)) {
    const fields = {};
    for (const part of match[1].split(";")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      fields[clean(part.slice(0, separator)).toLowerCase().replace(/[\s-]+/g, "_")] = clean(part.slice(separator + 1));
    }
    const type = clean(fields.type).toLowerCase().replace(/[\s-]+/g, "_");
    const application = clean(fields.application || fields.status).toLowerCase().replace(/[\s-]+/g, "_");
    const expiresAt = Number.isFinite(Date.parse(fields.expires || "")) ? new Date(fields.expires).toISOString() : null;
    records.push({
      id: clean(fields.id) || null,
      type: allowedTypes.has(type) ? type : null,
      code: clean(fields.code) || null,
      application_status: allowedApplications.has(application) ? application : "unknown",
      amount_applied_usd: money(fields.amount),
      deferred_value_usd: money(fields.deferred_value),
      expires_at: expiresAt,
      affects_advertised_price: /^(?:yes|true)$/i.test(fields.affects_advertised_price || ""),
      eligibility_complete: /^complete$/i.test(fields.eligibility || ""),
      obligations_complete: /^none$/i.test(fields.obligations || ""),
      stacking_verified: /^(?:yes|true|verified)$/i.test(fields.stacking || ""),
      excerpt: clean(match[0]).slice(0, 500),
      start: match.index ?? 0,
    });
    if (records.length >= 100) break;
  }
  return records;
}

export function extractShoppingPageEvidence(input) {
  const text = String(input.page_text ?? "").slice(0, 200_000);
  const pageKind = input.page_kind || "retailer_listing";
  let hostname = null;
  let pathname = "";
  try {
    const parsed = new URL(input.url);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {}
  const commerceText = pageKind === "retailer_listing" ? listingOfferScope(text) : text;
  const appleConfiguration = /(?:^|\.)apple\.com$/i.test(hostname || "") ? appleMacStudioConfiguration(pathname) : null;
  const selectedAppleSummary = appleConfiguration
    ? /(?:^|\n)\s*Your new Mac Studio\.?[\s\S]*?(?=\n\s*(?:Still deciding\?|What(?:'|’)s in the Box)\s*\n|$)/i.exec(commerceText)?.[0] || commerceText
    : commerceText;
  const offerText = appleConfiguration ? selectedAppleSummary : commerceText;

  let price = factFromMatch(offerText, firstMatch(offerText, [
    /\bbuy\s+for\s+\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:^|\n)\s*(?:current\s+price|now)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im,
    /(?:^|\n)\s*price\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/im,
    /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:current price|today)/i,
    /(?:^|\n)\s*\$\s*([\d,]+\.\d{2})\s*(?:\n|$)/m,
  ]), money);

  let shipping = factFromMatch(commerceText, firstMatch(commerceText, [
    /(?:shipping|delivery)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s*([\d,]+(?:\.\d{1,2})?)\s+(?:shipping|delivery)/i,
  ]), money);
  const freeShipping = firstMatch(commerceText, [/(?:free shipping|free delivery)/i]);
  if (shipping.status === "unknown" && freeShipping) shipping = factFromMatch(commerceText, freeShipping, () => 0);

  let seller = factFromMatch(offerText, firstMatch(offerText, [
    /ships?\s+from\s+and\s+sold\s+by\s*[:\-]?\s*([^\n|•]{1,120})/i,
    /sold\s*(?:&|and)\s*shipped\s+by\s*[:\-]?\s*([^\n|•]{1,120})/i,
    /sold\s+by\s*[:\-]?\s*([^\n|•]{1,120})/i,
    /seller\s*[:\-]\s*([^\n|•]{1,120})/i,
  ]));
  if (appleConfiguration) seller = derivedFact("Apple", `Official Apple Store configured product page: ${input.url}`);
  const fulfiller = factFromMatch(text, firstMatch(text, [
    /fulfilled\s+by\s*[:\-]?\s*([^\n|•]{1,120})/i,
    /ships?\s+from\s*[:\-]?\s*([^\n|•]{1,120})/i,
  ]));
  const merchantOfRecord = factFromMatch(text, firstMatch(text, [
    /merchant\s+of\s+record\s*[:\-]\s*([^\n|•]{1,120})/i,
    /(?:your card|statement)\s+will\s+(?:show|be charged by)\s*[:\-]?\s*([^\n|•]{1,120})/i,
  ]));
  const legalSeller = factFromMatch(text, firstMatch(text, [
    /legal\s+(?:seller|entity|business)\s*[:\-]\s*([^\n|•]{1,160})/i,
    /(?:sold|provided)\s+by\s+the\s+legal\s+entity\s*[:\-]?\s*([^\n|•]{1,160})/i,
  ]));
  const paymentProcessor = factFromMatch(text, firstMatch(text, [
    /payments?\s+(?:are\s+)?processed\s+by\s*[:\-]?\s*([^\n|•]{1,120})/i,
    /payment\s+processor\s*[:\-]\s*([^\n|•]{1,120})/i,
  ]));
  const returnRecipient = factFromMatch(text, firstMatch(text, [
    /returns?\s+(?:must\s+be\s+)?sent\s+to\s*[:\-]?\s*([^\n|•]{1,160})/i,
    /return\s+(?:recipient|address)\s*[:\-]\s*([^\n|•]{1,160})/i,
  ]));

  const paymentMethod = factFromMatch(text, firstMatch(text, [
    /payment\s+method\s*[:\-]\s*(credit\s+card|debit\s+card|paypal\s+goods(?:\s+and|\s*&)?\s+services|marketplace\s+protected|buy\s+now\s+pay\s+later|bank\s+transfer|wire\s+transfer|crypto(?:currency)?|gift\s+card|cash)\b/i,
  ]), (value) => clean(value).toLowerCase().replace(/\s*&\s*|\s+and\s+/g, "_").replace(/\s+/g, "_").replace("paypal_goods_services", "paypal_goods_services"));
  const chargebackEligible = factFromMatch(text, firstMatch(text, [
    /chargebacks?\s*[:\-]?\s*(?:are\s+)?(eligible|available|supported|included)/i,
  ]), () => true);
  const marketplaceProtection = factFromMatch(text, firstMatch(text, [
    /(?:marketplace|buyer|purchase)\s+protection\s*[:\-]?\s*(?:is\s+)?(included|available|provided|yes)/i,
  ]), () => true);

  const documentMarkers = {
    merchant_terms: factFromMatch(text, firstMatch(text, [/\b(terms\s+(?:of\s+(?:service|use)|and\s+conditions))\b/i]), () => true),
    merchant_privacy: factFromMatch(text, firstMatch(text, [/\b(privacy\s+policy)\b/i]), () => true),
    return_policy: factFromMatch(text, firstMatch(text, [/\b(return\s+policy|returns?\s+and\s+refunds?|refund\s+policy)\b/i]), () => true),
    warranty: factFromMatch(text, firstMatch(text, [/\b(warranty\s+policy|limited\s+warranty|manufacturer(?:'s)?\s+warranty)\b/i]), () => true),
    repairability: factFromMatch(text, firstMatch(text, [/\b(repair\s+manual|replacement\s+parts?\s+(?:availability|catalog)|self[-\s]*service\s+repair)\b/i]), () => true),
    checkout: factFromMatch(text, firstMatch(text, [/\b(checkout|order\s+summary|payment\s+method)\b/i]), () => true),
    order_receipt: factFromMatch(text, firstMatch(text, [/(?:^|\n)\s*(order\s+(?:receipt|confirmation)|purchase\s+receipt)\s*[:#-]?\s*(?:complete)?\b/im]), () => true),
    case_event: factFromMatch(text, firstMatch(text, [/(?:^|\n)\s*event\s+evidence\s*[:#-]\s*complete\b/im]), () => true),
    promotion_inventory: factFromMatch(text, firstMatch(text, [/(?:^|\n)\s*promotion\s+inventory\s*[:#-]\s*complete\b/im]), () => true),
    safety_authority_search: factFromMatch(text, firstMatch(text, [/\b(recall|safety)\s+(?:database|search|results?)\b/i]), () => true),
    safety_notice: factFromMatch(text, firstMatch(text, [/\b(?:recall|safety warning|sales ban|import ban|corrective action)\s+(?:notice|number|id)\b/i]), () => true),
  };

  const stockMatch = firstMatch(commerceText, [
    /\b(pre-?order(?:\s+Mac Studio)?|available starting\s+[^\n|•]{1,80})\b/i,
    /\b(currently unavailable|out of stock|sold out)\b/i,
    /\b(in stock|available for delivery|available for pickup)\b/i,
    /\b((?:shipping|delivery)\s+(?:get it|arrives?)\s+by\s+[^\n|•]{1,80})/i,
    /\b(fastest\s+delivery\s+in\s+\d{1,3}\s+(?:business\s+)?days?)\b/i,
    /\b((?:ships?|shipping|delivery)\s+(?:within|in)\s+\d{1,3}\s+(?:business\s+)?days?)\b/i,
  ]);
  const stock = factFromMatch(commerceText, stockMatch, (value) =>
    /pre-?order|available starting/i.test(value) ? "preorder"
      : /unavailable|out of stock|sold out/i.test(value) ? "out_of_stock" : "in_stock"
  );
  const offerTitle = appleConfiguration
    ? derivedFact(appleConfiguration.title, `Exact configured product URL: ${input.url}`)
    : { ...UNKNOWN };
  const configuration = appleConfiguration ? {
    chip: derivedFact(appleConfiguration.chip, pathname),
    cpu_cores: derivedFact(appleConfiguration.cpu_cores, pathname),
    gpu_cores: derivedFact(appleConfiguration.gpu_cores, pathname),
    memory_gb: derivedFact(appleConfiguration.memory_gb, pathname),
    storage: derivedFact(appleConfiguration.storage, pathname),
  } : null;

  const returnDays = factFromMatch(text, firstMatch(text, [
    /(?:free\s+)?(\d{1,3})[\s-]*day\s+returns?/i,
    /returns?\s+(?:accepted\s+)?within\s+(\d{1,3})\s+days?/i,
  ]), (value) => Number(value));

  let finalSale = { ...UNKNOWN };
  const finalSaleYes = firstMatch(text, [/\b(final sale|not returnable|returns? (?:are )?not accepted|no returns?)\b/i]);
  const finalSaleNo = firstMatch(text, [/\b(returns? accepted|eligible for returns?|returnable)\b/i]);
  if (finalSaleYes) finalSale = factFromMatch(text, finalSaleYes, () => true);
  else if (finalSaleNo) finalSale = factFromMatch(text, finalSaleNo, () => false);
  const returnWindowStartsOn = factFromMatch(text, firstMatch(text, [
    /return window (?:starts|begins) (?:on|at|after)\s*(delivery|purchase|order)/i,
    /returns? accepted (?:for|within) \d{1,3} days? (?:from|after)\s*(delivery|purchase|order)/i,
  ]), (value) => /deliver/i.test(value) ? "delivery" : "purchase");
  let openedItems = { ...UNKNOWN };
  const openedAccepted = firstMatch(text, [/\b(opened items? (?:are )?(?:accepted|returnable|eligible for returns?))\b/i]);
  const openedRejected = firstMatch(text, [/\b(opened items? (?:are )?(?:not accepted|not returnable|ineligible for returns?))\b/i]);
  const openedRestricted = firstMatch(text, [/\b(opened items? (?:are )?(?:restricted|subject to approval|case-by-case))\b/i]);
  if (openedRejected) openedItems = factFromMatch(text, openedRejected, () => "not_accepted");
  else if (openedRestricted) openedItems = factFromMatch(text, openedRestricted, () => "restricted");
  else if (openedAccepted) openedItems = factFromMatch(text, openedAccepted, () => "accepted");
  let restockingFee = factFromMatch(text, firstMatch(text, [/restocking fee\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i]), (value) => Number(value));
  const noRestockingFee = firstMatch(text, [/\b(no restocking fee|restocking fee\s*[:\-]?\s*none)\b/i]);
  if (restockingFee.status === "unknown" && noRestockingFee) restockingFee = factFromMatch(text, noRestockingFee, () => 0);
  const returnShippingPaidBy = factFromMatch(text, firstMatch(text, [
    /return shipping (?:is )?(?:paid|covered) by\s*(seller|merchant|retailer|buyer|customer)/i,
    /(seller|merchant|retailer|buyer|customer) pays return shipping/i,
  ]), (value) => /buyer|customer/i.test(value) ? "buyer" : "seller");
  const returnShippingCost = factFromMatch(text, firstMatch(text, [/return shipping (?:cost|fee)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i]), money);
  let originalShippingRefundable = { ...UNKNOWN };
  const originalShippingYes = firstMatch(text, [/\b(original shipping (?:is )?refundable|refund includes original shipping)\b/i]);
  const originalShippingNo = firstMatch(text, [/\b(original shipping (?:is )?(?:not refundable|nonrefundable)|shipping charges? (?:are )?nonrefundable)\b/i]);
  if (originalShippingNo) originalShippingRefundable = factFromMatch(text, originalShippingNo, () => false);
  else if (originalShippingYes) originalShippingRefundable = factFromMatch(text, originalShippingYes, () => true);
  const refundMethod = factFromMatch(text, firstMatch(text, [/refund method\s*[:\-]\s*(original payment|store credit|exchange only)/i]), (value) => clean(value).toLowerCase().replace(/\s+/g, "_"));

  let warranty = { ...UNKNOWN };
  const warrantyNo = firstMatch(text, [
    /(?:manufacturer(?:'s)?\s+warranty|brand warranty)\s+(?:does not apply|not included|is not valid)/i,
    /\bno manufacturer(?:'s)? warranty\b/i,
  ]);
  const warrantyYes = firstMatch(text, [
    /(?:includes?|with|covered by)\s+(?:the\s+)?manufacturer(?:'s)?\s+warranty/i,
    /manufacturer(?:'s)?\s+warranty\s*[:\-]\s*(?:yes|included|applies)/i,
  ]);
  if (warrantyNo) warranty = factFromMatch(text, warrantyNo, () => false);
  else if (warrantyYes) warranty = factFromMatch(text, warrantyYes, () => true);

  let warrantyProvider = factFromMatch(text, firstMatch(text, [
    /warranty provider\s*[:\-]\s*(manufacturer|seller|retailer|third[-\s]*party)/i,
    /covered by (?:the )?(manufacturer|seller|retailer|third[-\s]*party) warranty/i,
  ]), (value) => /manufacturer/i.test(value) ? "manufacturer" : /third/i.test(value) ? "third_party" : "seller");
  if (warrantyProvider.status === "unknown" && warranty.value === true) warrantyProvider = { ...warranty, value: "manufacturer" };
  if (warrantyProvider.status === "unknown" && warranty.value === false) warrantyProvider = { ...warranty, value: "none" };
  const warrantyDurationMatch = firstMatch(text, [
    /(?:limited\s+)?warranty(?: duration)?\s*[:\-]?\s*(\d{1,3})\s*(years?|months?)/i,
    /(\d{1,3})[-\s]*(year|month)\s+(?:limited\s+)?warranty/i,
  ]);
  const warrantyDurationMonths = factFromMatch(text, warrantyDurationMatch, (value) => Number(value) * (/year/i.test(warrantyDurationMatch?.[2] || "") ? 12 : 1));
  const warrantyAuthorizedSellerRequired = factFromMatch(text, firstMatch(text, [/warranty (?:is )?(?:valid|applies) only (?:when )?purchased from (?:an )?(authorized seller|authorized retailer)/i]), () => true);
  let warrantyRegistrationRequired = { ...UNKNOWN };
  const registrationYes = firstMatch(text, [/warranty registration (?:is )?required/i, /must register (?:the )?(?:product|warranty)/i]);
  const registrationNo = firstMatch(text, [/warranty registration (?:is )?(?:not required|optional)/i]);
  if (registrationNo) warrantyRegistrationRequired = factFromMatch(text, registrationNo, () => false);
  else if (registrationYes) warrantyRegistrationRequired = factFromMatch(text, registrationYes, () => true);
  const warrantyRegistrationDays = factFromMatch(text, firstMatch(text, [/register (?:the )?(?:product|warranty) within\s*(\d{1,4})\s*days?/i]), (value) => Number(value));
  const warrantyPartsCovered = factFromMatch(text, firstMatch(text, [/(?:warranty )?covers?\s*(?:both )?parts(?:\s+and\s+labor)?/i]), () => true);
  const warrantyLaborCovered = factFromMatch(text, firstMatch(text, [/(?:warranty )?covers?\s*(?:parts\s+and\s+)?labor/i]), () => true);
  const warrantyDeductible = factFromMatch(text, firstMatch(text, [/warranty deductible\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i]), money);
  const warrantyClaimShippingPaidBy = factFromMatch(text, firstMatch(text, [/(?:warranty )?claim shipping (?:is )?(?:paid|covered) by\s*(provider|manufacturer|seller|buyer|customer)/i]), (value) => /buyer|customer/i.test(value) ? "buyer" : "provider");
  const warrantyClaimShippingCost = factFromMatch(text, firstMatch(text, [/(?:warranty )?claim shipping (?:cost|fee)\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i]), money);
  const warrantyDowntimeDays = factFromMatch(text, firstMatch(text, [/(?:estimated )?(?:repair|warranty) downtime\s*[:\-]?\s*(\d{1,4})\s*days?/i]), (value) => Number(value));
  const buyerProtectionDays = factFromMatch(text, firstMatch(text, [/(?:marketplace|buyer|purchase) protection(?: window)?\s*[:\-]?\s*(\d{1,4})\s*days?/i]), (value) => Number(value));

  const repairPartsAvailability = factFromMatch(text, firstMatch(text, [/replacement parts? (?:are )?(widely available|manufacturer only|limited|unavailable)/i]), (value) => clean(value).toLowerCase().replace(/\s+/g, "_"));
  const repairManualAvailability = factFromMatch(text, firstMatch(text, [/(official repair manual|third[-\s]*party repair manual|no repair manual)/i]), (value) => /official/i.test(value) ? "official" : /third/i.test(value) ? "third_party" : "none");
  let criticalComponentsReplaceable = { ...UNKNOWN };
  const criticalYes = firstMatch(text, [/critical components? (?:are )?(?:replaceable|serviceable)/i]);
  const criticalNo = firstMatch(text, [/critical components? (?:are )?(?:not replaceable|not serviceable|sealed)/i]);
  if (criticalNo) criticalComponentsReplaceable = factFromMatch(text, criticalNo, () => false);
  else if (criticalYes) criticalComponentsReplaceable = factFromMatch(text, criticalYes, () => true);

  const condition = factFromMatch(text, firstMatch(text, [
    /condition\s*[:\-]\s*(new|used|open[\s-]*box|refurbished|renewed|remanufactured|display[\s-]*model|for[\s-]*parts)/i,
  ]), (value) => clean(value).toLowerCase().replace(/[\s-]+/g, "_"));
  const conditionGrade = factFromMatch(text, firstMatch(text, [
    /(?:condition\s+grade|seller\s+grade|grade)\s*[:\-]\s*([^\n|•]{1,100})/i,
  ]));
  const batteryHealth = factFromMatch(text, firstMatch(text, [
    /battery\s+health\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
    /(?:maximum\s+)?battery\s+capacity\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
  ]), (value) => Number(value));
  const batteryCycles = factFromMatch(text, firstMatch(text, [
    /battery\s+(?:cycle|cycles|cycle\s+count)\s*[:\-]?\s*(\d{1,7})\b/i,
  ]), (value) => Number(value));
  const refurbisher = factFromMatch(text, firstMatch(text, [
    /(?:refurbished|renewed|remanufactured)\s+by\s*[:\-]?\s*([^\n|•]{1,120})/i,
    /refurbisher\s*[:\-]\s*([^\n|•]{1,120})/i,
  ]));

  const identifiers = {};
  // Accessibility text sometimes concatenates adjacent definition rows
  // ("Model: 910-007500SKU: 6633199"). Restore only known label boundaries.
  const identifierText = text.replace(/([A-Za-z0-9])(?=(?:UPC|EAN|GTIN|MPN|Model|SKU|ASIN)\s*[:#-])/g, "$1\n");
  for (const [key, label] of [["upc", "UPC"], ["ean", "EAN"], ["gtin", "GTIN"], ["mpn", "MPN"], ["model", "Model"], ["sku", "SKU"], ["asin", "ASIN"]]) {
    identifiers[key] = factFromMatch(identifierText, new RegExp(`\\b${label}\\s*[:#-]\\s*([A-Za-z0-9._-]{4,40})`, "i").exec(identifierText));
  }
  const identityBrand = factFromMatch(identifierText, /\bBrand\s*[:#-]\s*([^\n|•]{1,120})/i.exec(identifierText));
  const identityProductLine = factFromMatch(identifierText, /\bProduct\s+Line\s*[:#-]\s*([^\n|•]{1,160})/i.exec(identifierText));
  const identityModel = factFromMatch(identifierText, /\bModel\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9 ._/-]{1,100})/i.exec(identifierText));
  const identityGeneration = factFromMatch(identifierText, /\bGeneration\s*[:#-]\s*([^\n|•]{1,100})/i.exec(identifierText));
  const identityEdition = factFromMatch(identifierText, /\bEdition\s*[:#-]\s*([^\n|•]{1,140})/i.exec(identifierText));
  const identityRegion = factFromMatch(identifierText, /\bRegion\s*[:#-]\s*([^\n|•]{1,100})/i.exec(identifierText));
  const identityCapacity = factFromMatch(identifierText, /\bCapacity\s*[:#-]\s*([^\n|•]{1,100})/i.exec(identifierText));
  const identitySize = factFromMatch(identifierText, /\bSize\s*[:#-]\s*([^\n|•]{1,100})/i.exec(identifierText));
  const identityColor = factFromMatch(identifierText, /\bColou?r\s*[:#-]\s*([^\n|•]{1,100})/i.exec(identifierText));
  const identityBundleCount = factFromMatch(identifierText, /\b(?:Bundle|Pack)\s+Count\s*[:#-]\s*(\d{1,6})/i.exec(identifierText), (value) => Number(value));
  const identityBundleContents = factFromMatch(identifierText, /\bBundle\s+Contents?\s*[:#-]\s*([^\n|•]{1,500})/i.exec(identifierText), (value) => clean(value).split(/\s*,\s*/).filter(Boolean));
  const identityCompatibilityKey = factFromMatch(identifierText, /\bCompatibility\s+Key\s*[:#-]\s*([^\n|•]{1,160})/i.exec(identifierText));
  const identityCompatibilityKeys = factFromMatch(identifierText, /\bCompatibility\s+Keys\s*[:#-]\s*([^\n|•]{1,500})/i.exec(identifierText), (value) => clean(value).split(/\s*,\s*/).filter(Boolean));
  if (identityBrand.status === "explicit" && (identityModel.status === "explicit" || identityProductLine.status === "explicit")) {
    documentMarkers.manufacturer_product = {
      value: true,
      status: "derived",
      evidence: [...identityBrand.evidence, ...identityModel.evidence, ...identityProductLine.evidence].slice(0, 3),
    };
  } else documentMarkers.manufacturer_product = { ...UNKNOWN };

  let authorization = { value: null, status: "unknown", evidence: [] };
  if (pageKind === "manufacturer_authorized_sellers" && input.seller_query) {
    const wanted = normalizedName(input.seller_query);
    const lines = text.split(/\r?\n/);
    const lineIndex = lines.findIndex((line) => {
      const normalized = normalizedName(line);
      const withoutLabel = normalized.replace(/^(?:authorized\s+)?(?:seller|retailer|dealer)\s+/, "");
      return normalized === wanted || withoutLabel === wanted;
    });
    if (lineIndex >= 0) {
      const excerpt = clean(lines[lineIndex]);
      authorization = { value: "explicit_match", status: "explicit", evidence: [{ excerpt: excerpt.slice(0, 300), start: text.indexOf(lines[lineIndex]) }] };
    } else if (input.directory_complete === true) {
      authorization = { value: "no_match", status: "derived", evidence: [{ excerpt: "Seller absent from user-declared complete manufacturer directory.", start: 0 }] };
    }
  }

  const review_signals = [
    ...collectMentions(text, "authenticity_complaint", [/[^\n]{0,100}\b(?:fake|counterfeit|not authentic|inauthentic)\b[^\n]{0,100}/gi]),
    ...collectMentions(text, "packaging_mismatch", [/[^\n]{0,100}\b(?:different packaging|packaging mismatch|wrong packaging)\b[^\n]{0,100}/gi]),
    ...collectMentions(text, "seal_issue", [/[^\n]{0,100}\b(?:broken seal|seal was broken|unsealed|tampered seal)\b[^\n]{0,100}/gi]),
  ].sort((a, b) => a.start - b.start).slice(0, 20);

  const label = (name, transform = (value) => clean(value)) => factFromMatch(text,
    new RegExp(`(?:^|\\n)\\s*${name}\\s*[:#-]\\s*([^\\n|•]{1,500})`, "im").exec(text), transform);
  const csv = (value) => clean(value).split(/\s*,\s*/).filter(Boolean);
  const enumLabel = (name, allowed) => label(name, (value) => {
    const result = clean(value).toLowerCase().replace(/[\s-]+/g, "_");
    return allowed.includes(result) ? result : null;
  });
  const safetyIdentifiers = {};
  for (const key of ["upc", "ean", "gtin", "mpn"]) {
    const fact = label(`Affected\\s+${key.toUpperCase()}`);
    if (fact.status === "explicit") safetyIdentifiers[key] = fact.value;
  }
  const serialRange = /(?:^|\n)\s*Affected\s+Serial\s+Range\s*[:#-]\s*([^\n|•]*?)(\d+)\s*(?:to|-)\s*(\d+)\s*(?:\n|$)/im.exec(text);
  const serialRanges = serialRange ? factFromMatch(text, serialRange, () => [{ prefix: clean(serialRange[1]), start: serialRange[2], end: serialRange[3] }]) : { ...UNKNOWN };
  const safety = {
    authority_id: label("Authority"), jurisdiction: label("Jurisdiction", (value) => clean(value).toUpperCase()),
    product_category: label("Product\\s+Category", (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_")),
    product_key: label("Product\\s+Key"),
    search_status: enumLabel("Search\\s+Status", ["complete", "partial", "error"]),
    notice: {
      id: label("(?:Notice|Recall)\\s+(?:ID|Number)"),
      notice_type: enumLabel("Notice\\s+Type", ["recall", "safety_warning", "sales_ban", "import_ban", "corrective_action"]),
      status: enumLabel("Notice\\s+Status", ["active", "remedied", "closed", "unknown"]),
      severity: enumLabel("Severity", ["critical", "serious", "moderate", "unknown"]),
      product_keys: label("Affected\\s+Product\\s+Keys?", csv), models: label("Affected\\s+Models?", csv),
      identifiers: Object.keys(safetyIdentifiers).length ? { value: safetyIdentifiers, status: "explicit", evidence: Object.values(safetyIdentifiers).flatMap((item) => item.evidence || []) } : { ...UNKNOWN },
      serial_ranges: serialRanges,
      manufactured_from: label("Manufactured\\s+From", (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null),
      manufactured_to: label("Manufactured\\s+To", (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null),
      jurisdictions: label("Affected\\s+Jurisdictions?", (value) => csv(value).map((item) => item.toUpperCase())),
      scope_complete: label("Scope\\s+Complete", (value) => /^(?:yes|true)$/i.test(clean(value)) ? true : /^(?:no|false)$/i.test(clean(value)) ? false : null),
    },
    certification: {
      scheme: label("Certification\\s+Scheme"), jurisdiction: label("Certification\\s+Jurisdiction", (value) => clean(value).toUpperCase()),
      status: enumLabel("Certification\\s+Status", ["valid", "expired", "revoked", "invalid", "unknown"]),
      applies_to_exact_model: label("Applies\\s+To\\s+Exact\\s+Model", (value) => /^(?:yes|true)$/i.test(clean(value)) ? true : /^(?:no|false)$/i.test(clean(value)) ? false : null),
      expires_at: label("Certification\\s+Expires", (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null),
    },
    remediation: {
      notice_id: label("Remediation\\s+Notice\\s+ID"),
      status: enumLabel("Remediation\\s+Status", ["completed", "available", "unavailable", "unknown"]),
      restores_compliance: label("Restores\\s+Compliance", (value) => /^(?:yes|true)$/i.test(clean(value)) ? true : /^(?:no|false)$/i.test(clean(value)) ? false : null),
    },
  };

  const order = {
    order_number: label("Order\\s+(?:Number|ID)"),
    product_id: label("Product\\s+Key"),
    purchased_at: label("Purchased\\s+At", (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null),
    delivered_at: label("Delivered\\s+At", (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null),
    currency: label("Currency", (value) => /^[A-Za-z]{3}$/.test(clean(value)) ? clean(value).toUpperCase() : null),
    item_price_usd: label("Item\\s+Price", money),
    shipping_usd: label("Order\\s+Shipping", money),
    total_usd: label("Order\\s+Total", money),
  };
  const case_event = {
    type: enumLabel("Case\\s+Event", ["delivered", "merchant_contacted", "return_requested", "return_shipped", "refund_received", "warranty_registered", "claim_opened", "claim_resolved"]),
    at: label("Event\\s+At", (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null),
    order_number: label("Order\\s+(?:Number|ID)"),
    product_id: label("Product\\s+Key"),
    reference: label("Event\\s+Reference"),
    counterparty: label("Event\\s+Counterparty"),
  };
  const booleanLabel = (name) => label(name, (value) => /^(?:yes|true|eligible|available)$/i.test(clean(value))
    ? true : /^(?:no|false|ineligible|unavailable)$/i.test(clean(value)) ? false : null);
  const dateLabel = (name) => label(name, (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
  const fulfillment = {
    offer_id: label("Offer\\s+ID"),
    product_id: label("Product\\s+Key"),
    currency: label("Currency", (value) => /^[A-Za-z]{3}$/.test(clean(value)) ? clean(value).toUpperCase() : null),
    item_price_usd: label("(?:Item|Unit)\\s+Price", money),
    discount_usd: label("(?:Discount|Promotion\\s+Discount)", (value) => {
      const parsed = money(value);
      return parsed == null ? null : Math.abs(parsed);
    }),
    tax_usd: label("Tax", money),
    import_duty_usd: label("Import\\s+Duty", money),
    brokerage_usd: label("Brokerage", money),
    carrier_surcharge_usd: label("Carrier\\s+Surcharge", money),
    currency_conversion_usd: label("Currency\\s+Conversion(?:\\s+Fee)?", money),
    total_usd: label("(?:Order|Landed)\\s+Total", money),
    charge_inventory_complete: booleanLabel("Charge\\s+Inventory\\s+Complete"),
    tax_treatment: enumLabel("Tax\\s+Treatment", ["amount", "included", "not_applicable", "unknown"]),
    import_duty_treatment: enumLabel("Import\\s+Duty\\s+Treatment", ["amount", "included", "not_applicable", "unknown"]),
    brokerage_treatment: enumLabel("Brokerage\\s+Treatment", ["amount", "included", "not_applicable", "unknown"]),
    carrier_surcharge_treatment: enumLabel("Carrier\\s+Surcharge\\s+Treatment", ["amount", "included", "not_applicable", "unknown"]),
    currency_conversion_treatment: enumLabel("Currency\\s+Conversion\\s+Treatment", ["amount", "included", "not_applicable", "unknown"]),
    ships_from_country: label("Ships\\s+From\\s+Country", (value) => /^[A-Za-z]{2}$/.test(clean(value)) ? clean(value).toUpperCase() : null),
    destination_country: label("Destination\\s+Country", (value) => /^[A-Za-z]{2}$/.test(clean(value)) ? clean(value).toUpperCase() : null),
    destination_eligible: booleanLabel("Destination\\s+Eligible"),
    incoterm: enumLabel("Incoterm", ["ddp", "dap", "dpu", "cpt", "cip", "exw", "fca", "fas", "fob", "cfr", "cif", "domestic", "unknown"]),
    customs_restricted_or_prohibited: booleanLabel("Customs\\s+Restricted\\s+Or\\s+Prohibited"),
    customs_clearance_responsibility: enumLabel("Customs\\s+Clearance\\s+Responsibility", ["seller", "buyer", "carrier", "marketplace", "unknown"]),
    customs_documents_complete: booleanLabel("Customs\\s+Documents\\s+Complete"),
    delivery_earliest_at: dateLabel("Delivery\\s+Earliest"),
    delivery_latest_at: dateLabel("Delivery\\s+Latest"),
    tracking_available: booleanLabel("Tracking\\s+Available"),
    return_destination_country: label("Return\\s+Destination\\s+Country", (value) => /^[A-Za-z]{2}$/.test(clean(value)) ? clean(value).toUpperCase() : null),
    refundable_import_charges: booleanLabel("Refundable\\s+Import\\s+Charges"),
  };
  const promotions = parsePromotionLines(text);

  const warnings = [];
  if (price.status === "unknown" && pageKind === "retailer_listing") warnings.push("price_not_found");
  if (seller.status === "unknown" && pageKind === "retailer_listing") warnings.push("seller_not_found");
  if (shipping.status === "unknown" && pageKind === "retailer_listing") warnings.push("shipping_unresolved");

  return {
    source: { url: input.url || null, hostname, page_kind: pageKind, captured_at: input.captured_at || null },
    extraction_scope: {
      seller_query: input.seller_query || null,
      directory_complete: input.directory_complete === true,
    },
    facts: {
      offer_title: offerTitle, configuration,
      price_usd: price, shipping_usd: shipping, seller, legal_seller: legalSeller, fulfiller,
      merchant_of_record: merchantOfRecord, payment_processor: paymentProcessor, return_recipient: returnRecipient,
      payment_method: paymentMethod, chargeback_eligible: chargebackEligible, marketplace_protection: marketplaceProtection,
      buyer_protection_days: buyerProtectionDays, document_markers: documentMarkers, stock,
      return_days: returnDays, final_sale: finalSale, return_window_starts_on: returnWindowStartsOn,
      opened_items: openedItems, restocking_fee_percent: restockingFee, return_shipping_paid_by: returnShippingPaidBy,
      return_shipping_cost_usd: returnShippingCost, original_shipping_refundable: originalShippingRefundable,
      refund_method: refundMethod, manufacturer_warranty: warranty, warranty_provider: warrantyProvider,
      warranty_duration_months: warrantyDurationMonths, warranty_authorized_seller_required: warrantyAuthorizedSellerRequired,
      warranty_registration_required: warrantyRegistrationRequired, warranty_registration_deadline_days: warrantyRegistrationDays,
      warranty_parts_covered: warrantyPartsCovered, warranty_labor_covered: warrantyLaborCovered,
      warranty_deductible_usd: warrantyDeductible, warranty_claim_shipping_paid_by: warrantyClaimShippingPaidBy,
      warranty_claim_shipping_cost_usd: warrantyClaimShippingCost, warranty_estimated_downtime_days_high: warrantyDowntimeDays,
      repair_parts_availability: repairPartsAvailability, repair_manual_availability: repairManualAvailability,
      critical_components_replaceable: criticalComponentsReplaceable, condition, condition_grade: conditionGrade,
      battery_health_percent: batteryHealth, battery_cycle_count: batteryCycles, refurbisher, identifiers, authorization,
      safety, identity: {
        brand: identityBrand, product_line: identityProductLine, model: identityModel, generation: identityGeneration,
        edition: identityEdition, region: identityRegion, capacity: identityCapacity, size: identitySize, color: identityColor,
        condition, bundle_count: identityBundleCount, bundle_contents: identityBundleContents,
        compatibility_key: identityCompatibilityKey, compatibility_keys: identityCompatibilityKeys,
        product_category: safety.product_category,
      },
      order,
      case_event,
      fulfillment,
      promotions,
    },
    review_signals,
    warnings,
  };
}
