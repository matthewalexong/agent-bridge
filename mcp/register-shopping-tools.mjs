import { z } from "zod";
import { analyzeShoppingOffers } from "../lib/shopping-decision.mjs";
import { deriveShoppingRiskFeatures } from "../lib/shopping-risk.mjs";
import { deriveShoppingResearchFeatures } from "../lib/shopping-sufficiency.mjs";
import { createShoppingPageEvidenceLedger, extractBrowserObservedCheckoutEvidence, extractBrowserObservedCheckoutTermsEvidence } from "../lib/shopping-browser-evidence.mjs";
import { preflightShoppingCheckout } from "../lib/shopping-checkout.mjs";
import { assessCheckoutConsentFromEvidence, checkoutConsentInputFromSignedEvidence } from "../lib/shopping-checkout-consent-evidence.mjs";
import { createShoppingCheckoutPatternRegistry } from "../lib/shopping-checkout-patterns.mjs";
import { createShoppingConfirmationRegistry } from "../lib/shopping-confirmation.mjs";
import { createShoppingTermsAcknowledgementRegistry } from "../lib/shopping-terms-acknowledgement.mjs";
import { createShoppingCaseEvidence } from "../lib/shopping-case-evidence.mjs";
import { createShoppingCaseEventEvidence } from "../lib/shopping-case-event-evidence.mjs";
import { resolveProductIdentitiesFromEvidence } from "../lib/shopping-identity-evidence.mjs";
import { rankShoppingCandidates } from "../lib/shopping-preferences.mjs";
import { aggregateProductEvidence } from "../lib/shopping-product-evidence.mjs";
import { analyzeDealQuality } from "../lib/shopping-deal-quality.mjs";
import { claimDueShoppingWatches, completeShoppingWatchRun, createShoppingWatch, evaluateShoppingWatch, listShoppingWatches, updateShoppingWatch } from "../lib/shopping-watchlist.mjs";
import { analyzeOwnershipCosts } from "../lib/shopping-ownership-cost.mjs";
import { assessShoppingProtectionFromEvidence } from "../lib/shopping-protection-evidence.mjs";
import { createShoppingCase, listShoppingCases, prepareShoppingCaseAction, updateShoppingCase } from "../lib/shopping-cases.mjs";
import { assessMerchantTrustFromEvidence } from "../lib/shopping-merchant-evidence.mjs";
import { assessShoppingLifecycle } from "../lib/shopping-lifecycle.mjs";
import { composeShoppingDossier, requiredShoppingDossierStages } from "../lib/shopping-dossier.mjs";
import { validateShoppingConstraintJob } from "../lib/shopping-constraint-routing.mjs";
import { assessCounterfeitRiskFromEvidence } from "../lib/shopping-counterfeit-evidence.mjs";
import { forgetShoppingProfileField, listShoppingProfile, rememberShoppingProfileField, resolveShoppingProfile, updateShoppingProfileField } from "../lib/shopping-profile.mjs";
import { assessShoppingFulfillmentFromEvidence } from "../lib/shopping-fulfillment-evidence.mjs";
import { assessShoppingCompatibility } from "../lib/shopping-compatibility.mjs";
import { assessShoppingSafetyFromEvidence } from "../lib/shopping-safety-evidence.mjs";
import { assessShoppingPrivacy } from "../lib/shopping-privacy.mjs";
import { assessShoppingComposition } from "../lib/shopping-composition.mjs";
import { assessReviewIntegrity } from "../lib/shopping-review-integrity.mjs";
import { assessCandidateCoverage } from "../lib/shopping-candidate-coverage.mjs";
import { assessShoppingPerformance } from "../lib/shopping-performance.mjs";
import { assessShoppingValue } from "../lib/shopping-value.mjs";
import { assessShoppingCondition } from "../lib/shopping-condition.mjs";
import { assessShoppingPromotionFromEvidence } from "../lib/shopping-promotion-evidence.mjs";
import { runShoppingEvaluatorBatch, SHOPPING_EVALUATOR_STAGES } from "../lib/shopping-evaluator-batch.mjs";
import { adaptShoppingEvaluatorResult } from "../lib/shopping-dossier-stage.mjs";
import { shoppingDossierStagesSchema } from "../lib/shopping-dossier-stage-schema.mjs";
import { createShoppingDecisionContext } from "../lib/shopping-decision-context.mjs";
import { shoppingApplicabilityEntrySchema, shoppingDecisionContextArtifactSchema, shoppingDecisionContextInputSchema } from "../lib/shopping-decision-context-schema.mjs";
import { issueShoppingRequestReceipt } from "../lib/shopping-request-intent.mjs";
import { defaultEvaluatorResultChars } from "./surface.mjs";

