import { z } from "zod";
import { shoppingClauseDispositionSchema, shoppingConstraintKindSchema, shoppingLiteralBindingSchema, shoppingRequestReceiptSchema } from "./shopping-request-intent-schema.mjs";
import { shoppingConstraintEvaluatorBindingSchema } from "./shopping-constraint-projection-schema.mjs";

const id = z.string().min(1).max(160);
export const shoppingPhaseSchema = z.enum(["product_recommendation", "offer_recommendation", "checkout_review"]);
export const shoppingValuePostureSchema = z.enum(["minimum_viable", "best_value", "premium", "best_under_budget"]);
export const shoppingApplicabilityEntrySchema = z.object({ required: z.boolean(), reason: z.string().min(1).max(1_000).optional() });
export const shoppingApplicabilitySchema = z.object({
  candidate_coverage: shoppingApplicabilityEntrySchema,
  performance: shoppingApplicabilityEntrySchema,
  value: shoppingApplicabilityEntrySchema,
  condition: shoppingApplicabilityEntrySchema,
  promotion: shoppingApplicabilityEntrySchema,
  review_integrity: shoppingApplicabilityEntrySchema,
  composition: shoppingApplicabilityEntrySchema,
  privacy: shoppingApplicabilityEntrySchema,
  compatibility: shoppingApplicabilityEntrySchema,
  lifecycle: shoppingApplicabilityEntrySchema,
  preferences: shoppingApplicabilityEntrySchema,
  ownership: shoppingApplicabilityEntrySchema,
  deal: shoppingApplicabilityEntrySchema,
});

const destination = z.object({
  country_code: z.string().length(2),
  region: z.string().min(1).max(160).optional(),
  postal_code: z.string().min(1).max(32).optional(),
}).nullable();

const constraint = z.object({
  id,
  kind: shoppingConstraintKindSchema,
  requirement: z.string().min(1).max(1_000),
  value: z.string().min(1).max(2_000),
  hard_gate: z.boolean(),
  source_clause_ids: z.array(z.string().regex(/^clause_[a-f0-9]{24}$/)).min(1).max(500),
  literal_bindings: z.array(shoppingLiteralBindingSchema).max(500).optional().default([]),
  evaluator_bindings: z.array(shoppingConstraintEvaluatorBindingSchema).max(500).optional().default([]),
});

export const shoppingConstraintRouteSchema = z.object({
  constraint_id: id,
  kind: shoppingConstraintKindSchema,
  status: z.enum(["active", "deferred"]),
  stages: z.array(z.enum(["preferences", "compatibility", "safety", "composition", "privacy", "condition", "merchant", "counterfeit", "fulfillment", "offer", "checkout"])).max(10),
  deferred_until: z.enum(["offer_recommendation", "checkout_review"]).nullable(),
});

export const shoppingDecisionContextInputSchema = z.object({
  request_receipt: shoppingRequestReceiptSchema,
  profile_state_revision: z.number().int().nonnegative(),
  phase: shoppingPhaseSchema,
  product_id: id,
  offer_id: id.nullable().optional().default(null),
  objective: z.string().min(1).max(4_000),
  value_posture: shoppingValuePostureSchema.optional().default("best_value"),
  objective_clause_ids: z.array(z.string().regex(/^clause_[a-f0-9]{24}$/)).min(1).max(500),
  clause_dispositions: z.array(shoppingClauseDispositionSchema).min(1).max(500),
  market_country_code: z.string().length(2),
  destination: destination.optional().default(null),
  constraints: z.array(constraint).max(1_000).optional().default([]),
  applicability: shoppingApplicabilitySchema,
  max_age_seconds: z.number().int().min(300).max(86_400).optional().default(21_600),
});

export const shoppingDecisionContextArtifactSchema = shoppingDecisionContextInputSchema.omit({ max_age_seconds: true }).extend({
  context_id: z.string().regex(/^shopping_context_[a-f0-9]{32}$/),
  request_id: id,
  request_revision: z.number().int().positive(),
  evaluated_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  constraint_routes: z.array(shoppingConstraintRouteSchema).max(1_000),
  artifact_attestation: z.string().regex(/^v1\.decision_context\.[a-f0-9]{64}$/),
});
