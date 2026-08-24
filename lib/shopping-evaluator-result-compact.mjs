const COLLECTIONS = Object.freeze({
  product_evidence: { key: "products", matches: (item, productId) => same(item?.id, productId) },
  performance: { key: "assessments", matches: (item, productId) => same(item?.product_id, productId) },
  safety: { key: "assessments", matches: (item, productId, offerId) => offerId ? same(item?.id, offerId) && same(item?.product_key, productId) : same(item?.product_key, productId) },
  composition: { key: "assessments", matches: (item, productId) => same(item?.id, productId) },
  privacy: { key: "assessments", matches: (item, productId) => same(item?.id, productId) },
  compatibility: { key: "assessments", matches: (item, productId) => same(item?.id, productId) },
  lifecycle: { key: "assessments", matches: (item, productId) => same(item?.id, productId) },
  identity: { key: "resolutions", matches: (item, _productId, offerId) => same(item?.candidate_id, offerId) },
  merchant: { key: "assessments", matches: (item, productId, offerId) => same(item?.id, offerId) && same(item?.product_id, productId) },
  counterfeit: { key: "assessments", matches: (item, productId, offerId) => same(item?.offer_id, offerId) && same(item?.product_id, productId) },
  protection: { key: "assessments", matches: (item, productId, offerId) => same(item?.id, offerId) && same(item?.product_id, productId) },
  fulfillment: { key: "assessments", matches: (item, productId, offerId) => same(item?.id, offerId) && same(item?.product_id, productId) },
});

function same(left, right) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

export function compactShoppingEvaluatorResult({ stage, subject, result }) {
  const original = structuredClone(result);
  const rule = COLLECTIONS[stage];
  if (!rule || !Array.isArray(original?.[rule.key]) || original[rule.key].length < 2) return original;
  const matching = original[rule.key].filter((item) => rule.matches(item, subject?.product_id, subject?.offer_id));
  if (matching.length !== 1) return original;
  original[rule.key] = matching;
  return original;
}