const id = z.string().min(1).max(160);
const money = z.number().finite().nonnegative().max(10_000_000).nullable().optional();
const tri = z.boolean().nullable().optional();
const artifactAttestation = (kind) => z.string().regex(new RegExp(`^v1\\.${kind}\\.[a-f0-9]{64}$`));
const pageEvidenceArtifact = z.object({
  artifact_attestation: artifactAttestation("page_evidence"),
  source: z.object({ url: z.string().url().max(4_000), page_kind: z.enum(["manufacturer_product", "retailer_listing", "manufacturer_authorized_sellers", "manufacturer_warranty", "reviews", "merchant_terms", "merchant_privacy", "checkout", "order_receipt", "merchant_correspondence", "carrier_tracking", "return_status", "warranty_status", "return_policy", "repairability", "safety_authority_search", "safety_notice", "certification_directory", "safety_remediation"]), captured_at: z.string().datetime() }).passthrough(),
  extraction_scope: z.object({ seller_query: z.string().max(200).nullable().optional(), directory_complete: z.boolean() }).passthrough(),
  facts: z.record(z.any()),
  source_receipt: z.object({ artifact_attestation: artifactAttestation("browser_snapshot"), source_id: id, snapshot_id: id, tab_id: z.number().int().nonnegative(), url: z.string().url().max(4_000), captured_at: z.string().datetime(), content_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
}).passthrough();

export function registerShoppingTools({ tool, asText, resolveBrowserSnapshot, resolvePanelRequest }) {
  const registerTool = tool;
  const confirmationRegistry = createShoppingConfirmationRegistry({ resolve_panel_request: resolvePanelRequest });
  const termsAcknowledgementRegistry = createShoppingTermsAcknowledgementRegistry({ resolve_panel_request: resolvePanelRequest });
  const checkoutPatternRegistry = createShoppingCheckoutPatternRegistry();
  const evaluatorRegistry = new Map();
  tool = (name, definition, handler) => {
    registerTool(name, definition, handler);
    const stage = SHOPPING_EVALUATOR_STAGES[name];
    if (stage) evaluatorRegistry.set(name, { stage, schema: z.object(definition.inputSchema), handler });
  };
  const pageEvidenceLedger = createShoppingPageEvidenceLedger({ resolve_snapshot: resolveBrowserSnapshot });
  const identity = z.object({
    id: id.optional(), brand: z.string().max(300).optional(), product_line: z.string().max(500).optional(), model: z.string().max(200).optional(), generation: z.string().max(200).optional(), edition: z.string().max(300).optional(), region: z.string().max(100).optional(), capacity: z.string().max(100).optional(), size: z.string().max(100).optional(), color: z.string().max(100).optional(), condition: z.string().max(100).optional(), bundle_count: z.number().int().positive().max(100_000).optional(), bundle_contents: z.array(z.string().max(300)).max(100).optional(), identifiers: z.object({ upc: z.string().max(50).optional(), ean: z.string().max(50).optional(), gtin: z.string().max(50).optional(), mpn: z.string().max(100).optional() }).optional(), compatibility_key: z.string().max(200).optional(), compatibility_keys: z.array(z.string().max(200)).max(100).optional(),
  });
  const identityField = z.enum(["brand", "product_line", "model", "generation", "edition", "region", "capacity", "size", "color", "condition", "bundle_count"]);
  tool("shopping_identity_resolve", {
    title: "Resolve canonical product identity",
    description: "Deterministically compare a fresh signed manufacturer-product page with fresh signed retailer listings across every observed brand, line, model, generation, edition, region, capacity, size, color, bundle, global identifier, compatibility key, and explicit listing condition. The model cannot submit identity values or weaken required fields. Only exact_match candidates are safe for offer comparison.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(),
      max_page_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300),
      target_product_id: id,
      target_evidence: pageEvidenceArtifact,
      candidates: z.array(z.object({ id, offer_variant: id.optional(), listing_evidence: pageEvidenceArtifact })).max(100),
      mode: z.enum(["exact_product", "compatible_part"]).optional().default("exact_product"),
    },
  }, async (input) => asText(resolveProductIdentitiesFromEvidence(input)));

  const compatibilityScalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
  const compatibilityBase = { id, required: z.boolean().optional().default(true) };
  const compatibilityRequirement = z.discriminatedUnion("kind", [
    z.object({ ...compatibilityBase, kind: z.literal("exact"), value: compatibilityScalar }),
    z.object({ ...compatibilityBase, kind: z.literal("all_supported"), values: z.array(compatibilityScalar).min(1).max(500) }),
    z.object({ ...compatibilityBase, kind: z.literal("numeric_contained"), value: z.number().finite().optional(), low: z.number().finite().optional(), high: z.number().finite().optional(), unit: z.string().min(1).max(50) }),
    z.object({ ...compatibilityBase, kind: z.literal("dimensions_fit"), unit: z.string().min(1).max(50), available: z.object({ width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(), depth: z.number().finite().nonnegative() }), allow_width_depth_rotation: z.boolean().optional().default(false) }),
    z.object({ ...compatibilityBase, kind: z.literal("fitment_exact"), fitment: z.record(compatibilityScalar), required_fields: z.array(id).min(1).max(100) }),
    z.object({ ...compatibilityBase, kind: z.literal("apparel_chart"), measurements: z.array(z.object({ name: id, value: z.number().finite().nonnegative(), unit: z.string().min(1).max(50) })).min(1).max(100) }),
  ]);
  const compatibilityClaimBase = { requirement_id: id, evidence_status: z.enum(["verified", "estimated", "conflict", "unknown"]), source_id: id.optional() };
  const compatibilityClaim = z.discriminatedUnion("kind", [
    z.object({ ...compatibilityClaimBase, kind: z.literal("exact"), value: compatibilityScalar }),
    z.object({ ...compatibilityClaimBase, kind: z.literal("all_supported"), values: z.array(compatibilityScalar).max(5_000) }),
    z.object({ ...compatibilityClaimBase, kind: z.literal("numeric_contained"), low: z.number().finite(), high: z.number().finite(), unit: z.string().min(1).max(50) }),
    z.object({ ...compatibilityClaimBase, kind: z.literal("dimensions_fit"), unit: z.string().min(1).max(50), product: z.object({ width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(), depth: z.number().finite().nonnegative() }), clearance_each_side: z.object({ width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(), depth: z.number().finite().nonnegative() }).optional() }),
    z.object({ ...compatibilityClaimBase, kind: z.literal("fitment_exact"), coverage_complete: z.boolean(), records: z.array(z.record(compatibilityScalar)).max(10_000) }),
    z.object({ ...compatibilityClaimBase, kind: z.literal("apparel_chart"), size_label: z.string().max(100).optional(), size_system: z.string().max(200).optional(), measurements: z.array(z.object({ name: id, low: z.number().finite().nonnegative(), high: z.number().finite().nonnegative(), unit: z.string().min(1).max(50) })).max(100).optional() }),
  ]);
  tool("shopping_compatibility_assess", {
    title: "Assess exact fit and compatibility",
    description: "Deterministically gate apparel size-chart fit, exact connectors and regional variants, required protocol/band sets, voltage/frequency ranges, installation dimensions and clearance, and complete vehicle/part fitment records. Candidate claims require verified source identity; incomplete tables remain research, labels alone never prove fit, and the tool partitions candidates without selecting or buying.",
    inputSchema: {
      category: z.enum(["apparel", "replacement_part", "vehicle", "device", "electrical", "regional", "installation", "other"]).optional().default("other"),
      requirements: z.array(compatibilityRequirement).min(1).max(200),
      candidates: z.array(z.object({ id, claims: z.array(compatibilityClaim).max(500) })).max(100),
    },
  }, async (input) => asText(assessShoppingCompatibility(input)));

  const compositionEvidence = { evidence_status: z.enum(["verified", "estimated", "conflict", "unknown"]), source_id: id.optional() };
  const namedAvoidance = z.object({ name: id, aliases: z.array(z.string().max(300)).max(100).optional().default([]) });
  tool("shopping_composition_assess", {
    title: "Assess ingredients, allergens, materials, claims, and hazards",
    description: "Deterministically match explicit user exclusions and aliases against a verified exact-offer formulation; evaluate ingredient/material completeness, concentrations, allergen contains and cross-contact statements, certified/verified claims, and hazard classes. Missing or region/version-mismatched labels remain research; the tool provides no diagnosis, selects nothing, and never buys.",
    inputSchema: {
      requirements: z.object({
        excluded_ingredients: z.array(namedAvoidance).max(500).optional(), excluded_materials: z.array(namedAvoidance).max(500).optional(),
        max_concentrations: z.array(namedAvoidance.extend({ max: z.number().finite().nonnegative(), unit: z.string().min(1).max(50) })).max(500).optional(),
        allergens: z.array(namedAvoidance.extend({ cross_contact_policy: z.enum(["avoid", "clarify", "allow_disclosed"]) })).max(500).optional(),
        required_claims: z.array(z.object({ name: id, minimum_evidence: z.enum(["verified", "certified"]).optional().default("verified") })).max(500).optional(),
        prohibited_hazards: z.array(id).max(500).optional(),
      }).optional().default({}),
      candidates: z.array(z.object({
        id, identity_verified: z.boolean(),
        offer_formulation: z.object({ formulation_id: id, region: z.string().max(100), version: z.string().max(100) }),
        label: z.object({ formulation_id: id, region: z.string().max(100), version: z.string().max(100), ingredient_inventory_complete: z.boolean(), material_inventory_complete: z.boolean(), hazard_inventory_complete: z.boolean(), ...compositionEvidence }),
        ingredients: z.array(z.object({ name: id, declared_components: z.array(z.string().max(300)).max(500).optional(), concentration: z.object({ value: z.number().finite().nonnegative(), unit: z.string().min(1).max(50), ...compositionEvidence }).optional(), ...compositionEvidence })).max(10_000).optional().default([]),
        materials: z.array(z.object({ name: id, declared_components: z.array(z.string().max(300)).max(500).optional(), ...compositionEvidence })).max(10_000).optional().default([]),
        allergen_statements: z.array(z.object({ allergen: id, status: z.enum(["contains", "may_contain", "shared_equipment", "shared_facility", "free_from", "unknown"]), ...compositionEvidence })).max(1_000).optional().default([]),
        claims: z.array(z.object({ name: id, status: z.enum(["certified", "verified", "marketing", "unverified", "absent"]), ...compositionEvidence })).max(1_000).optional().default([]),
        hazards: z.array(z.object({ classification: id, present: z.boolean(), ...compositionEvidence })).max(1_000).optional().default([]),
      })).max(100),
    },
  }, async (input) => asText(assessShoppingComposition(input)));

  const conditionEvidence = z.object({ evidence_status: z.enum(["verified", "estimated", "conflict", "unknown"]), source_id: id.optional() });
  const conditionType = z.enum(["new", "open_box", "used", "refurbished", "renewed", "remanufactured", "display_model", "for_parts"]);
  const lockFact = z.object({ value: z.enum(["clear", "present", "unknown"]), ...conditionEvidence.shape });
  tool("shopping_condition_assess", {
    title: "Assess exact-offer physical condition",
    description: "Deterministically evaluate new, open-box, used, refurbished, renewed, display, and parts-only offers from exact-item or standardized-batch evidence. Seller grades do not prove equivalence. Functional tests, disclosed defects, refurbishment provenance, batteries, device locks, and accessories remain separate gates; UI actions and model inference cannot accept tradeoffs; the tool never selects or buys.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(), policy: z.object({ max_age_days: z.number().int().min(1).max(365).optional(), max_acceptance_age_seconds: z.number().int().min(10).max(3_600).optional() }).optional(),
      requirements: z.object({ allowed_conditions: z.array(conditionType).min(1).max(8), allow_for_parts: z.boolean().optional(), required_function_tests: z.array(id).max(100).optional().default([]), require_authorized_refurbisher: z.boolean().optional(), data_wipe_required: z.boolean().optional(), sanitation_required: z.boolean().optional(), battery_health_required: z.boolean().optional(), min_battery_health_percent: z.number().finite().min(0).max(100).optional(), max_battery_cycles: z.number().int().nonnegative().max(1_000_000).optional(), device_lock_checks_required: z.boolean().optional(), carrier_lock_allowed: z.boolean().optional(), required_accessories: z.array(id).max(100).optional().default([]) }),
      offer: z.object({
        id, product_id: id, exact_identity: z.boolean(), represented_condition: conditionType, condition_version: id.optional(), inspected_at: z.string().datetime(), condition_claim: z.object({ value: conditionType, ...conditionEvidence.shape }), condition_inventory_complete: z.boolean(), condition_inventory_evidence_status: z.enum(["verified", "estimated", "conflict", "unknown"]), condition_inventory_source_id: id.optional(),
        grade: z.object({ label: z.string().min(1).max(200), scheme_id: id, criteria_complete: z.boolean(), ...conditionEvidence.shape }).optional(),
        exact_item: z.object({ unique_item: z.boolean(), photo_scope: z.enum(["exact_item", "stock", "mixed", "none"]), photo_item_match: z.boolean().optional(), ...conditionEvidence.shape }).optional(),
        newness: z.object({ seal_status: z.object({ value: z.enum(["factory_sealed", "opened", "missing", "broken", "unknown"]), ...conditionEvidence.shape }).optional(), activation_status: z.object({ value: z.enum(["never_activated", "activated", "previously_activated", "unknown"]), ...conditionEvidence.shape }).optional(), prior_use: z.object({ value: z.boolean(), ...conditionEvidence.shape }).optional() }).optional(),
        defects: z.object({ inventory_complete: z.boolean(), ...conditionEvidence.shape, items: z.array(z.object({ id, severity: z.enum(["minor", "moderate", "major", "critical"]), functional: z.boolean(), disclosed: z.boolean(), ...conditionEvidence.shape })).max(500).optional().default([]) }).optional(),
        functional_tests: z.object({ inventory_complete: z.boolean(), ...conditionEvidence.shape, items: z.array(z.object({ id, status: z.enum(["pass", "fail", "not_tested", "unknown"]), ...conditionEvidence.shape })).max(500).optional().default([]) }).optional(),
        refurbishment: z.object({ performer: z.enum(["manufacturer", "manufacturer_authorized", "retailer", "third_party", "unknown"]), standard_id: id.optional(), work_inventory_complete: z.boolean(), data_wipe_status: z.enum(["verified_complete", "failed", "unknown", "not_applicable"]), replaced_parts: z.array(z.object({ id, provenance: z.enum(["manufacturer", "manufacturer_authorized", "third_party", "used_original", "unknown"]), ...conditionEvidence.shape })).max(500).optional().default([]), ...conditionEvidence.shape }).optional(),
        data_handling: z.object({ data_wipe_status: z.enum(["verified_complete", "failed", "unknown", "not_applicable"]), ...conditionEvidence.shape }).optional(),
        sanitation: z.object({ status: z.enum(["verified_complete", "failed", "unknown", "not_applicable"]), method: z.string().max(500).optional(), ...conditionEvidence.shape }).optional(),
        battery: z.object({ status: z.enum(["original", "replaced", "unknown"]), health_percent: z.object({ value: z.number().finite().min(0).max(100), ...conditionEvidence.shape }).optional(), cycle_count: z.object({ value: z.number().int().nonnegative().max(1_000_000), ...conditionEvidence.shape }).optional(), replacement_provenance: z.enum(["manufacturer", "manufacturer_authorized", "third_party", "unknown"]).optional() }).optional(),
        locks: z.object({ activation_lock: lockFact.optional(), mdm_lock: lockFact.optional(), carrier_lock: lockFact.optional(), finance_balance: lockFact.optional(), lost_or_stolen_status: lockFact.optional() }).optional(),
        accessories: z.object({ inventory_complete: z.boolean(), ...conditionEvidence.shape, items: z.array(z.object({ id, present: z.boolean(), functional: z.boolean().nullable().optional(), ...conditionEvidence.shape })).max(500).optional().default([]) }).optional(),
      }),
      tradeoff_acceptances: z.array(z.object({ id, offer_id: id, condition_version: id, source: z.enum(["current_user_message", "current_user_action", "prior_message", "ui_default", "agent_inference", "none"]), accepted_at: z.string().datetime() })).max(100).optional().default([]),
    },
  }, async (input) => asText(assessShoppingCondition(input)));

  const promotionIdentityArtifact = z.object({
    artifact_attestation: artifactAttestation("identity"), evaluated_at: z.string().datetime(), target_product_id: id,
    resolutions: z.array(z.object({ candidate_id: id, classification: z.enum(["exact_match", "identity_conflict", "different_edition", "different_generation", "different_condition", "different_bundle", "different_variant", "different_product", "compatible_alternative", "insufficient_evidence"]), safe_to_compare_offers: z.boolean() }).passthrough()).max(100),
  }).passthrough();
  tool("shopping_promotion_assess", {
    title: "Assess exact-offer promotion economics",
    description: "Reconstruct the complete exact-offer promotion inventory only from fresh signed listing and checkout pages plus canonical identity, then deterministically separate applied immediate discounts from deferred rebates, credits, points, trade-ins, gift-card tender, and financing. Caller-authored status, amount, eligibility, completeness, and obligation fields are not accepted. Consequential membership or subscription pricing remains unresolved without a separate process-attested consent path. Output is process-attested and never selects or buys.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(),
      max_page_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300),
      max_identity_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600),
      policy: z.object({ max_age_seconds: z.number().int().min(10).max(86_400).optional(), max_acceptance_age_seconds: z.number().int().min(10).max(3_600).optional() }).optional(),
      offer_id: id,
      identity: promotionIdentityArtifact,
      listing_evidence: pageEvidenceArtifact,
      checkout_evidence: pageEvidenceArtifact,
    },
  }, async (input) => asText(assessShoppingPromotionFromEvidence(input)));

  const safetyEvidence = z.enum(["verified", "estimated", "conflict", "unknown"]);
  const safetyIdentityArtifact = z.object({
    artifact_attestation: artifactAttestation("identity"), evaluated_at: z.string().datetime(), target_product_id: id, product_category: id,
    canonical_target: z.object({ model: z.string().nullable().optional(), identifiers: z.object({ trade_item_code: z.string().nullable().optional(), mpn: z.string().nullable().optional() }).passthrough().optional() }).passthrough(),
    resolutions: z.array(z.object({ candidate_id: id, offer_variant: id.nullable().optional(), classification: z.enum(["exact_match", "identity_conflict", "different_edition", "different_generation", "different_condition", "different_bundle", "different_variant", "different_product", "compatible_alternative", "insufficient_evidence"]), safe_to_compare_offers: z.boolean(), canonical: z.object({ condition: z.string().nullable() }).passthrough() }).passthrough()).max(100),
  }).passthrough();
  tool("shopping_safety_assess", {
    title: "Assess recalls, safety notices, and regulatory compliance",
    description: "Deterministically derive the product category and regulator policy from fresh signed manufacturer identity, reconstruct safety coverage and official notices from signed browser evidence whose hostname matches the process-owned authority registry, bind candidates to signed listing seller evidence, and match exact product, identifiers, serial range, and manufacture window. Caller-authored category, authority, and safety verdict fields are not accepted; active unresolved gates override ranking and purchase_allowed is always false.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(), jurisdiction: z.string().length(2),
      policy: z.object({ max_coverage_age_days: z.number().int().min(1).max(365).optional().default(7) }).optional().default({ max_coverage_age_days: 7 }),
      max_page_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300),
      max_identity_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600),
      identity: safetyIdentityArtifact,
      coverage_evidence: z.array(z.object({ authority_id: id, evidence: pageEvidenceArtifact })).max(100),
      certification_requirements: z.array(z.object({ scheme: id, jurisdiction: z.string().length(2) })).max(100).optional().default([]),
      notice_evidence: z.array(z.object({ authority_id: id, evidence: pageEvidenceArtifact })).max(10_000).optional().default([]),
      candidates: z.array(z.object({
        id, listing_evidence: pageEvidenceArtifact, serial_number: z.string().max(300).optional(), manufactured_at: z.string().datetime().optional(),
        certification_evidence: z.array(z.object({ scheme: id, authority_id: id, evidence: pageEvidenceArtifact })).max(100).optional().default([]),
        remediation_evidence: z.array(z.object({ authority_id: id, evidence: pageEvidenceArtifact })).max(100).optional().default([]),
      })).min(1).max(100),
    },
  }, async (input) => asText(assessShoppingSafetyFromEvidence(input)));

  const privacyBoolFact = z.object({ value: z.boolean().nullable(), evidence_status: safetyEvidence, source_id: id.optional() });
  const privacyNumberFact = z.object({ value: z.number().finite().nonnegative().nullable(), evidence_status: safetyEvidence, source_id: id.optional() });
  tool("shopping_privacy_assess", {
    title: "Assess connected-product privacy and data security",
    description: "Deterministically evaluate sourced data inventory, required and optional collection, purposes, sharing, sale and targeted ads, retention, account/cloud/local operation, deletion/export/consent controls, permissions, encryption, MFA, secure resale, and verified exact-product incidents. Missing or stale evidence remains research; hard privacy requirements and serious unresolved incidents override ranking; the tool never selects or buys.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(), policy: z.object({ max_policy_age_days: z.number().int().min(1).max(365).optional().default(30) }).optional().default({ max_policy_age_days: 30 }),
      requirements: z.object({ prohibited_data_categories: z.array(id).max(100).optional(), prohibit_targeted_ads: z.boolean().optional(), prohibit_data_sale: z.boolean().optional(), allowed_third_party_purposes: z.array(id).max(100).optional(), max_retention_days: z.number().int().nonnegative().max(365_000).optional(), account_optional_required: z.boolean().optional(), local_core_operation_required: z.boolean().optional(), deletion_required: z.boolean().optional(), export_required: z.boolean().optional(), consent_withdrawal_required: z.boolean().optional(), max_deletion_days: z.number().int().nonnegative().max(365_000).optional(), encryption_in_transit_required: z.boolean().optional(), encryption_at_rest_required: z.boolean().optional(), mfa_required: z.boolean().optional(), prohibited_required_permissions: z.array(id).max(100).optional(), secure_resale_required: z.boolean().optional() }).optional().default({}),
      candidates: z.array(z.object({
        id, identity_verified: z.boolean(),
        policy: z.object({ inventory_complete: z.boolean(), captured_at: z.string().datetime(), evidence_status: safetyEvidence, source_id: id.optional() }),
        data_flows: z.array(z.object({ category: id, collection: z.enum(["required", "optional", "none", "unknown"]), can_disable: tri, targeted_ads: tri, data_sale: tri, third_party_sharing: tri, third_party_purposes: z.array(id).max(100).optional(), retention: z.enum(["bounded", "indefinite", "event_based", "unknown"]).optional(), retention_days: z.number().int().nonnegative().max(365_000).nullable().optional(), evidence_status: safetyEvidence, source_id: id.optional() })).max(1_000),
        architecture: z.object({ account_required: privacyBoolFact, cloud_required: privacyBoolFact, local_core_operation: privacyBoolFact }),
        controls: z.object({ account_and_data_deletion: privacyBoolFact, deletion_days: privacyNumberFact, data_export: privacyBoolFact, consent_withdrawal: privacyBoolFact }),
        security: z.object({ encryption_in_transit: privacyBoolFact.optional(), encryption_at_rest: privacyBoolFact.optional(), mfa_available: privacyBoolFact.optional() }).optional().default({}),
        permissions: z.array(z.object({ name: id, required_for_core: z.boolean(), justification: z.string().max(1_000).optional(), evidence_status: safetyEvidence, source_id: id.optional() })).max(500).optional().default([]),
        transfer: z.object({ factory_reset: privacyBoolFact, account_unlink: privacyBoolFact, ownership_transfer: privacyBoolFact }).optional(),
        incidents: z.array(z.object({ id, severity: z.enum(["critical", "serious", "moderate", "unknown"]), resolved: tri, applies_to_exact_product: z.boolean(), evidence_status: safetyEvidence, source_type: z.enum(["regulator", "court", "manufacturer", "independent_security_lab", "professional_review", "customer_review", "search_snippet"]), source_id: id.optional() })).max(1_000).optional().default([]),
      })).max(100),
    },
  }, async (input) => asText(assessShoppingPrivacy(input)));

  tool("shopping_checkout_evidence", {
    title: "Extract checkout evidence",
    description: "Extract signed provenance-backed exact offer, product, variant, condition, seller, merchant of record, quantity, unit price, stock, return policy, masked payment method, masked destination, subtotal, discounts, shipping, tax, fees, total, delivery, and applied coupon only from a fresh complete server-registered browser snapshot. Truncated snapshots fail closed. Model-provided checkout text and URLs are not accepted; missing identity, confirmation details, availability, or charges remain unresolved.",
    inputSchema: { snapshot_id: id, max_snapshot_age_seconds: z.number().int().min(10).max(120).optional().default(120) },
  }, async (input) => asText(extractBrowserObservedCheckoutEvidence(resolveBrowserSnapshot, input)));

  tool("shopping_checkout_terms_evidence", {
    title: "Extract exact checkout continuity terms",
    description: "Extract a process-attested exact offer, product, purchase type, terms version, initial and recurring economics, renewal, trial, commitment, cancellation, selected add-ons, disclosed changed terms, and structured urgency claims only from a fresh complete server-registered checkout snapshot. Explicit complete terms, add-on, changed-term, and urgency inventory markers are required; truncated or model-supplied replacement text cannot create evidence.",
    inputSchema: { snapshot_id: id, max_snapshot_age_seconds: z.number().int().min(10).max(120).optional().default(120) },
  }, async (input) => asText(extractBrowserObservedCheckoutTermsEvidence(resolveBrowserSnapshot, input)));

  const checkoutTermsAcknowledgementArtifact = z.object({
    artifact_attestation: artifactAttestation("checkout_terms_acknowledgement"), acknowledgement_id: id, challenge_id: id,
    product_id: id, offer_id: id, terms_version: id, scope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    accepted_at: z.string().datetime(), purchase_allowed: z.literal(false), external_submission_allowed: z.literal(false),
  }).passthrough();
  const checkoutTermsChallengeArtifact = z.object({
    artifact_attestation: artifactAttestation("checkout_terms_challenge"), challenge_id: z.string().regex(/^checkout_terms_[a-f0-9]{32}$/),
    product_id: id, offer_id: id, terms_version: id, issued_at: z.string().datetime(), expires_at: z.string().datetime(),
    scope_sha256: z.string().regex(/^[a-f0-9]{64}$/), required_response: z.string().regex(/^ACCEPT TERMS [A-F0-9]{12}$/),
    purchase_allowed: z.literal(false), external_submission_allowed: z.literal(false),
  }).passthrough();
  const checkoutTermsEvidenceArtifact = z.object({
    artifact_attestation: artifactAttestation("checkout_terms_evidence"), product_id: id.nullable(), offer_id: id.nullable(),
    source: z.object({ url: z.string().url(), captured_at: z.string().datetime(), source_id: id }).passthrough(),
    source_receipt: z.object({ artifact_attestation: artifactAttestation("browser_snapshot"), source_id: id, url: z.string().url(), captured_at: z.string().datetime(), content_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
    purchase: z.record(z.any()), add_on_inventory_complete: z.boolean(), add_ons: z.array(z.record(z.any())).max(100), term_change_inventory_complete: z.boolean(), term_changes: z.array(z.record(z.any())).max(100), urgency_inventory_complete: z.boolean(), urgency_claims: z.array(z.record(z.any())).max(100),
  }).passthrough();
  const checkoutPatternEvidenceArtifact = z.object({
    artifact_attestation: artifactAttestation("checkout_pattern_evidence"), product_id: id, offer_id: id,
    checkout_origin: z.string().url(), latest_terms_attestation: artifactAttestation("checkout_terms_evidence"), latest_content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    evaluated_at: z.string().datetime(), observation_count: z.number().int().positive(), flags: z.array(z.string()).max(1_000), blockers: z.array(z.string()).max(1_000), warnings: z.array(z.string()).max(1_000), urgency_claims: z.array(z.record(z.any())).max(100),
    urgency_may_override_gates: z.literal(false), purchase_allowed: z.literal(false),
  }).passthrough();
  tool("shopping_checkout_pattern_observe", {
    title: "Observe exact-checkout continuity patterns",
    description: "Compare bounded process-owned signed snapshots for the exact checkout origin, product, and offer. Detect countdown resets, scarcity-count increases without observed restock, selected add-ons reappearing after removal, and undisclosed economic or term changes. Findings are observations, not fraud determinations; urgency never overrides a gate and the artifact grants no purchase authority.",
    inputSchema: { terms_evidence: checkoutTermsEvidenceArtifact },
  }, async (input) => asText(checkoutPatternRegistry.observe({ ...input, evaluated_at: new Date().toISOString() })));
  tool("shopping_checkout_terms_challenge", {
    title: "Issue an exact checkout-terms acknowledgement challenge",
    description: "Create a short-lived process-attested one-time response bound to the exact purchase type, recurring economics, cancellation, selected add-ons, and disclosed changed terms. Present the unchanged terms summary and required response to the user. Caller-authored acceptance flags are not accepted and the challenge grants no purchase authority.",
    inputSchema: { terms_evidence: checkoutTermsEvidenceArtifact, pattern_evidence: checkoutPatternEvidenceArtifact, expires_in_seconds: z.number().int().min(30).max(900).optional().default(300) },
  }, async (input) => {
    const evaluatedAt = new Date().toISOString();
    const scopeInput = checkoutConsentInputFromSignedEvidence({ terms_evidence: input.terms_evidence, pattern_evidence: input.pattern_evidence, evaluated_at: evaluatedAt });
    return asText(termsAcknowledgementRegistry.issue({ input: scopeInput, evaluated_at: evaluatedAt, expires_in_seconds: input.expires_in_seconds }));
  });
  tool("shopping_checkout_terms_accept", {
    title: "Record a new exact checkout-terms acknowledgement",
    description: "Resolve one exact user-authored panel message by runtime ID and consume a live one-time terms challenge only when the new message matches its required response. Altered, expired, prior, unknown-process, and replayed challenges fail closed; the receipt grants no purchase authority.",
    inputSchema: { challenge: checkoutTermsChallengeArtifact, request_id: id },
  }, async (input) => asText(await termsAcknowledgementRegistry.accept({ ...input, evaluated_at: new Date().toISOString() })));
  tool("shopping_checkout_consent_assess", {
    title: "Defend checkout consent and continuity terms",
    description: "Deterministically audit purchase type, recurring economics, cancellation, add-ons, changed terms, and urgency. Recurring terms, selected add-ons, and changed terms require a fresh process-attested acknowledgement receipt bound to the exact current scope; caller-authored acceptance flags, UI state, prior messages, agent inference, and time pressure never establish consent. Purchase authority always remains false.",
    inputSchema: {
      terms_evidence: checkoutTermsEvidenceArtifact,
      pattern_evidence: checkoutPatternEvidenceArtifact,
      policy: z.object({ max_evidence_age_seconds: z.number().int().min(10).max(3_600).optional(), max_acknowledgement_age_seconds: z.number().int().min(10).max(3_600).optional() }).optional(),
      acknowledgement_receipt: checkoutTermsAcknowledgementArtifact.optional(),
    },
  }, async (input) => asText(assessCheckoutConsentFromEvidence({ ...input, evaluated_at: new Date().toISOString() })));

  const checkoutPreflightResultArtifact = z.object({
    artifact_attestation: artifactAttestation("checkout_preflight"),
    evaluated_at: z.string().datetime(),
    status: z.literal("ready_for_confirmation"),
    confirmation_required: z.literal(true),
    purchase_allowed: z.literal(false),
    confirmation_summary: z.object({
      item: z.object({ id, product_key: id }).passthrough(),
      total_usd: z.number().finite().nonnegative(),
    }).passthrough(),
  }).passthrough();
  const checkoutConsentResultArtifact = z.object({
    artifact_attestation: artifactAttestation("checkout_consent"),
    product_id: id,
    offer_id: id,
    evaluated_at: z.string().datetime(),
    status: z.literal("ready_for_confirmation"),
    consent_cleared_for_confirmation: z.literal(true),
    confirmation_required: z.literal(true),
    purchase_allowed: z.literal(false),
  }).passthrough();
  const confirmationChallengeArtifact = z.object({
    artifact_attestation: artifactAttestation("checkout_confirmation_challenge"),
    challenge_id: z.string().regex(/^shopping_confirmation_[a-f0-9]{32}$/),
    product_id: id,
    offer_id: id,
    issued_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    summary_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    required_response: z.string().regex(/^CONFIRM [A-F0-9]{12}$/),
    purchase_allowed: z.literal(false),
    external_submission_allowed: z.literal(false),
  }).passthrough();
  tool("shopping_confirmation_challenge", {
    title: "Issue an exact-checkout confirmation challenge",
    description: "Create a short-lived process-attested one-time response bound to the exact ready checkout preflight and consent artifacts. Present its unchanged confirmation summary and required response to the user. It grants no purchase or external-submission authority.",
    inputSchema: {
      checkout_preflight: checkoutPreflightResultArtifact,
      checkout_consent: checkoutConsentResultArtifact,
      expires_in_seconds: z.number().int().min(30).max(900).optional().default(300),
    },
  }, async (input) => asText(confirmationRegistry.issue({ ...input, evaluated_at: new Date().toISOString() })));
  tool("shopping_confirmation_accept", {
    title: "Record a new exact user confirmation",
    description: "Resolve one exact user-authored panel message by runtime ID and consume a live one-time checkout challenge only when the new message matches its required response. Altered, expired, prior, unknown-process, and replayed challenges fail closed. The resulting audit receipt still grants no purchase or external-submission authority.",
    inputSchema: { challenge: confirmationChallengeArtifact, request_id: id },
  }, async (input) => asText(await confirmationRegistry.accept({ ...input, evaluated_at: new Date().toISOString() })));

  const checkoutItem = z.object({ id, product_key: id.optional(), variant: id.optional(), condition: id.optional(), serial_number: z.string().max(300).optional(), quantity: z.number().int().positive().max(100_000), unit_price_usd: money, seller: z.string().max(300).optional(), seller_verified: z.boolean().optional(), stock: z.enum(["in_stock", "out_of_stock", "unknown"]).optional(), stock_verified: z.boolean().optional() });
  const checkoutDiscount = z.object({ code: z.string().max(100).optional(), amount_usd: z.number().finite().nonnegative().max(10_000_000).optional(), applied: z.boolean(), eligible: z.boolean().nullable().optional() });
  const checkoutEvidenceArtifact = z.object({ artifact_attestation: artifactAttestation("checkout_evidence"), source: z.object({ url: z.string().url(), captured_at: z.string().datetime() }).passthrough(), source_receipt: z.object({ artifact_attestation: artifactAttestation("browser_snapshot"), url: z.string().url(), captured_at: z.string().datetime() }).passthrough(), facts: z.record(z.any()) }).passthrough();
  const checkoutCounterfeitArtifact = z.object({ artifact_attestation: artifactAttestation("counterfeit"), evaluated_at: z.string().datetime(), assessments: z.array(z.object({ offer_id: id, product_id: id, variant: id.nullable().optional(), seller: z.string().min(1).max(300), risk_status: z.enum(["low", "acceptable", "elevated", "unknown"]), purchase_gate: z.enum(["eligible_for_other_shopping_checks", "research_more", "avoid_offer"]), distinctions: z.object({ identity_exact: z.boolean(), condition: z.enum(["new", "used", "open_box", "refurbished"]) }).passthrough() }).passthrough()).max(100) }).passthrough();
  const merchantTrustArtifact = z.object({ artifact_attestation: artifactAttestation("merchant"), evaluated_at: z.string().datetime(), assessments: z.array(z.object({ id, status: z.enum(["verified_established", "acceptable", "unknown", "elevated", "rejected"]), purchase_gate: z.enum(["eligible_for_other_shopping_checks", "research_more", "avoid_offer"]), roles: z.object({ seller: z.object({ name: z.string().min(1).max(300) }).passthrough(), merchant_of_record: z.object({ name: z.string().min(1).max(300) }).passthrough() }).passthrough() }).passthrough()).max(100) }).passthrough();
  const protectionArtifact = z.object({ artifact_attestation: artifactAttestation("protection"), evaluated_at: z.string().datetime(), assessments: z.array(z.object({ id, product_id: id, variant: id.nullable().optional(), condition: z.enum(["new", "used", "open_box", "refurbished"]), seller: z.string().min(1).max(300), status: z.enum(["eligible", "needs_research", "rejected"]), purchase_gate: z.enum(["eligible_for_offer_analysis", "research_more", "avoid_offer"]), deadlines: z.object({ return_deadline: z.string().datetime().nullable().optional(), warranty_expiration: z.string().datetime().nullable().optional() }).passthrough().optional() }).passthrough()).max(100) }).passthrough();
  const identityArtifact = z.object({ artifact_attestation: artifactAttestation("identity"), evaluated_at: z.string().datetime(), target_product_id: id, resolutions: z.array(z.object({ candidate_id: id, offer_variant: id.nullable().optional(), classification: z.enum(["exact_match", "identity_conflict", "different_edition", "different_generation", "different_condition", "different_bundle", "different_variant", "different_product", "compatible_alternative", "insufficient_evidence"]), safe_to_compare_offers: z.boolean(), confidence: z.number().min(0).max(1), canonical: z.object({ condition: z.string().nullable() }).passthrough() }).passthrough()).max(100) }).passthrough();
  const safetyArtifact = z.object({ artifact_attestation: artifactAttestation("safety"), evaluated_at: z.string().datetime(), jurisdiction: z.string().length(2), assessments: z.array(z.object({ id, product_key: id, variant: id.nullable().optional(), condition: z.enum(["new", "used", "open_box", "refurbished"]), seller: z.string().min(1).max(300), serial_number: z.string().max(300).nullable().optional(), action: z.enum(["eligible", "research_more", "clarify_tradeoff", "avoid_product"]), safety_cleared_for_ranking: z.boolean(), purchase_allowed: z.literal(false), warnings: z.array(z.string().max(500)).max(1_000).optional() }).passthrough()).max(100) }).passthrough();
  const productClearanceArtifact = z.object({
    dossier_id: id,
    decision_context_id: z.string().regex(/^shopping_context_[a-f0-9]{32}$/),
    clearance_attestation: z.string().regex(/^v1\.[a-f0-9]{64}$/),
    evaluated_at: z.string().datetime(),
    phase: z.literal("product_recommendation"),
    product_id: id,
    offer_id: z.null(),
    audit: z.object({
      required: z.array(id).max(100), completed: z.array(id).max(100), missing: z.array(id).max(100), stale: z.array(id).max(100), future: z.array(id).max(100), mismatched: z.array(id).max(100), context_mismatched: z.array(id).max(100), invalid_artifacts: z.array(id).max(100), unconsumed_constraints: z.array(id).max(1_000), invalid_applicability: z.array(id).max(100), invalid_context: z.array(id).max(100),
    }),
    decision: z.object({
      action: z.literal("recommend_product"), selected_product: id, selected_offer: z.null(), blockers: z.array(z.string().max(1_000)).max(1_000), research: z.array(z.string().max(1_000)).max(1_000), clarifications: z.array(z.string().max(1_000)).max(1_000), purchase_allowed: z.literal(false), model_override_allowed: z.literal(false),
    }),
  });
  tool("shopping_checkout_preflight", {
    title: "Audit checkout before confirmation",
    description: "Deterministically reconcile the same fresh process-attested product-decision clearance that preceded offer ranking, canonical identity, official product-safety clearance, signed ranking-time listing availability, and merchant clearance refreshed from the exact current checkout snapshot with the exact item, variant, seller, merchant of record, condition, counterfeit risk, purchase protection, quantity, current stock, coupons, subtotal, shipping, tax, fees, total, price changes, and delivery. Snapshot ID, URL, capture time, and content digest must match merchant clearance, so a changed or lookalike checkout fails closed. Current cart stock cannot repair availability that was unknown or out of stock at ranking. Forged or payload-tampered clearance, product substitution, seller, jurisdiction, merchant, condition, variant, or item changes invalidate the corresponding artifacts. This tool never authorizes or places an order; it only prepares an explicit user-confirmation summary.",
    inputSchema: {
      expected: z.object({ offer_id: id.optional(), destination_country: z.string().length(2), product_key: id.optional(), variant: id.optional(), condition: id.optional(), quantity: z.number().int().positive().max(100_000).optional(), seller: z.string().max(300).optional(), max_total_usd: z.number().finite().nonnegative().max(10_000_000).optional(), max_total_operator: z.enum(["lt", "lte"]).optional().default("lte"), offer_landed_total_usd: z.number().finite().nonnegative().max(10_000_000).optional(), max_price_increase_usd: z.number().finite().nonnegative().max(10_000_000).optional(), required_coupon_code: z.string().max(100).optional(), allow_additional_items: z.boolean().optional().default(false), require_delivery_estimate: z.boolean().optional().default(true), require_return_policy: z.boolean().optional().default(true), require_payment_method: z.boolean().optional().default(true), require_shipping_destination: z.boolean().optional().default(true), max_evidence_age_seconds: z.number().int().min(10).max(3600).optional().default(120), max_counterfeit_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), max_merchant_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), max_protection_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), max_identity_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), max_safety_age_seconds: z.number().int().min(10).max(604_800).optional().default(86_400), max_product_clearance_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), evaluated_at: z.string().datetime().optional() }),
      cart: z.object({ merchant: z.string().max(300).optional(), items: z.array(checkoutItem).max(100), discounts: z.array(checkoutDiscount).max(100).optional().default([]), subtotal_usd: money, shipping_usd: money, tax_usd: money, fees_usd: money, reported_total_usd: money, delivery_estimate: z.string().max(500).nullable().optional(), return_policy: z.string().max(1000).nullable().optional(), return_policy_verified: z.boolean().optional(), payment_method_summary: z.string().max(300).nullable().optional(), shipping_destination_summary: z.string().max(500).nullable().optional(), captured_at: z.string().datetime().optional() }),
      checkout_evidence: checkoutEvidenceArtifact,
      counterfeit: checkoutCounterfeitArtifact,
      merchant: merchantTrustArtifact,
      protection: protectionArtifact,
      identity: identityArtifact,
      safety: safetyArtifact,
      product_clearance: productClearanceArtifact,
    },
  }, async (input) => asText(preflightShoppingCheckout(input)));

  tool("shopping_counterfeit_assess", {
    title: "Adjudicate counterfeit and authenticity risk",
    description: "Deterministically classify exact-offer authenticity risk and preserve exact-listing availability only from fresh process-attested identity plus browser-observed listing, manufacturer authorized-seller, and warranty page artifacts. An authorized-seller-only requirement is adjudicated from the signed manufacturer directory: a verified complete-directory miss blocks the offer but remains distinct from counterfeit risk or an accusation; missing or incomplete directory evidence remains unknown. Signed listing stock is carried separately as availability; missing stock remains unknown. The model cannot submit seller, stock, authorization, warranty, identifier, packaging, complaint, price, or official-finding facts. Unsupported source classes remain unknown. Price alone never establishes elevated risk; gray market, condition, and identity remain distinct.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(),
      category: z.string().max(100).optional(),
      requirements: z.object({ authorized_seller_required: z.boolean().optional().default(false) }).optional().default({}),
      max_page_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300),
      max_identity_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600),
      identity: identityArtifact,
      offers: z.array(z.object({
        id,
        listing_evidence: pageEvidenceArtifact,
        authorization_evidence: pageEvidenceArtifact.optional(),
        warranty_evidence: pageEvidenceArtifact.optional(),
      })).max(100),
    },
  }, async (input) => asText(assessCounterfeitRiskFromEvidence(input)));

  const historySource = z.object({ id, source_type: z.enum(["history_provider", "retailer", "order_receipt", "search_snippet"]), url: z.string().url().max(4_000).optional(), independence_key: z.string().max(300).optional() });
  tool("shopping_deal_quality", {
    title: "Analyze deal quality and purchase timing",
    description: "Compare a verified exact-product landed price with comparable historical observations, detect misleading sale/reference-price claims, and return a conservative buy, monitor, wait, research, or avoid action without predicting future prices.",
    inputSchema: {
      current: z.object({ offer_id: id, product_key: id, variant: id.optional(), condition: id.optional(), currency: z.string().length(3).optional().default("USD"), landed_total_usd: money, landed_price_verified: z.boolean(), exact_identity: z.boolean(), stock: z.enum(["in_stock", "out_of_stock", "unknown"]), risk_status: z.enum(["low", "acceptable", "elevated", "unknown"]), reference_price_usd: money, advertised_discount_percent: z.number().finite().min(-1_000).max(100).optional(), reference_price_verified: z.boolean().optional(), sale_claimed: z.boolean().optional() }),
      observations: z.array(z.object({ product_key: id, variant: id.optional(), condition: id.optional(), currency: z.string().length(3).optional().default("USD"), landed_total_usd: z.number().finite().nonnegative().max(10_000_000), verified: z.boolean(), observed_at: z.string().datetime(), source: historySource })).max(10_000),
      policy: z.object({ evaluated_at: z.string().datetime().optional(), max_history_days: z.number().int().positive().max(3650).optional().default(730), min_observations: z.number().int().positive().max(10_000).optional().default(5), min_distinct_days: z.number().int().positive().max(3650).optional().default(5), min_span_days: z.number().nonnegative().max(3650).optional().default(30) }).optional().default({}),
      user_context: z.object({ urgency: z.enum(["immediate", "soon", "flexible"]).optional().default("flexible"), target_price_usd: money, max_price_usd: money }).optional().default({ urgency: "flexible" }),
    },
  }, async (input) => asText(analyzeDealQuality(input)));

  const signedFulfillmentPromotionArtifact = z.object({ artifact_attestation: artifactAttestation("promotion"), offer_id: id, product_id: id, evaluated_at: z.string().datetime(), action: z.literal("eligible"), pricing_cleared: z.literal(true), base_price_usd: z.number().finite().nonnegative(), shipping_usd: z.number().finite().nonnegative(), immediate_checkout_discount_usd: z.number().finite().nonnegative(), checkout_landed_total_usd: z.number().finite().nonnegative(), deferred_value_usd: z.number().finite().nonnegative(), required_incremental_cost_usd: z.number().finite().nonnegative(), guaranteed_economic_cost_usd: z.number().finite().nonnegative(), purchase_allowed: z.literal(false) }).passthrough();
  tool("shopping_fulfillment_assess", {
    title: "Assess fully landed cost and fulfillment reliability",
    description: "Reconstruct exact-offer price, shipping, tax, duty, brokerage, carrier, currency, destination, customs, delivery, tracking, and return-route facts only from fresh signed listing, checkout, and return-policy pages, then deterministically calculate landed cost. Caller-authored amounts and evidence-status flags are not accepted. Missing charges remain unknown; unsigned promotion output cannot alter this ledger; output is process-attested; and purchase_allowed is always false.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(),
      max_page_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300),
      max_identity_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600),
      max_promotion_age_seconds: z.number().int().min(10).max(86_400).optional().default(900),
      destination_country: z.string().length(2),
      requirements: z.object({ max_fully_landed_usd: money, max_fully_landed_operator: z.enum(["lt", "lte"]).optional().default("lte"), required_by: z.string().datetime().optional(), require_tracking: z.boolean().optional(), require_verified_return_destination: z.boolean().optional(), require_return_cost: z.boolean().optional(), allowed_return_countries: z.array(z.string().length(2)).max(250).optional() }).optional().default({}),
      offers: z.array(z.object({
        id, listing_evidence: pageEvidenceArtifact, checkout_evidence: pageEvidenceArtifact.optional(), return_policy_evidence: pageEvidenceArtifact.optional(),
      })).max(100),
      identity: identityArtifact,
      promotion_artifacts: z.array(signedFulfillmentPromotionArtifact).max(100).optional().default([]),
    },
  }, async (input) => asText(assessShoppingFulfillmentFromEvidence(input)));

  const applicability = shoppingApplicabilityEntrySchema;
  tool("shopping_request_intake", {
    title: "Capture an immutable shopping request",
    description: "Resolve an exact user-authored side-panel message by its runtime ID and return a process-attested immutable text receipt with a deterministic exhaustive clause inventory, constraint-risk hints, and typed literal facts for money, measurements, percentages, quantities, deadlines, comparison operators, and negation. The model cannot supply replacement message text or alter literal semantics.",
    inputSchema: { request_id: id },
  }, async (input) => {
    if (typeof resolvePanelRequest !== "function") throw Object.assign(new Error("Panel request resolution is unavailable"), { code: "shopping_request_unavailable" });
    const request = await resolvePanelRequest(input.request_id);
    return asText(issueShoppingRequestReceipt(request));
  });
  tool("shopping_decision_dossier", {
    title: "Compose an auditable shopping decision dossier",
    description: "Compose product-, offer-, or checkout-level process-attested evaluator stages into one deterministic readiness decision. The signed decision context returned by shopping_evaluator_batch is authoritative for phase, subject, applicability, destination, user-state revision, and constraints. Rejects missing, expired, altered, mixed-context, wrong-stage, wrong-subject, and restarted-process artifacts. Failed safety gates cannot be overridden by price or model text; purchase_allowed is always false.",
    inputSchema: {
      decision_context: shoppingDecisionContextArtifactSchema,
      freshness_seconds: z.object({ candidate_coverage: z.number().int().positive().max(2_592_000).optional(), product_evidence: z.number().int().positive().max(31_536_000).optional(), performance: z.number().int().positive().max(2_592_000).optional(), value: z.number().int().positive().max(2_592_000).optional(), condition: z.number().int().positive().max(2_592_000).optional(), promotion: z.number().int().positive().max(86_400).optional(), review_integrity: z.number().int().positive().max(2_592_000).optional(), safety: z.number().int().positive().max(86_400).optional(), composition: z.number().int().positive().max(2_592_000).optional(), privacy: z.number().int().positive().max(2_592_000).optional(), compatibility: z.number().int().positive().max(31_536_000).optional(), lifecycle: z.number().int().positive().max(31_536_000).optional(), preferences: z.number().int().positive().max(31_536_000).optional(), ownership: z.number().int().positive().max(31_536_000).optional(), identity: z.number().int().positive().max(86_400).optional(), merchant: z.number().int().positive().max(86_400).optional(), counterfeit: z.number().int().positive().max(86_400).optional(), protection: z.number().int().positive().max(86_400).optional(), fulfillment: z.number().int().positive().max(86_400).optional(), offer: z.number().int().positive().max(86_400).optional(), deal: z.number().int().positive().max(31_536_000).optional(), checkout: z.number().int().min(10).max(3_600).optional(), checkout_consent: z.number().int().min(10).max(3_600).optional() }).optional(),
      stages: shoppingDossierStagesSchema,
    },
  }, async (input) => {
    const evaluatedAt = new Date().toISOString();
    const profile = await listShoppingProfile({ evaluated_at: evaluatedAt });
    return asText(composeShoppingDossier({
      ...input,
      evaluated_at: evaluatedAt,
      current_profile_state_revision: profile.state_revision,
      phase: input.decision_context.phase,
      product_id: input.decision_context.product_id,
      offer_id: input.decision_context.offer_id || undefined,
      applicability: input.decision_context.applicability,
    }, { require_stage_attestations: true, require_decision_context: true }));
  });

  const pageEvidenceRequest = {
    snapshot_id: id.optional().describe("Snapshot receipt ID from browser_snapshot."),
    snapshotId: id.optional().describe("Compatibility alias for snapshot_id."),
    page_kind: z.enum(["manufacturer_product", "retailer_listing", "manufacturer_authorized_sellers", "manufacturer_warranty", "reviews", "merchant_terms", "merchant_privacy", "checkout", "order_receipt", "merchant_correspondence", "carrier_tracking", "return_status", "warranty_status", "return_policy", "repairability", "safety_authority_search", "safety_notice", "certification_directory", "safety_remediation"]).optional().default("retailer_listing"),
    max_snapshot_age_seconds: z.number().int().min(10).max(300).optional().default(300),
    seller_query: z.string().min(1).max(200).optional(),
    directory_complete: z.boolean().optional().default(false),
  };
  tool("shopping_page_evidence", {
    title: "Extract shopping page evidence",
    description: "Extract signed provenance-backed seller, fulfiller, price, shipping, stock, returns, warranty, identifiers, authorized-directory matches, and review risk mentions only from a short-lived browser-observed snapshot receipt. Model-provided page text and URLs are not accepted. Missing facts remain unknown.",
    inputSchema: pageEvidenceRequest,
  }, async (input) => {
    const snapshot_id = input.snapshot_id ?? input.snapshotId;
    if (!snapshot_id) throw Object.assign(new Error("Pass snapshot_id from browser_snapshot"), { code: "shopping_snapshot_id_required" });
    return asText(pageEvidenceLedger.extract({ ...input, snapshot_id }));
  });

  tool("shopping_page_evidence_batch", {
    title: "Extract several signed shopping pages with ledger reuse",
    description: "Convert 1-20 fresh browser snapshot receipts into signed shopping-page artifacts in one bounded call. Exact snapshot content plus page kind, seller query, and completeness scope form the process-owned ledger key, so identical work is reused while differently scoped evidence remains isolated.",
    inputSchema: { requests: z.array(z.object(pageEvidenceRequest)).min(1).max(20) },
  }, async (input) => {
    const before = pageEvidenceLedger.stats();
    const artifacts = await Promise.all(input.requests.map(async (request) => {
      const snapshot_id = request.snapshot_id ?? request.snapshotId;
      if (!snapshot_id) throw Object.assign(new Error("Each request needs snapshot_id from browser_snapshot"), { code: "shopping_snapshot_id_required" });
      return pageEvidenceLedger.extract({ ...request, snapshot_id });
    }));
    const after = pageEvidenceLedger.stats();
    return asText({ artifacts, ledger: { entries: after.entries, reused: after.hits - before.hits, extracted: after.misses - before.misses } });
  });

  const lifecycleDate = z.object({ date: z.string().datetime().nullable().optional(), evidence_status: z.enum(["verified", "estimated", "unknown"]) });
  const lifecycleMoney = z.object({ low_usd: z.number().finite().nonnegative().max(100_000_000).optional(), expected_usd: z.number().finite().nonnegative().max(100_000_000).optional(), high_usd: z.number().finite().nonnegative().max(100_000_000).optional(), evidence_status: z.enum(["verified", "estimated", "unknown"]) });
  tool("shopping_lifecycle_assess", {
    title: "Assess product lifecycle and ecosystem exposure",
    description: "Deterministically evaluate support coverage, security and cloud commitments, required consumable/part continuity, proprietary lock-in, interoperability, data export, vendor-shutdown effects, and migration exposure across the user's ownership horizon. Returns gates and tradeoffs but never selects a product.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(),
      horizon_months: z.number().int().min(1).max(240).optional().default(36),
      requirements: z.object({ minimum_support_months: z.number().int().min(1).max(240).optional(), security_updates_required: z.boolean().optional(), functional_updates_required: z.boolean().optional(), offline_operation_required: z.boolean().optional(), open_standard_required: z.boolean().optional(), data_export_required: z.boolean().optional(), replacement_parts_required: z.boolean().optional(), consumables_required: z.boolean().optional(), max_migration_cost_usd: z.number().finite().nonnegative().max(100_000_000).optional() }).optional().default({}),
      candidates: z.array(z.object({
        id,
        identity_verified: z.boolean(),
        support: z.object({ security_updates_until: lifecycleDate.optional(), functional_updates_until: lifecycleDate.optional(), cloud_service_commitment_until: lifecycleDate.optional(), repair_support_until: lifecycleDate.optional(), end_of_support: lifecycleDate.optional() }).optional(),
        ecosystem: z.object({ cloud_required: tri, vendor_shutdown_effect: z.enum(["none", "degraded", "core_function_loss", "unknown"]).optional(), interoperability: z.object({ standard: z.string().max(300).optional(), open_standard: z.boolean().nullable().optional(), evidence_status: z.enum(["verified", "estimated", "unknown"]) }).optional(), data_export: z.object({ available: z.boolean().nullable().optional(), formats: z.array(z.string().max(100)).max(100).optional(), evidence_status: z.enum(["verified", "estimated", "unknown"]) }).optional(), proprietary_consumables: tri, proprietary_connector: tri, proprietary_file_format: tri, account_transferable: tri }).optional(),
        migration: z.object({ cost_usd: lifecycleMoney.optional(), path_verified: tri }).optional(),
        continuity: z.array(z.object({ name: id, kind: z.enum(["consumable", "replacement_part", "accessory", "battery", "service", "app"]), required: z.boolean(), availability: z.enum(["widely_available", "multiple_sources", "vendor_only", "scarce", "discontinued", "unknown"]), compatible_alternatives_verified: tri, supply_commitment_until: lifecycleDate.optional(), evidence_status: z.enum(["verified", "estimated", "unknown"]) })).max(500).optional().default([]),
      })).max(100),
    },
  }, async (input) => asText(assessShoppingLifecycle(input)));

  tool("shopping_merchant_trust", {
    title: "Assess merchant roles, trust evidence, and dispute recourse",
    description: "Deterministically reconstruct seller, legal seller, fulfiller, merchant of record, payment processor, return recipient, recognizable policy presence, cross-page consistency, and payment recourse only from fresh signed browser page artifacts. It carries the exact checkout snapshot ID, URL, capture time, and content digest so final preflight can reject a changed or lookalike checkout; refresh merchant trust from the current complete checkout snapshot before confirmation. The model cannot submit verified merchant entities, policies, domain claims, recourse, or complaints. Unsupported facts remain unknown; weak signals never become fraud findings and the tool never selects a product.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(),
      max_page_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300),
      requirements: z.object({ verified_legal_seller_required: z.boolean().optional(), return_destination_required: z.boolean().optional(), allowed_return_countries: z.array(z.string().length(2)).max(250).optional(), reversible_payment_required: z.boolean().optional(), buyer_protection_required: z.boolean().optional() }).optional().default({}),
      candidates: z.array(z.object({
        id, product_id: id,
        listing_evidence: pageEvidenceArtifact,
        terms_evidence: pageEvidenceArtifact.optional(),
        privacy_evidence: pageEvidenceArtifact.optional(),
        return_policy_evidence: pageEvidenceArtifact.optional(),
        checkout_evidence: pageEvidenceArtifact.optional(),
      })).max(100),
    },
  }, async (input) => asText(assessMerchantTrustFromEvidence(input)));

  const scalarAttribute = z.union([z.string().max(1_000), z.number().finite(), z.boolean()]);
  const attributeValue = z.union([scalarAttribute, z.array(scalarAttribute).max(100), z.null()]);
  const evidenceRole = z.enum(["declared_specification", "measured_performance", "observed_fact", "certification", "policy_term", "review_theme"]);
  const constraint = z.object({
    attribute: id,
    id: id.optional(),
    literal_id: z.string().regex(/^literal_[a-f0-9]{24}$/).optional(),
    operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains"]),
    value: z.union([scalarAttribute, z.array(scalarAttribute).max(100)]),
    unit: z.string().min(1).max(100).nullable().optional(),
    required_evidence_role: evidenceRole.optional(),
  });
  const preferenceBase = { attribute: id, weight: z.number().positive().max(100).optional().default(1), required_evidence_role: evidenceRole.optional() };
  const preference = z.union([
    z.object({ ...preferenceBase, kind: z.literal("numeric"), direction: z.enum(["maximize", "minimize"]), low: z.number().finite(), high: z.number().finite() }).refine((value) => value.high > value.low, { message: "high must be greater than low" }),
    z.object({ ...preferenceBase, kind: z.literal("numeric_target"), target: z.number().finite(), tolerance: z.number().positive() }).transform((value) => ({ ...value, kind: "numeric", direction: "target" })),
    z.object({ ...preferenceBase, kind: z.literal("boolean"), desired: z.boolean() }),
    z.object({ ...preferenceBase, kind: z.literal("categorical"), preferred_values: z.array(scalarAttribute).min(1).max(100) }),
  ]);
  const candidateCoverageArtifact = z.object({ action: z.enum(["coverage_sufficient", "research_more"]), candidate_set_cleared_for_ranking: z.boolean(), eligible_candidate_ids: z.array(id).max(10_000) });
  tool("shopping_performance_assess", {
    title: "Compare standardized product performance evidence",
    description: "Deterministically admit real-world performance metrics only from exact product/variant/configuration/firmware measurements using the same verified protocol and complete conditions, independent unfunded sources, sufficient samples, complete run aggregation, bounded sourced uncertainty, and acceptable inter-lab agreement. Manufacturer and funded measurements remain controlled claims; the tool never ranks, selects, or buys.",
    inputSchema: {
      evaluated_at: z.string().datetime(),
      policy: z.object({ max_age_days: z.number().positive().max(3650).optional(), min_independent_labs: z.number().int().min(1).max(100).optional(), min_sample_size: z.number().int().min(1).max(1_000_000).optional(), max_relative_uncertainty: z.number().min(0).max(10).optional(), max_interlab_relative_spread: z.number().min(0).max(10).optional() }).optional().default({}),
      metric: z.object({ id, unit: z.string().min(1).max(100), direction: z.enum(["higher_better", "lower_better", "target"]), protocol: z.object({ id, version: id }), conditions: z.record(scalarAttribute), firmware_sensitive: z.boolean().optional().default(false), calibration_required: z.boolean().optional().default(false) }),
      targets: z.array(z.object({ id, variant_id: id, configuration_id: id, firmware_version: id.optional() })).max(100),
      measurements: z.array(z.object({
        id, product_id: id, variant_id: id, configuration_id: id, firmware_version: id.optional(), metric_id: id, value: z.number().finite(), unit: z.string().min(1).max(100), measured_at: z.string().datetime(),
        protocol: z.object({ id, version: id, evidence_status: z.enum(["verified", "claimed", "unknown"]), source_id: id.optional() }), conditions: z.record(scalarAttribute), condition_inventory_complete: z.boolean(),
        sample_size: z.number().int().nonnegative().max(1_000_000), run_coverage_complete: z.boolean(), uncertainty: z.object({ low: z.number().finite(), high: z.number().finite(), evidence_status: z.enum(["verified", "claimed", "unknown"]), source_id: id.optional() }), instrument_calibration: z.object({ status: z.enum(["current", "expired", "unknown"]), evidence_status: z.enum(["verified", "claimed", "unknown"]), source_id: id.optional() }).optional(), evidence_status: z.enum(["verified", "claimed", "unknown"]),
        source: z.object({ id: id.optional(), source_type: z.enum(["independent_lab", "accredited_lab", "professional_review", "manufacturer", "retailer", "customer_review", "other"]), independence_key: z.string().max(500).optional(), funding_relationship: z.enum(["none", "manufacturer", "seller", "platform", "unknown"]), funding_evidence_status: z.enum(["verified", "claimed", "unknown"]), editorial_independence_verified: z.boolean(), editorial_independence_evidence_status: z.enum(["verified", "claimed", "unknown"]) }),
      })).max(100_000),
    },
  }, async (input) => asText(assessShoppingPerformance(input)));
  tool("shopping_candidate_coverage", {
    title: "Audit candidate discovery coverage",
    description: "Deterministically audit a bounded product-discovery plan for exact category and market scope, required source lanes, fresh completed searches, actual query diversity, direct provenance, source and corporate independence, sponsored or affiliate concentration, noncommercial coverage, viable candidate count, and explicit non-exhaustiveness. It partitions candidates but never ranks, selects, or buys.",
    inputSchema: {
      category: id, market_country: z.string().length(2), evaluated_at: z.string().datetime(),
      policy: z.object({ max_age_days: z.number().positive().max(365).optional(), min_eligible_candidates: z.number().int().min(1).max(10_000).optional(), min_independent_sources: z.number().int().min(1).max(1_000).optional(), min_query_families: z.number().int().min(1).max(100).optional(), require_noncommercial_source: z.boolean().optional(), max_single_owner_share: z.number().min(0).max(1).optional(), max_paid_placement_share: z.number().min(0).max(1).optional() }).optional().default({}),
      lanes: z.array(z.object({ id, kind: z.enum(["manufacturer_catalog", "independent_testing", "independent_editorial", "specialist_retailer", "general_retailer", "marketplace", "local_retailer", "used_or_refurbished", "other"]), required: z.boolean(), reason: z.string().max(1_000).optional() })).max(100),
      searches: z.array(z.object({ id, lane_id: id, query_family: id, query_text: z.string().min(1).max(2_000), category: id, market_country: z.string().length(2), status: z.enum(["complete", "partial", "error"]), evidence_status: z.enum(["verified", "claimed", "unknown"]), source_id: id.optional(), searched_at: z.string().datetime() })).max(10_000),
      results: z.array(z.object({ id, candidate_id: id, search_id: id, category: id, market_country: z.string().length(2), identity_status: z.enum(["exact_candidate", "different_category", "unknown"]), market_status: z.enum(["available", "unavailable", "unknown"]), hard_constraint_status: z.enum(["eligible", "rejected", "unknown"]), direct_source_verified: z.boolean(), evidence_status: z.enum(["verified", "claimed", "unknown"]), source_id: id.optional(), independence_key: z.string().max(500).optional(), ownership_key: z.string().max(500).optional(), placement: z.enum(["organic", "direct_catalog", "sponsored", "affiliate", "unknown"]), commercial_relationship: z.enum(["none", "brand", "seller", "sponsored", "affiliate", "unknown"]) })).max(100_000),
    },
  }, async (input) => asText(assessCandidateCoverage(input)));
  tool("shopping_preference_rank", {
    title: "Rank products by user preferences",
    description: "Deterministically enforce hard product constraints and rank different product candidates using explicit weighted preferences. Missing facts produce score bounds and research requests when they could change the winner; the model cannot override the selected candidate.",
    inputSchema: {
      constraints: z.array(constraint).max(100).optional().default([]),
      preferences: z.array(preference).max(100).optional().default([]),
      require_verified_evidence: z.boolean().optional().default(true),
      candidate_coverage: candidateCoverageArtifact,
      candidates: z.array(z.object({ id, price_usd: money, price_evidence_status: z.enum(["verified", "conflict", "insufficient_evidence", "stale"]).optional(), attributes: z.record(attributeValue).optional().default({}), attribute_evidence: z.record(z.enum(["verified", "conflict", "insufficient_evidence", "stale"])).optional().default({}), attribute_roles: z.record(evidenceRole).optional().default({}) })).max(100),
    },
  }, async (input) => asText(rankShoppingCandidates(input)));

  const evidenceSource = z.object({
    id,
    source_type: z.enum(["manufacturer", "official_manual", "regulatory", "retailer", "professional_review", "customer_review", "marketplace_listing", "search_snippet", "user"]),
    url: z.string().url().max(4_000).optional(),
    publisher: z.string().max(300).optional(),
    captured_at: z.string().datetime().optional(),
    independence_key: z.string().max(300).optional(),
    channel: z.string().max(300).optional(),
  });
  const evidenceClaimBase = { product_id: id, attribute: id, source: evidenceSource, excerpt: z.string().max(2_000).optional() };
  const evidenceClaim = z.discriminatedUnion("claim_type", [
    z.object({ ...evidenceClaimBase, claim_type: z.literal("objective"), evidence_role: z.enum(["declared_specification", "measured_performance", "observed_fact", "certification", "policy_term"]), value: attributeValue, unit: z.string().max(100).nullable().optional() }),
    z.object({ ...evidenceClaimBase, review_id: id, claim_type: z.literal("review"), sentiment: z.enum(["positive", "negative", "mixed", "neutral"]), value: attributeValue.optional(), unit: z.string().max(100).nullable().optional() }),
  ]);
  tool("shopping_product_evidence", {
    title: "Aggregate product evidence",
    description: "Deterministically aggregate provenance-backed objective specifications and subjective review themes. It normalizes common units, detects conflicts and stale evidence, requires corroboration outside authoritative sources, excludes search snippets from verification, and deduplicates syndicated review text.",
    inputSchema: {
      policy: z.object({ evaluated_at: z.string().datetime().optional(), max_age_days: z.number().positive().max(3650).optional().default(30), min_independent_sources: z.number().int().min(1).max(20).optional().default(2), min_relevant_reviews: z.number().int().min(1).max(10_000).optional().default(3), min_review_channels: z.number().int().min(1).max(100).optional().default(1) }).optional().default({}),
      review_integrity: z.array(z.object({ product_id: id, action: z.enum(["eligible_for_review_ranking", "research_more", "exclude_reviews"]), eligible_review_ids: z.array(id).max(100_000) })).max(1_000).optional().default([]),
      performance_evidence: z.array(z.object({ product_id: id, attribute: id, action: z.enum(["comparable", "research_more", "conflict"]), performance_cleared_for_ranking: z.boolean(), metric: z.object({ attribute: id, value: z.number().finite(), unit: z.string().max(100), direction: z.enum(["higher_better", "lower_better", "target"]), lower: z.number().finite(), upper: z.number().finite(), independent_labs: z.number().int().positive(), measurement_ids: z.array(id).max(10_000) }).nullable() })).max(10_000).optional().default([]),
      claims: z.array(evidenceClaim).max(2_000),
    },
  }, async (input) => asText(aggregateProductEvidence(input)));

  const reviewCollection = z.object({
    id, channel_id: id, independence_key: z.string().min(1).max(500), product_id: id, variant_id: id.optional(),
    scope_status: z.enum(["exact_product", "exact_variant", "product_family", "different_variant", "unknown"]),
    sampling_method: z.enum(["complete", "random", "systematic", "top_helpful", "recent", "search_selected", "unknown"]),
    population_size: z.number().int().nonnegative().max(10_000_000), sampled_count: z.number().int().nonnegative().max(100_000),
    captured_at: z.string().datetime(), evidence_status: z.enum(["verified", "claimed", "unknown"]), source_id: id.optional(),
  });
  const reviewIntegrityItem = z.object({
    id, collection_id: id, product_id: id, variant_id: id.optional(),
    scope_status: z.enum(["exact_product", "exact_variant", "product_family", "different_variant", "unknown"]),
    source_id: id.optional(), channel_id: id, reviewer_key: z.string().max(500).optional(), text_fingerprint: z.string().max(500).optional(), syndication_key: z.string().max(500).optional(),
    evidence_status: z.enum(["verified", "claimed", "unknown"]), captured_at: z.string().datetime(), published_at: z.string().datetime(),
    moderation_status: z.enum(["published", "removed", "unknown"]), incentive_status: z.enum(["none", "disclosed", "unknown"]), verified_purchase: z.boolean().nullable().optional(), rating: z.number().min(1).max(5),
  });
  tool("shopping_review_integrity", {
    title: "Gate review evidence for product ranking",
    description: "Deterministically gate review-derived ranking evidence by exact product/variant scope, representative sampling, provenance, freshness, organic status, independent reviewer/content deduplication, channel coverage, burst patterns, and verified official enforcement. Signals limit use but never independently prove fake reviews or fraud.",
    inputSchema: {
      product_id: id, variant_id: id.optional(), evaluated_at: z.string().datetime(),
      policy: z.object({ max_age_days: z.number().positive().max(3650).optional(), min_eligible_reviews: z.number().int().min(1).max(100_000).optional(), min_independent_reviewers: z.number().int().min(1).max(100_000).optional(), min_channels: z.number().int().min(1).max(100).optional(), require_representative_sample: z.boolean().optional(), max_duplicate_share: z.number().min(0).max(1).optional(), max_incentivized_share: z.number().min(0).max(1).optional(), max_burst_share: z.number().min(0).max(1).optional(), burst_window_days: z.number().positive().max(365).optional() }).optional().default({}),
      collections: z.array(reviewCollection).max(1_000), reviews: z.array(reviewIntegrityItem).max(100_000),
      findings: z.array(z.object({ id, product_id: id, variant_id: id.optional(), type: z.enum(["fake_review_enforcement", "review_suppression", "incentive_violation", "other"]), authority_type: z.enum(["platform", "regulator", "court", "independent_researcher", "customer_review", "other"]), applies_to_exact_product: z.boolean(), status: z.enum(["active", "resolved", "unknown"]), evidence_status: z.enum(["verified", "claimed", "unknown"]), source_id: id.optional() })).max(1_000).optional().default([]),
    },
  }, async (input) => asText(assessReviewIntegrity(input)));

  const profileScalar = z.union([z.string().max(1_000), z.number().finite(), z.boolean()]);
  const profileValue = z.union([profileScalar, z.array(profileScalar).max(100)]);
  const profileKind = z.enum(["size", "measurement", "compatibility", "accessibility", "material_avoid", "ingredient_avoid", "brand_preference", "merchant_preference", "budget", "ownership_horizon", "sustainability", "delivery", "condition", "color", "feature", "privacy", "other"]);
  const profileRole = z.enum(["hard_constraint", "preference", "default", "assumption"]);
  const profileScope = z.object({ categories: z.array(z.string().max(300)).max(100).optional(), product_keys: z.array(z.string().max(300)).max(100).optional(), merchants: z.array(z.string().max(300)).max(100).optional(), contexts: z.array(z.string().max(300)).max(100).optional() });
  tool("shopping_profile_remember", {
    title: "Remember one consented shopping-profile field",
    description: "Store one explicitly requested shopping constraint, preference, default, or assumption in a private local profile with scope, provenance, sensitivity, and expiry. Sensitive fields require separate consent; credentials, cards, addresses, email, and phone data are forbidden.",
    inputSchema: { key: id, kind: profileKind, decision_role: profileRole, value: profileValue, unit: z.string().max(100).optional(), sensitivity: z.enum(["standard", "sensitive"]).optional(), scope: profileScope.optional().default({}), provenance: z.object({ source_type: z.enum(["user_explicit", "user_confirmed"]), confirmed_at: z.string().datetime().optional() }), user_explicitly_requested_memory: z.boolean(), sensitive_data_consent: z.boolean().optional(), expires_at: z.string().datetime().optional(), ttl_days: z.number().int().min(1).max(3650).optional(), never_expires: z.boolean().optional(), user_explicitly_requested_permanent: z.boolean().optional(), return_sensitive_value: z.boolean().optional().default(false) },
  }, async (input) => asText(await rememberShoppingProfileField(input)));

  tool("shopping_profile_list", {
    title: "List consented shopping-profile fields",
    description: "List locally stored shopping-profile fields. Sensitive values are redacted by default and require explicit per-request viewing authorization; expired and paused fields are hidden by default.",
    inputSchema: { evaluated_at: z.string().datetime().optional(), include_paused: z.boolean().optional().default(false), include_expired: z.boolean().optional().default(false), include_sensitive: z.boolean().optional().default(false), user_authorized_sensitive_view: z.boolean().optional() },
  }, async (input) => asText(await listShoppingProfile(input)));

  tool("shopping_profile_resolve", {
    title: "Resolve applicable shopping-profile fields",
    description: "Resolve active unexpired fields for a specific category, product, merchant, and context, returning the exact profile state_revision for decision-context binding. More-specific scopes override broader ones; equally specific value conflicts require clarification. Sensitive values require explicit authorization for this request.",
    inputSchema: { evaluated_at: z.string().datetime().optional(), context: z.object({ category: z.string().max(300).optional(), product_key: z.string().max(300).optional(), merchant: z.string().max(300).optional(), context: z.string().max(300).optional() }).optional().default({}), include_sensitive: z.boolean().optional().default(false), user_authorized_sensitive_use: z.boolean().optional() },
  }, async (input) => asText(await resolveShoppingProfile(input)));

  tool("shopping_profile_update", {
    title: "Update or pause a shopping-profile field",
    description: "Change, pause, or resume one remembered field only on explicit user request. Requires the current revision; sensitive value changes need renewed sensitive-data consent.",
    inputSchema: { field_id: id, expected_revision: z.number().int().positive(), value: profileValue.optional(), scope: profileScope.optional(), status: z.enum(["active", "paused"]).optional(), decision_role: profileRole.optional(), expires_at: z.string().datetime().optional(), ttl_days: z.number().int().min(1).max(3650).optional(), never_expires: z.boolean().optional(), user_explicitly_requested_permanent: z.boolean().optional(), user_explicitly_requested_update: z.boolean(), sensitive_data_consent: z.boolean().optional(), return_sensitive_value: z.boolean().optional().default(false) },
  }, async (input) => asText(await updateShoppingProfileField(input)));

  tool("shopping_profile_forget", {
    title: "Permanently forget one shopping-profile field",
    description: "Permanently erase one field and its value from the private local shopping profile. Requires its current revision, an explicit user forget request, and explicit permanent-deletion confirmation; deletion is not recoverable.",
    inputSchema: { field_id: id, expected_revision: z.number().int().positive(), user_explicitly_requested_forget: z.boolean(), confirm_permanent_deletion: z.boolean() },
  }, async (input) => asText(await forgetShoppingProfileField(input)));

  const protectionPriority = z.enum(["return_window", "return_cost", "warranty_duration", "warranty_claim_cost", "repairability", "downtime", "buyer_protection"]);
  tool("shopping_protection_assess", {
    title: "Assess returns, warranty, repairability, and buyer protection",
    description: "Deterministically reconstruct exact-offer price, seller, identity, return terms, warranty terms and eligibility, repairability, and buyer-protection windows only from fresh signed browser page artifacts plus process-attested identity. The model cannot submit policy objects or verified protection facts. Unknown policy inventory blocks clearance; exposure and selection remain deterministic.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(),
      max_page_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300),
      max_identity_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600),
      identity: identityArtifact,
      requirements: z.object({ returns_required: z.boolean().optional(), min_return_window_days: z.number().int().nonnegative().max(3650).optional(), opened_returns_required: z.boolean().optional(), max_return_cost_usd: z.number().finite().nonnegative().max(100_000_000).optional(), warranty_required: z.boolean().optional(), manufacturer_warranty_required: z.boolean().optional(), min_warranty_months: z.number().int().nonnegative().max(240).optional(), parts_and_labor_required: z.boolean().optional(), max_warranty_claim_cost_usd: z.number().finite().nonnegative().max(100_000_000).optional(), repair_parts_required: z.boolean().optional(), repair_manual_required: z.boolean().optional(), max_downtime_days: z.number().finite().nonnegative().max(3650).optional(), min_buyer_protection_days: z.number().int().nonnegative().max(3650).optional() }).optional().default({}),
      priorities: z.array(protectionPriority).max(7).optional().default([]),
      decision_mode: z.enum(["pareto", "lexicographic"]).optional().default("pareto"),
      candidates: z.array(z.object({
        id,
        listing_evidence: pageEvidenceArtifact,
        return_policy_evidence: pageEvidenceArtifact.optional(),
        warranty_evidence: pageEvidenceArtifact.optional(),
        authorization_evidence: pageEvidenceArtifact.optional(),
        repairability_evidence: pageEvidenceArtifact.optional(),
        buyer_protection_evidence: pageEvidenceArtifact.optional(),
      })).max(100),
    },
  }, async (input) => asText(assessShoppingProtectionFromEvidence(input)));

  const caseEvidence = z.object({ artifact_attestation: artifactAttestation("case_evidence"), evidence_id: id, type: z.enum(["order_receipt", "merchant_policy", "manufacturer_policy"]), verified: z.literal(true), source_url: z.string().url().max(4_000), captured_at: z.string().datetime(), excerpt: z.string().max(2_000), facts: z.record(z.any()), source_evidence: pageEvidenceArtifact }).passthrough();
  tool("shopping_case_evidence", {
    title: "Create signed post-purchase evidence",
    description: "Convert a fresh complete signed order-receipt, exact return-policy, or manufacturer-warranty page artifact into process-attested case evidence. Caller-authored verification flags, excerpts, URLs, order facts, and policy records are not accepted.",
    inputSchema: { page_evidence: pageEvidenceArtifact, max_age_seconds: z.number().int().min(10).max(3_600).optional().default(300) },
  }, async (input) => asText(createShoppingCaseEvidence({ ...input, evaluated_at: new Date().toISOString() })));
  const caseEventEvidence = z.object({ artifact_attestation: artifactAttestation("case_event_evidence"), event_evidence_id: id, type: z.enum(["delivered", "merchant_contacted", "return_requested", "return_shipped", "refund_received", "warranty_registered", "claim_opened", "claim_resolved"]), at: z.string().datetime(), order_number: id, product_id: id, reference: z.string().max(500).nullable().optional(), counterparty: z.string().max(500).nullable().optional(), captured_at: z.string().datetime(), evaluated_at: z.string().datetime(), source_url: z.string().url().max(4_000), source_evidence: pageEvidenceArtifact }).passthrough();
  tool("shopping_case_event_evidence", {
    title: "Create signed post-purchase event evidence",
    description: "Convert a fresh complete signed merchant-correspondence, carrier-tracking, return-status, or warranty-status page into exact-order event evidence. Event type, time, order, product, reference, counterparty, text, and URL cannot be caller-authored.",
    inputSchema: { page_evidence: pageEvidenceArtifact, max_age_seconds: z.number().int().min(10).max(3_600).optional().default(300) },
  }, async (input) => asText(createShoppingCaseEventEvidence({ ...input, evaluated_at: new Date().toISOString() })));
  tool("shopping_case_create", {
    title: "Create a private post-purchase case",
    description: "Store a private post-purchase case only after resolving an immutable panel message that explicitly requests persistence. Exact order facts must match fresh process-attested receipt evidence and a process-attested exact-offer protection policy snapshot; raw verification flags, policy objects, receipt substitutions, and payment credentials are rejected.",
    inputSchema: {
      label: z.string().max(200).optional(),
      request_id: id,
      merchant: z.string().min(1).max(300),
      seller: z.string().max(300).optional(),
      identity: identity.extend({ id }),
      offer_id: id,
      order: z.object({ order_number: z.string().max(300).optional(), purchased_at: z.string().datetime(), delivered_at: z.string().datetime().nullable().optional(), currency: z.string().length(3).optional().default("USD"), item_price_usd: money, shipping_usd: money, total_usd: money }),
      protection_evidence: protectionArtifact,
      max_protection_age_seconds: z.number().int().min(10).max(31_536_000).optional().default(2_592_000),
      max_case_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300),
      serial_number: z.string().max(300).optional(),
      evidence: z.array(caseEvidence).max(100).optional().default([]),
    },
  }, async (input) => {
    const request = await resolvePanelRequest(input.request_id);
    const request_receipt = issueShoppingRequestReceipt(request);
    const { request_id: ignored, ...caseInput } = input;
    return asText(await createShoppingCase({ ...caseInput, request_receipt }));
  });

  tool("shopping_case_list", {
    title: "List post-purchase cases and deadlines",
    description: "Read private local purchase cases with freshly derived return, registration, buyer-protection, and warranty deadline states. Evidence and event details are hidden unless explicitly requested.",
    inputSchema: { statuses: z.array(z.enum(["open", "resolved", "archived"])).max(3).optional(), include_archived: z.boolean().optional().default(false), include_evidence: z.boolean().optional().default(false), include_events: z.boolean().optional().default(false), evaluated_at: z.string().datetime().optional(), due_within_days: z.number().int().nonnegative().max(3650).optional() },
  }, async (input) => asText(await listShoppingCases(input)));

  tool("shopping_case_update", {
    title: "Update a post-purchase case",
    description: "Add process-attested page-derived policy or exact-order event evidence, a serial number, or a nonauthoritative private note to a case; resolve or recoverably archive it. Delivery and consequential events cannot be caller-authored. Uses optimistic revisions, rejects replay and wrong-order evidence, and never contacts a merchant.",
    inputSchema: { case_id: id, expected_revision: z.number().int().positive().optional(), status: z.enum(["open", "resolved", "archived"]).optional(), label: z.string().max(200).nullable().optional(), serial_number: z.string().max(300).nullable().optional(), evidence: z.array(caseEvidence).max(100).optional(), event_evidence: caseEventEvidence.optional(), note: z.object({ text: z.string().min(1).max(2_000), reference: z.string().max(500).optional() }).optional(), max_case_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300), max_event_evidence_age_seconds: z.number().int().min(10).max(3_600).optional().default(300) },
  }, async (input) => asText(await updateShoppingCase(input)));

  tool("shopping_case_prepare_action", {
    title: "Prepare a return or protection action",
    description: "Build a deterministic draft-only return, warranty-claim, or buyer-protection package from stored verified evidence. Reports deadlines, missing evidence, and blockers; submission_allowed is always false and external action needs a new explicit confirmation.",
    inputSchema: { case_id: id, action: z.enum(["return", "warranty_claim", "buyer_protection"]), problem: z.string().max(2_000), requested_resolution: z.string().max(500), evaluated_at: z.string().datetime().optional() },
  }, async (input) => asText(await prepareShoppingCaseAction(input)));

  const decisionOffer = z.object({
    id, product_key: id.optional(), variant: id.optional(), condition: id.optional(), serial_number: z.string().max(300).optional(), quantity: z.number().positive().max(100_000).optional(),
    seller: z.string().min(1).max(300), price_usd: money, shipping_usd: money, coupon_usd: money, coupon_eligible: z.boolean().optional(), promotion_claimed: z.boolean().optional(), promotion_required_for_decision: z.boolean().optional(),
    authorized_seller: tri, return_days: z.number().int().nonnegative().max(3650).optional(),
  });
  const unitValueArtifact = z.object({ action: z.enum(["comparable", "research_more"]), safe_for_value_ranking: z.boolean(), assessments: z.array(z.object({ offer_id: id, status: z.enum(["comparable", "research_more"]), normalized_quantity: z.number().finite().positive().nullable(), normalized_unit: z.string().min(1).max(50).nullable(), landed_total_usd: z.number().finite().nonnegative().nullable() })).max(100) });
  const promotionArtifact = z.object({ artifact_attestation: artifactAttestation("promotion"), offer_id: id, product_id: id, evaluated_at: z.string().datetime(), action: z.enum(["eligible", "research_more", "clarify", "avoid_offer"]), pricing_cleared: z.boolean(), base_price_usd: z.number().finite().nonnegative(), shipping_usd: z.number().finite().nonnegative(), immediate_checkout_discount_usd: z.number().finite().nonnegative(), checkout_landed_total_usd: z.number().finite().nonnegative().nullable(), deferred_value_usd: z.number().finite().nonnegative(), required_incremental_cost_usd: z.number().finite().nonnegative(), guaranteed_economic_cost_usd: z.number().finite().nonnegative().nullable(), purchase_allowed: z.literal(false) }).passthrough();
  const fulfillmentRangeArtifact = z.object({ low_usd: z.number().finite().nonnegative(), expected_usd: z.number().finite().nonnegative(), high_usd: z.number().finite().nonnegative() });
  const fulfillmentArtifact = z.object({ artifact_attestation: artifactAttestation("fulfillment"), artifact_id: id, evaluated_at: z.string().datetime(), destination_country: z.string().length(2), assessments: z.array(z.object({ id, product_id: id, action: z.enum(["eligible", "research_more", "clarify", "avoid_offer"]), fully_landed_total_usd: fulfillmentRangeArtifact.nullable(), fully_landed_status: z.enum(["verified", "estimated", "unknown"]), safe_for_offer_comparison: z.boolean(), promotion: z.object({ artifact_evaluated_at: z.string().datetime(), immediate_checkout_discount_usd: z.number().finite().nonnegative(), required_incremental_cost_usd: z.number().finite().nonnegative() }).nullable().optional(), purchase_allowed: z.literal(false) }).passthrough()).max(100) }).passthrough();
  const counterfeitArtifact = checkoutCounterfeitArtifact;
  tool("shopping_offer_analyze", {
    title: "Analyze shopping offers",
    description: "Deterministically select offers only after a complete fresh process-attested exact-product recommendation dossier plus canonical identity, official product-safety, signed exact-listing availability, fulfillment, merchant-trust, counterfeit-risk, authorized-seller requirement, and purchase-protection artifacts clear each exact offer. Raw listing or model-authored stock and authorized-seller flags are nonauthoritative. Unknown signed availability requires research and verified out-of-stock inventory cannot rank. A forged, edited, restarted-process, or wrong-product clearance cannot rank. A product the unified dossier did not select cannot enter retailer ranking. Lookalikes, recalls, bans, certification failures, regional/edition/condition mismatches, and unknown, elevated, rejected, missing, stale, or scope-mismatched results cannot rank. The fulfillment ledger remains the sole acquisition-cost source, including tax, duty, brokerage, carrier, currency, and verified promotion obligations. Overlapping estimated ranges require clarification unless the user explicitly permits expected-value selection. Unit-cost optimization also requires exact landed cost and a cleared shopping_value_assess artifact.",
    inputSchema: {
      requirements: z.object({ product_key: id.optional(), variant: id.optional(), condition: id.optional(), min_quantity: z.number().positive().max(100_000).optional(), quantity_unit: z.string().min(1).max(50).optional(), authorized_seller: z.boolean().optional(), max_landed_usd: z.number().nonnegative().max(10_000_000).optional(), max_landed_operator: z.enum(["lt", "lte"]).optional().default("lte") }).optional().default({}),
      objective: z.enum(["landed_total", "unit_cost"]).optional().default("landed_total"),
      clarification_required: z.boolean().optional().default(false),
      evaluated_at: z.string().datetime().optional(), destination_country: z.string().length(2), max_promotion_age_seconds: z.number().int().min(10).max(86_400).optional().default(900), max_fulfillment_age_seconds: z.number().int().min(10).max(86_400).optional().default(900), max_counterfeit_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), max_merchant_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), max_protection_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), max_identity_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), max_safety_age_seconds: z.number().int().min(10).max(604_800).optional().default(86_400), max_product_clearance_age_seconds: z.number().int().min(10).max(86_400).optional().default(3_600), allow_expected_landed_selection: z.boolean().optional().default(false),
      offers: z.array(decisionOffer).max(100),
      unit_value: unitValueArtifact.optional(),
      promotion_artifacts: z.array(promotionArtifact).max(100).optional().default([]),
      fulfillment: fulfillmentArtifact,
      counterfeit: counterfeitArtifact,
      merchant: merchantTrustArtifact,
      protection: protectionArtifact,
      identity: identityArtifact,
      safety: safetyArtifact,
      product_clearance: productClearanceArtifact,
    },
  }, async (input) => asText(analyzeShoppingOffers(input)));

  const valueEvidence = z.object({ evidence_status: z.enum(["verified", "estimated", "conflict", "unknown"]), source_id: id.optional() });
  const valueAmount = z.object({ value: z.number().finite().positive().max(1_000_000_000), unit: z.string().min(1).max(50), ...valueEvidence.shape });
  const valuePackage = z.object({ pack_count: z.object({ value: z.number().int().positive().max(1_000_000), ...valueEvidence.shape }), net_quantity: valueAmount });
  const usableYield = valueAmount.extend({ protocol_id: id, protocol_evidence_status: z.enum(["verified", "estimated", "conflict", "unknown"]), protocol_source_id: id.optional(), conditions_complete: z.boolean(), conditions: z.record(z.union([z.string().max(500), z.number().finite(), z.boolean()])) });
  tool("shopping_value_assess", {
    title: "Normalize comparable shopping value",
    description: "Deterministically normalize exact pack size or usable yield across typed dimensions and verified units; require pack, protocol, condition, and quality-equivalence evidence; detect scoped package reduction and unit-cost increases; and produce a nonselecting unit-value artifact. Raw listing quantity, incompatible dimensions, serving/dose substitution, and model-guessed equivalence never clear value ranking.",
    inputSchema: {
      evaluated_at: z.string().datetime().optional(),
      policy: z.object({ max_age_days: z.number().int().min(1).max(365).optional(), max_history_age_days: z.number().int().min(1).max(3_650).optional() }).optional(),
      basis: z.object({ id, source: z.enum(["net_quantity", "usable_yield"]), dimension: z.enum(["count", "mass", "volume", "length", "area", "duration", "servings", "uses", "loads", "doses"]), unit: z.string().min(1).max(50), conditions_complete: z.boolean(), conditions: z.record(z.union([z.string().max(500), z.number().finite(), z.boolean()])), quality_equivalence_required: z.boolean() }),
      offers: z.array(z.object({
        id, product_id: id, variant_id: id.optional(), exact_identity: z.boolean(), captured_at: z.string().datetime(), landed_total: z.object({ value: z.number().finite().nonnegative().max(10_000_000), ...valueEvidence.shape }), package: valuePackage, usable_yield: usableYield.optional(), quality_equivalent: z.object({ value: z.boolean(), ...valueEvidence.shape }).optional(),
        prior_version: z.object({ product_id: id, variant_id: id.optional(), observed_at: z.string().datetime(), ...valueEvidence.shape, landed_total: z.object({ value: z.number().finite().nonnegative().max(10_000_000), ...valueEvidence.shape }), package: valuePackage, usable_yield: usableYield.optional() }).optional(),
      })).min(1).max(100),
    },
  }, async (input) => asText(assessShoppingValue(input)));

  const evidenceRange = z.object({ low: z.number().finite().nonnegative().max(100_000_000).optional(), expected: z.number().finite().nonnegative().max(100_000_000).optional(), high: z.number().finite().nonnegative().max(100_000_000).optional(), evidence_status: z.enum(["verified", "estimated", "unknown"]) });
  const ownershipComponent = z.object({ name: id, category: z.enum(["accessory", "subscription", "service", "maintenance", "repair", "installation", "other"]), kind: z.enum(["one_time", "recurring"]), amount_usd: evidenceRange, included: z.boolean().optional().default(true), quantity: z.number().finite().positive().max(1_000_000).optional().default(1), start_month: z.number().int().min(0).max(240).optional(), end_month: z.number().int().min(0).max(240).optional(), interval_months: z.number().int().positive().max(240).optional(), annual_increase_percent: z.number().finite().min(-100).max(1_000).optional().default(0) });
  tool("shopping_ownership_cost", {
    title: "Analyze total cost of ownership",
    description: "Deterministically calculate bounded nominal and present-value ownership costs across acquisition, accessories, subscriptions, consumables, energy, maintenance, repairs, and verified residual value. Missing included costs remain unbounded; selection requires a robust range advantage unless the user explicitly permits expected-value selection.",
    inputSchema: {
      horizon_months: z.number().int().min(1).max(240),
      annual_discount_rate_percent: z.number().finite().min(0).max(100).optional().default(0),
      decision_basis: z.enum(["nominal", "present_value"]).optional().default("nominal"),
      allow_expected_value_selection: z.boolean().optional().default(false),
      candidates: z.array(z.object({
        id,
        identity_verified: z.boolean(),
        acquisition_usd: evidenceRange,
        cost_components: z.array(ownershipComponent).max(500).optional().default([]),
        consumables: z.array(z.object({ name: id, unit_cost_usd: evidenceRange, units_per_month: evidenceRange, included: z.boolean().optional().default(true), start_month: z.number().int().min(0).max(240).optional(), end_month: z.number().int().min(0).max(240).optional(), annual_increase_percent: z.number().finite().min(-100).max(1_000).optional().default(0) })).max(200).optional().default([]),
        energy: z.array(z.object({ name: id, power_watts: evidenceRange, hours_per_day: evidenceRange, days_per_year: evidenceRange, electricity_rate_usd_per_kwh: evidenceRange, included: z.boolean().optional().default(true) })).max(100).optional().default([]),
        residual_value_usd: evidenceRange.optional(),
      })).max(100),
    },
  }, async (input) => asText(analyzeOwnershipCosts(input)));

  const riskOffer = z.object({
    id, landed_total_usd: money, authorized_seller: tri, manufacturer_warranty: tri,
    identifier_conflict: z.boolean().optional(), authenticity_complaints: z.number().int().nonnegative().max(1_000_000).optional(), packaging_mismatch: z.boolean().optional(), seal_issues: z.boolean().optional(),
    sold_by_platform: tri, fulfilled_by_platform: tri, gray_market_disclosed: z.boolean().optional(), condition: z.enum(["new", "used", "open_box", "refurbished"]).optional(), exact_product: z.boolean().optional(), returnable: tri,
  });
  tool("shopping_risk_features", {
    title: "Derive shopping risk evidence",
    description: "Derive bounded authenticity/seller-risk evidence flags and price anomalies without declaring an item counterfeit. The main brain must assess calibrated risk from these facts.",
    inputSchema: { authorized_market_median_usd: z.number().positive().max(10_000_000).nullable().optional(), offers: z.array(riskOffer).max(100) },
  }, async (input) => asText({ risk_features: deriveShoppingRiskFeatures(input) }));

  const researchOffer = z.object({ id, exact_product: z.boolean().optional(), stock_verified: z.boolean().optional(), in_stock: z.boolean().optional(), unknown_fields: z.array(id).max(50).optional(), stock_claims: z.array(z.string().max(500)).max(50).optional() });
  tool("shopping_research_features", {
    title: "Derive shopping research state",
    description: "Normalize exact-offer coverage, critical unknowns, availability, and independent-retailer counts so the main brain can decide whether to select, verify, search, or clarify.",
    inputSchema: { policy: z.object({ min_independent_sources: z.number().int().min(0).max(20).optional().default(2) }).optional().default({ min_independent_sources: 2 }), sources: z.array(z.string().min(1).max(500)).max(100), offers: z.array(researchOffer).max(100) },
  }, async (input) => asText({ research_features: deriveShoppingResearchFeatures(input) }));

  const watchTargets = z.object({ target_price_usd: money, maximum_deal_quality: z.enum(["historical_low", "well_below_typical", "below_typical", "typical"]).nullable().optional(), minimum_discount_vs_median_percent: z.number().finite().min(0).max(100).nullable().optional(), match_mode: z.enum(["any", "all"]).optional().default("any") });
  const watchSettings = z.object({ cooldown_hours: z.number().finite().min(0).max(8_760).optional(), realert_drop_usd: z.number().finite().nonnegative().max(10_000_000).optional(), expires_at: z.string().datetime().nullable().optional(), check_interval_minutes: z.number().int().min(5).max(10_080).optional(), retry_base_minutes: z.number().int().min(1).max(1_440).optional() });
  tool("shopping_watch_claim_due", {
    title: "Claim due shopping watches",
    description: "Atomically lease a bounded batch of active due watches to one scheduler worker. Concurrent workers cannot claim a live lease; expired leases are recoverable.",
    inputSchema: { worker_id: id, at: z.string().datetime().optional(), limit: z.number().int().min(1).max(50).optional().default(10), lease_seconds: z.number().int().min(30).max(3_600).optional().default(300) },
  }, async (input) => asText(await claimDueShoppingWatches(input)));

  tool("shopping_watch_complete_run", {
    title: "Complete a shopping watch scheduler run",
    description: "Release a watch lease, record a bounded run outcome, and schedule the next normal check or deterministic exponential retry. The run ID must still own the lease.",
    inputSchema: { watch_id: id, run_id: id, outcome: z.enum(["success", "partial", "failed"]), completed_at: z.string().datetime().optional(), error_code: z.string().max(120).optional(), evaluated_offers: z.number().int().nonnegative().max(10_000).optional().default(0), alert_decisions: z.number().int().nonnegative().max(10_000).optional().default(0) },
  }, async (input) => asText(await completeShoppingWatchRun(input)));

  tool("shopping_watch_create", {
    title: "Create a persistent shopping watch",
    description: "Create an idempotent local exact-product price/deal watch only when the user explicitly requests monitoring. Stores private state locally; it never buys, checks out, or contacts a merchant.",
    inputSchema: { label: z.string().max(200).optional(), identity, required_fields: z.array(identityField).min(1).max(20), targets: watchTargets, sources: z.array(z.string().url().max(4_000)).max(100).optional().default([]), settings: watchSettings.optional().default({}) },
  }, async (input) => asText(await createShoppingWatch(input)));

  tool("shopping_watch_list", {
    title: "List persistent shopping watches",
    description: "Read locally stored shopping watches. Archived watches are hidden unless explicitly requested; observation history is summarized unless explicitly included.",
    inputSchema: { statuses: z.array(z.enum(["active", "paused", "archived"])).max(3).optional(), include_archived: z.boolean().optional().default(false), include_history: z.boolean().optional().default(false) },
  }, async (input) => asText(await listShoppingWatches(input)));

  tool("shopping_watch_update", {
    title: "Update, pause, resume, or archive a shopping watch",
    description: "Mutate a local shopping watch only when the user explicitly requests the change. Uses optimistic revisions to prevent lost updates; archive is recoverable and replaces destructive deletion.",
    inputSchema: { watch_id: id, expected_revision: z.number().int().positive().optional(), status: z.enum(["active", "paused", "archived"]).optional(), label: z.string().max(200).nullable().optional(), targets: watchTargets.optional(), sources: z.array(z.string().url().max(4_000)).max(100).optional(), settings: watchSettings.optional() },
  }, async (input) => asText(await updateShoppingWatch(input)));

  tool("shopping_watch_evaluate", {
    title: "Evaluate a shopping watch observation",
    description: "Evaluate and persist one fresh offer observation against a local exact-product watch. Enforces canonical identity, risk, stock, landed price, history targets, cooldown, and re-alert rules. Returns a notification decision only; purchase_allowed is always false.",
    inputSchema: {
      watch_id: id,
      run_id: id.optional().describe("Required for scheduled evaluations after shopping_watch_claim_due; omit for an explicit foreground user check."),
      candidate_identity: identity,
      current: z.object({ variant: id.optional(), condition: id.optional(), currency: z.string().length(3).optional().default("USD"), landed_total_usd: money, landed_price_verified: z.boolean(), stock: z.enum(["in_stock", "out_of_stock", "unknown"]), risk_status: z.enum(["low", "acceptable", "elevated", "unknown"]), merchant: z.string().max(300).optional(), offer_url: z.string().url().max(4_000).optional(), reference_price_usd: money, advertised_discount_percent: z.number().finite().min(-1_000).max(100).optional(), reference_price_verified: z.boolean().optional(), sale_claimed: z.boolean().optional() }),
      captured_at: z.string().datetime(),
      source: historySource,
      history_policy: z.object({ max_history_days: z.number().int().positive().max(3650).optional(), min_observations: z.number().int().positive().max(10_000).optional(), min_distinct_days: z.number().int().positive().max(3650).optional(), min_span_days: z.number().nonnegative().max(3650).optional() }).optional().default({}),
    },
  }, async (input) => asText(await evaluateShoppingWatch(input)));

  registerTool("shopping_evaluator_batch", {
    title: "Run a bounded shopping evaluator wave",
    description: "Create a process-attested decision context and run up to 24 ready, independent, allowlisted read-only shopping evaluators with bounded concurrency in one tool round trip. Before execution, the harness rejects duplicate stages, applicability-skipped stages, and product/offer subjects that differ from the context, avoiding wasted work and competing artifacts. The context binds the request revision, user-state revision, objective, constraints, destination, applicability, product, and offer. The process derives common domain evaluator bindings from signed request clauses, rejects caller-authored alternatives, and requires each job to claim its complete routed constraint set. Canonical rules and literals must appear unchanged in the evaluator's real input before execution. Every successful stage is bound to that context; altered, omitted, substituted, or mixed-context waves fail closed. Per-job duration, wave wall time, and avoided executions expose latency without weakening gates. Failures remain isolated, and shopping_decision_dossier remains mandatory.",
    inputSchema: {
      decision_context: shoppingDecisionContextInputSchema,
      max_concurrency: z.number().int().min(1).max(8).optional().default(4),
      max_result_chars: z.number().int().min(10_000).max(500_000).optional(),
      jobs: z.array(z.object({ job_id: id, tool: z.enum(Object.keys(SHOPPING_EVALUATOR_STAGES)), subject: z.object({ product_id: id, offer_id: id.optional() }), constraint_ids: z.array(id).max(1_000).optional().default([]), arguments: z.record(z.any()) })).min(1).max(24),
    },
  }, async (input) => {
    const evaluatedAt = new Date().toISOString();
    const profile = await listShoppingProfile({ evaluated_at: evaluatedAt });
    if (input.decision_context.profile_state_revision !== profile.state_revision) throw Object.assign(new Error("Decision context profile revision is stale; resolve the shopping profile again"), { code: "shopping_decision_context_profile_stale" });
    const decisionContext = createShoppingDecisionContext(input.decision_context);
    return asText(await runShoppingEvaluatorBatch({
      jobs: input.jobs,
      max_concurrency: input.max_concurrency,
      max_result_chars: input.max_result_chars ?? defaultEvaluatorResultChars(),
      evaluated_at: decisionContext.evaluated_at,
      decision_context: decisionContext,
      required_stages: requiredShoppingDossierStages({ phase: decisionContext.phase, applicability: decisionContext.applicability, stages: {}, decision_context: decisionContext }),
      stage_adapter: adaptShoppingEvaluatorResult,
      constraint_validator: validateShoppingConstraintJob,
    }, evaluatorRegistry));
  });
}
