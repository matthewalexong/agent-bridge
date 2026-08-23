const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function landedTotal(offer) {
  if (!finite(offer.price_usd) || !finite(offer.shipping_usd)) return null;
  // Listing coupon flags are advertisements, not proof that a discount applies
  // to this user, offer, stack, and checkout. Promotion-aware production paths
  // require a shopping_promotion_assess artifact; this legacy eval ranks base cost.
  return Math.round((offer.price_usd + offer.shipping_usd) * 100) / 100;
}

function unitValue(unitValueArtifact, offer, landed) {
  if (unitValueArtifact?.action !== "comparable" || unitValueArtifact.safe_for_value_ranking !== true) return null;
  const assessment = (unitValueArtifact.assessments || []).find((item) => same(item.offer_id, offer.id));
  if (assessment?.status !== "comparable" || !finite(assessment.normalized_quantity) || assessment.normalized_quantity <= 0 || !assessment.normalized_unit) return null;
  if (!finite(assessment.landed_total_usd) || landed == null || Math.abs(assessment.landed_total_usd - landed) > 0.01) return null;
  return assessment;
}

export function annotateOffers(offers, requirements = {}, unitValueArtifact = null) {
  return (offers || []).map((offer) => {
    const landed = landedTotal(offer);
    const value = unitValue(unitValueArtifact, offer, landed);
    return {
      ...offer,
      computed_landed_total_usd: landed,
      computed_unit_cost_usd: value ? Math.round((landed / value.normalized_quantity) * 1_000_000) / 1_000_000 : null,
      normalized_value_quantity: value?.normalized_quantity ?? null,
      normalized_value_unit: value?.normalized_unit ?? null,
      unit_value_verified: Boolean(value),
      landed_price_verified: landed != null,
      // Identity/constraint matching is also deterministic once facts have
      // been extracted. The model explains this flag; it does not override it.
      hard_requirements_met: qualifies({ requirements, unit_value: unitValueArtifact }, offer),
      requirement_failures: requirementFailures({ requirements, unit_value: unitValueArtifact }, offer),
    };
  });
}

export function requirementFailures(task, offer) {
  const r = task.requirements || {};
  const failures = [];
  if (!same(offer.stock, "in_stock")) failures.push("not in stock");
  if (r.product_key && !same(offer.product_key, r.product_key)) failures.push("wrong product identity");
  if (r.variant && !same(offer.variant, r.variant)) failures.push(`wrong variant (needs ${r.variant})`);
  if (r.condition && !same(offer.condition, r.condition)) failures.push(`wrong condition (needs ${r.condition})`);
  if (finite(r.min_quantity) && r.min_quantity > 1) {
    const landed = landedTotal(offer);
    const value = unitValue(task.unit_value, offer, landed);
    const requiredUnit = String(r.quantity_unit || "each").trim().toLowerCase();
    if (!value || String(value.normalized_unit).trim().toLowerCase() !== requiredUnit) failures.push(`quantity unverified in ${requiredUnit}`);
    else if (value.normalized_quantity < r.min_quantity) failures.push(`quantity below ${r.min_quantity} ${requiredUnit}`);
  }
  if (r.authorized_seller === true && offer.authorized_seller !== true) failures.push("seller is not authorized");
  if (finite(offer.coupon_usd) || offer.coupon_eligible != null) failures.push("promotion price unverified");
  const landed = landedTotal(offer);
  if (finite(r.max_landed_usd) && (landed == null || landed > r.max_landed_usd)) failures.push(`landed total exceeds $${r.max_landed_usd}`);
  return failures;
}

function qualifies(task, offer) {
  return requirementFailures(task, offer).length === 0;
}

export function oraclePurchase(task) {
  if (task.requires_clarification === true) {
    return { action: "clarify", selected_offer: null, landed_total_usd: null };
  }
  const eligible = (task.offers || [])
    .filter((o) => qualifies(task, o))
    .map((o, index) => ({ offer: o, index, landed: landedTotal(o) }))
    // Unknown shipping means unknown landed cost. It must be verified first.
    .filter((x) => x.landed != null);
  if (!eligible.length) {
    return { action: "research_more", selected_offer: null, landed_total_usd: null };
  }
  const objective = task.objective || "landed_total";
  if (objective === "unit_cost" && eligible.some((entry) => !unitValue(task.unit_value, entry.offer, entry.landed))) {
    return { action: "research_more", selected_offer: null, landed_total_usd: null };
  }
  const metric = (x) => objective === "unit_cost"
    ? x.landed / unitValue(task.unit_value, x.offer, x.landed).normalized_quantity
    : x.landed;
  eligible.sort((a, b) =>
    metric(a) - metric(b)
    || (b.offer.return_days || 0) - (a.offer.return_days || 0)
    || a.index - b.index
  );
  const pick = eligible[0];
  return {
    action: "select",
    selected_offer: pick.offer.id,
    landed_total_usd: pick.landed,
  };
}

export function judgePurchase(task, answer) {
  const want = oraclePurchase(task);
  const got = answer && typeof answer === "object" ? answer : {};
  const actionOk = same(got.action, want.action);
  const selectionOk = (got.selected_offer ?? null) === want.selected_offer;
  const landedOk = want.landed_total_usd == null
    ? got.landed_total_usd == null
    : finite(got.landed_total_usd) && Math.abs(got.landed_total_usd - want.landed_total_usd) < 0.01;

  const critical = task.critical_facts || [];
  const evidence = Array.isArray(got.evidence) ? got.evidence.map((x) => String(x).toLowerCase()) : [];
  const evidenceFactMet = (fact) => {
    const wanted = String(fact).toLowerCase();
    const wantedNumber = wanted.match(/^\$?(\d+(?:\.\d+)?)$/);
    if (wantedNumber) {
      const n = Number(wantedNumber[1]);
      return evidence.some((line) =>
        [...line.matchAll(/\$?(\d+(?:\.\d+)?)/g)].some((m) => Number(m[1]) === n)
      );
    }
    const tokens = wanted.split(/\s+/).filter(Boolean);
    return evidence.some((line) => line.includes(wanted) || tokens.every((token) => line.includes(token)));
  };
  const evidenceHits = critical.filter(evidenceFactMet).length;
  const evidenceScore = critical.length ? evidenceHits / critical.length : 1;
  const failures = [];
  if (!actionOk) failures.push(`action: expected ${want.action}, got ${got.action ?? "missing"}`);
  if (!selectionOk) failures.push(`selected_offer: expected ${want.selected_offer}, got ${got.selected_offer ?? "null"}`);
  if (!landedOk) failures.push(`landed_total_usd: expected ${want.landed_total_usd}, got ${got.landed_total_usd ?? "null"}`);
  if (evidenceScore < 1) failures.push(`evidence: covered ${evidenceHits}/${critical.length} critical facts`);
  return { want, actionOk, selectionOk, landedOk, evidenceScore, pass: actionOk && selectionOk && landedOk, failures };
}
