import { z } from "zod";

const clauseId = z.string().regex(/^clause_[a-f0-9]{24}$/);
const scalar = z.union([z.string().min(1).max(500), z.number().finite(), z.boolean()]);
const objectValue = z.object({
  name: z.string().min(1).max(500).optional(),
  max: z.number().finite().nonnegative().optional(),
  unit: z.string().min(1).max(100).optional(),
  scheme: z.string().min(1).max(300).optional(),
  jurisdiction: z.string().length(2).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "projection object must not be empty" });

export const shoppingConstraintProjectionRuleSchema = z.enum([
  "excluded_ingredient", "excluded_material", "max_concentration", "allergen", "required_claim", "prohibited_hazard",
  "prohibited_data_category", "prohibit_targeted_ads", "prohibit_data_sale", "allowed_third_party_purpose", "max_retention_days",
  "account_optional_required", "local_core_operation_required", "deletion_required", "export_required", "consent_withdrawal_required",
  "max_deletion_days", "encryption_in_transit_required", "encryption_at_rest_required", "mfa_required", "prohibited_required_permission", "secure_resale_required",
  "allowed_condition", "allow_for_parts", "required_function_test", "require_authorized_refurbisher", "data_wipe_required", "sanitation_required",
  "battery_health_required", "min_battery_health_percent", "max_battery_cycles", "device_lock_checks_required", "carrier_lock_allowed", "required_accessory",
  "verified_legal_seller_required", "authorized_seller_required", "return_destination_required", "allowed_merchant_return_country", "reversible_payment_required", "buyer_protection_required",
  "require_tracking", "require_verified_return_destination", "require_return_cost", "allowed_fulfillment_return_country",
  "delivery_evidence_required",
  "certification_requirement",
]);

export const shoppingConstraintEvaluatorBindingSchema = z.object({
  stage: z.enum(["composition", "privacy", "condition", "merchant", "counterfeit", "fulfillment", "safety", "checkout"]),
  rule: shoppingConstraintProjectionRuleSchema,
  value: z.union([scalar, z.array(scalar).min(1).max(100), objectValue]),
  source_clause_id: clauseId,
  source_quote: z.string().min(1).max(1_000),
});
