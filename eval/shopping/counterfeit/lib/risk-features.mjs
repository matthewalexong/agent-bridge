const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function deriveRiskFeatures(state) {
  const median = state.authorized_market_median_usd;
  return (state.offers || []).map((offer) => {
    const discount = finite(median) && finite(offer.landed_total_usd) && median > 0
      ? Math.round((1 - offer.landed_total_usd / median) * 1000) / 10
      : null;
    const signals = [];
    if (offer.authorized_seller === true) signals.push("authorized_seller");
    if (offer.authorized_seller === false) signals.push("unauthorized_seller");
    if (offer.authorized_seller == null) signals.push("authorization_unknown");
    if (discount != null && discount >= 40) signals.push("extreme_price_anomaly");
    else if (discount != null && discount >= 20) signals.push("price_anomaly");
    if (offer.manufacturer_warranty === true) signals.push("manufacturer_warranty");
    if (offer.manufacturer_warranty === false) signals.push("no_manufacturer_warranty");
    if (offer.identifier_conflict === true) signals.push("identifier_conflict");
    if ((offer.authenticity_complaints || 0) >= 3) signals.push("repeated_authenticity_complaints");
    if (offer.packaging_mismatch === true) signals.push("packaging_mismatch");
    if (offer.seal_issues === true) signals.push("seal_issues");
    if (offer.sold_by_platform === false && offer.fulfilled_by_platform === true) signals.push("third_party_seller_platform_fulfilled");
    if (offer.gray_market_disclosed === true) signals.push("gray_market_disclosed");
    if (["used", "open_box", "refurbished"].includes(offer.condition)) signals.push(`condition_${offer.condition}`);
    if (offer.exact_product === false) signals.push("identity_mismatch");
    if (offer.returnable === false) signals.push("not_returnable");
    return { offer_id: offer.id, price_discount_pct_vs_authorized_median: discount, evidence_flags: signals };
  });
}
