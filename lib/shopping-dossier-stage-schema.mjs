import { z } from "zod";

const id = z.string().min(1).max(160);
const range = z.object({ low_usd: z.number().finite().nonnegative(), expected_usd: z.number().finite().nonnegative(), high_usd: z.number().finite().nonnegative() });
const evidenceLink = z.object({ kind: z.string().min(1).max(80), url: z.string().url().max(4_000) });
const costComponent = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["item_price", "shipping", "tax", "import_duty", "brokerage", "carrier_surcharge", "currency_conversion", "promotion_obligation"]), amount_usd: z.number().finite().nonnegative() }),
  z.object({ kind: z.literal("immediate_discount"), amount_usd: z.number().finite().nonpositive() }),
]);
const base = (stage) => z.object({ artifact_id: id, artifact_attestation: z.string().regex(/^v1\.dossier_stage\.[a-f0-9]{64}$/), decision_context_id: z.string().regex(/^shopping_context_[a-f0-9]{32}$/), evaluator_input_sha256: z.string().regex(/^[a-f0-9]{64}$/), consumed_constraint_ids: z.array(id).max(1_000), stage: z.literal(stage), evaluated_at: z.string().datetime() });

export const SHOPPING_DOSSIER_STAGE_SCHEMAS = Object.freeze({
  candidate_coverage: base("candidate_coverage").extend({ action: z.enum(["coverage_sufficient", "research_more"]), candidate_set_cleared_for_ranking: z.boolean(), eligible_candidate_ids: z.array(id).max(10_000) }),
  performance: base("performance").extend({ product_id: id, action: z.enum(["comparable", "research_more", "conflict"]), performance_cleared_for_ranking: z.boolean() }),
  value: base("value").extend({ action: z.enum(["comparable", "research_more"]), safe_for_value_ranking: z.boolean(), eligible_product_ids: z.array(id).max(10_000), eligible_offer_ids: z.array(id).max(10_000) }),
  condition: base("condition").extend({ product_id: id, offer_id: id, action: z.enum(["eligible", "research_more", "clarify_tradeoff", "avoid_offer"]), condition_cleared_for_offer_comparison: z.boolean() }),
  promotion: base("promotion").extend({ product_id: id, offer_id: id, action: z.enum(["eligible", "research_more", "clarify", "avoid_offer"]), pricing_cleared: z.boolean() }),
  product_evidence: base("product_evidence").extend({ product_id: id, status: z.enum(["verified", "conflict", "insufficient_evidence", "stale"]) }),
  review_integrity: base("review_integrity").extend({ product_id: id, action: z.enum(["eligible_for_review_ranking", "research_more", "exclude_reviews"]), review_evidence_cleared_for_ranking: z.boolean() }),
  safety: base("safety").extend({ product_id: id, action: z.enum(["eligible", "research_more", "clarify_tradeoff", "avoid_product"]), safety_cleared_for_ranking: z.boolean(), evidence_links: z.array(evidenceLink).max(20).optional().default([]) }),
  composition: base("composition").extend({ product_id: id, action: z.enum(["eligible", "research_more", "clarify", "reject"]), composition_cleared_for_ranking: z.boolean() }),
  privacy: base("privacy").extend({ product_id: id, action: z.enum(["eligible", "research_more", "clarify_tradeoff", "reject"]), privacy_cleared_for_ranking: z.boolean() }),
  compatibility: base("compatibility").extend({ product_id: id, action: z.enum(["compatible", "research_more", "incompatible"]), safe_for_ranking: z.boolean() }),
  lifecycle: base("lifecycle").extend({ product_id: id, purchase_gate: z.enum(["eligible_for_ranking", "clarify_tradeoff", "research_more", "avoid_product"]), user_accepted_tradeoff: z.boolean().optional() }),
  preferences: base("preferences").extend({ action: z.enum(["select", "research_more", "clarify"]), selected_candidate: id.nullable().optional(), reason: z.string().max(500).optional() }),
  ownership: base("ownership").extend({ action: z.enum(["select", "research_more", "clarify"]), selected_candidate: id.nullable().optional(), reason: z.string().max(500).optional() }),
  identity: base("identity").extend({ offer_id: id, product_id: id, classification: z.enum(["exact_match", "compatible_alternative", "insufficient_evidence", "identity_conflict", "different_product", "different_edition", "different_generation", "different_condition", "different_bundle", "different_variant"]), safe_to_compare_offers: z.boolean() }),
  merchant: base("merchant").extend({ product_id: id, offer_id: id, purchase_gate: z.enum(["eligible_for_other_shopping_checks", "research_more", "avoid_offer"]) }),
  counterfeit: base("counterfeit").extend({ product_id: id, offer_id: id, risk_status: z.enum(["low", "acceptable", "elevated", "unknown"]), authorization_requirement_status: z.enum(["not_required", "satisfied", "failed", "unknown"]), purchase_gate: z.enum(["eligible_for_other_shopping_checks", "research_more", "avoid_offer"]), evidence_links: z.array(evidenceLink).max(20).optional().default([]) }),
  protection: base("protection").extend({ product_id: id, offer_id: id, status: z.enum(["eligible", "needs_research", "rejected"]), return_window_days: z.number().int().nonnegative().max(3650).nullable(), warranty_duration_months: z.number().int().nonnegative().max(240).nullable(), buyer_protection_days: z.number().int().nonnegative().max(3650).nullable(), evidence_links: z.array(evidenceLink).max(20).optional().default([]) }),
  fulfillment: base("fulfillment").extend({ product_id: id, offer_id: id, action: z.enum(["eligible", "research_more", "clarify", "avoid_offer"]), fully_landed_total_usd: range.nullable(), fully_landed_status: z.enum(["verified", "estimated", "unknown"]), safe_for_offer_comparison: z.boolean(), delivery_earliest_at: z.string().datetime().nullable(), delivery_latest_at: z.string().datetime().nullable(), tracking_available: z.boolean().nullable(), cost_breakdown: z.array(costComponent).max(9).optional().default([]), evidence_links: z.array(evidenceLink).max(20).optional().default([]) }),
  offer: base("offer").extend({ product_id: id, offer_id: id, action: z.enum(["select", "research_more", "clarify"]), selected_offer: id.nullable().optional(), reason: z.string().max(500).optional(), landed_total_usd: z.number().finite().nonnegative().nullable(), landed_total_range_usd: range.nullable(), landed_price_verified: z.boolean(), promotion_affects_price: z.boolean().optional().default(false), stock: z.enum(["in_stock", "out_of_stock", "unknown"]) }),
  deal: base("deal").extend({ product_id: id, offer_id: id, timing_action: z.enum(["buy_now", "buy_if_needed", "monitor", "wait", "research_more", "avoid_offer"]) }),
  checkout: base("checkout").extend({ product_id: id, offer_id: id, status: z.enum(["ready_for_confirmation", "needs_research", "mismatch", "blocked"]), applied_discount_usd: z.number().finite().nonnegative().optional().default(0), confirmation_required: z.boolean(), purchase_allowed: z.boolean() }),
  checkout_consent: base("checkout_consent").extend({ product_id: id, offer_id: id, status: z.enum(["ready_for_confirmation", "needs_research", "clarify_consent", "remove_unrequested_items", "blocked"]), consent_cleared_for_confirmation: z.boolean(), confirmation_required: z.boolean(), purchase_allowed: z.boolean() }),
});

export const shoppingDossierStagesSchema = z.object(Object.fromEntries(Object.entries(SHOPPING_DOSSIER_STAGE_SCHEMAS).map(([stage, schema]) => [stage, schema.optional()])));
