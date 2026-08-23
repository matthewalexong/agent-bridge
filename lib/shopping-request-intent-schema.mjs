import { z } from "zod";

const id = z.string().min(1).max(160);
export const shoppingConstraintKindSchema = z.enum(["budget", "deadline", "compatibility", "safety", "composition", "privacy", "condition", "merchant", "fulfillment", "preference", "other"]);
export const shoppingLiteralBindingSchema = z.object({
  literal_id: z.string().regex(/^literal_[a-f0-9]{24}$/),
  kind: z.enum(["money", "measurement", "percentage", "quantity", "deadline", "negation"]),
  operator: z.enum(["lt", "lte", "gt", "gte", "eq", "approx", "by", "not_allowed", "unknown"]),
  value: z.union([z.number().finite(), z.string().min(1).max(500), z.boolean()]),
  unit: z.string().min(1).max(40).nullable(),
});
export const shoppingLiteralFactSchema = shoppingLiteralBindingSchema.extend({
  raw: z.string().min(1).max(500),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
export const shoppingRequestClauseSchema = z.object({
  clause_id: z.string().regex(/^clause_[a-f0-9]{24}$/),
  index: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  text: z.string().min(1).max(20_000),
  constraint_hints: z.array(shoppingConstraintKindSchema).max(11),
  literal_facts: z.array(shoppingLiteralFactSchema).max(100),
});

export const shoppingRequestReceiptSchema = z.object({
  artifact_id: z.string().regex(/^shopping_request_[a-f0-9]{32}$/),
  artifact_attestation: z.string().regex(/^v1\.shopping_request\.[a-f0-9]{64}$/),
  request_id: id,
  request_revision: z.number().int().positive(),
  captured_at: z.string().datetime(),
  message_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1).max(20_000),
  clauses: z.array(shoppingRequestClauseSchema).min(1).max(500),
});

export const shoppingClauseDispositionSchema = z.object({
  clause_id: z.string().regex(/^clause_[a-f0-9]{24}$/),
  role: z.enum(["objective", "constraint", "objective_and_constraint", "context", "nonshopping"]),
  constraint_ids: z.array(id).min(1).max(100).optional(),
  reason: z.string().min(1).max(1_000).optional(),
});
