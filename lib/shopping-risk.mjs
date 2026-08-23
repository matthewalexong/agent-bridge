const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function deriveShoppingRiskFeatures({ authorized_market_median_usd: median, offers = [] }) {
  return offers.map((offer) => {
    const discount = finite(median) && finite(offer.landed_total_usd) && median > 0
      ? Math.round((1 - offer.landed_total_usd / median) * 1000) / 10
      : null;
    const evidence_flags = [];
    if (offer.authorized_seller === true) evidence_flags.push("authorized_seller");
    if (offer.authorized_seller === false) evidence_flags.push("unauthorized_seller");
    if (offer.authorized_seller == null) evidence_flags.push("authorization_unknown");
    if (discount != null && discount >= 40) evidence_flags.push("extreme_price_anomaly");
    else if (discount != null && discount >= 20) evidence_flags.push("price_anomaly");
    if (offer.manufacturer_warranty === true) evidence_flags.push("manufacturer_warranty");
    if (offer.manufacturer_warranty === false) evidence_flags.push("no_manufacturer_warranty");
    if (offer.identifier_conflict === true) evidence_flags.push("identifier_conflict");
    if ((offer.authenticity_complaints || 0) >= 3) evidence_flags.push("repeated_authenticity_complaints");
    if (offer.packaging_mismatch === true) evidence_flags.push("packaging_mismatch");
    if (offer.seal_issues === true) evidence_flags.push("seal_issues");
    if (offer.sold_by_platform === false && offer.fulfilled_by_platform === true) evidence_flags.push("third_party_seller_platform_fulfilled");
    if (offer.gray_market_disclosed === true) evidence_flags.push("gray_market_disclosed");
    if (["used", "open_box", "refurbished"].includes(offer.condition)) evidence_flags.push(`condition_${offer.condition}`);
    if (offer.exact_product === false) evidence_flags.push("identity_mismatch");
    if (offer.returnable === false) evidence_flags.push("not_returnable");
    return { offer_id: offer.id, price_discount_pct_vs_authorized_median: discount, evidence_flags };
  });
}
