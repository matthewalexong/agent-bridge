export function deriveSufficiencyFeatures(state) {
  const offers = Array.isArray(state.offers) ? state.offers : [];
  const exact = offers.filter((offer) => offer.exact_product === true);
  const independentRetailers = (state.sources || []).filter((source) =>
    !/snippet|search result/i.test(String(source))
  );
  const criticalUnknown = exact.filter((offer) =>
    offer.stock_verified === false
    || (Array.isArray(offer.unknown_fields) && offer.unknown_fields.length > 0)
    || (Array.isArray(offer.stock_claims) && new Set(offer.stock_claims).size > 1)
  );
  const allUnavailable = exact.length > 0 && exact.every((offer) =>
    offer.stock_verified === true && offer.in_stock === false
  );
  const minimum = state.policy?.min_independent_sources || 0;
  return {
    exact_offer_ids: exact.map((offer) => offer.id),
    critical_unknown_offer_ids: criticalUnknown.map((offer) => offer.id),
    all_exact_offers_verified_unavailable: allUnavailable,
    independent_retailer_count: independentRetailers.length,
    minimum_independent_retailers: minimum,
    source_coverage_sufficient: independentRetailers.length >= minimum,
  };
}
