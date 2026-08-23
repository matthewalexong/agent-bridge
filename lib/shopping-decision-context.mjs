import crypto from "node:crypto";
import { attestShoppingArtifact, verifyShoppingArtifactAttestation } from "./shopping-attestation.mjs";
import { shoppingDecisionContextArtifactSchema, shoppingDecisionContextInputSchema } from "./shopping-decision-context-schema.mjs";
import { deriveShoppingConstraintRoutes } from "./shopping-constraint-routing.mjs";
import { materializeShoppingConstraintBindings, validateShoppingConstraintBindings } from "./shopping-constraint-projection.mjs";
import { verifyShoppingRequestReceipt } from "./shopping-request-intent.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function coded(message, code = "shopping_decision_context_invalid") {
  return Object.assign(new Error(message), { code });
}

function contextPayload(artifact) {
  const { artifact_attestation: ignoredAttestation, context_id: ignoredId, ...payload } = artifact || {};
  return payload;
}

function contextId(payload) {
  return `shopping_context_${crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex").slice(0, 32)}`;
}

export function createShoppingDecisionContext(rawInput, clock = Date.now) {
  const parsed = shoppingDecisionContextInputSchema.safeParse(rawInput);
  if (!parsed.success) throw coded("Shopping decision context does not satisfy its bounded schema");
  const input = parsed.data;
  if (!verifyShoppingRequestReceipt(input.request_receipt)) throw coded("Decision context requires a valid process-attested user request", "shopping_decision_context_request_invalid");
  const requestAt = Date.parse(input.request_receipt.captured_at);
  const currentAt = clock();
  if (!Number.isFinite(currentAt) || requestAt > currentAt + 300_000 || currentAt - requestAt > 86_400_000) throw coded("Decision context request is not current", "shopping_decision_context_request_stale");
  if (input.phase === "product_recommendation" && input.offer_id !== null) throw coded("Product recommendation context cannot bind an offer", "shopping_decision_context_scope");
  if (input.phase !== "product_recommendation" && !input.offer_id) throw coded("Offer and checkout contexts require an exact offer", "shopping_decision_context_scope");
  if (input.phase !== "product_recommendation" && !input.destination) throw coded("Offer and checkout contexts require an exact destination country", "shopping_decision_context_scope");
  for (const [name, entry] of Object.entries(input.applicability)) {
    if (entry.required === false && !entry.reason) throw coded(`Skipped ${name} applicability requires a reason`, "shopping_decision_context_applicability");
  }
  const clauses = new Map(input.request_receipt.clauses.map((clause) => [clause.clause_id, clause]));
  const literals = new Map();
  for (const clause of clauses.values()) for (const fact of clause.literal_facts) literals.set(fact.literal_id, { clause_id: clause.clause_id, fact });
  const dispositions = new Map();
  const isConstraintRole = (role) => role === "constraint" || role === "objective_and_constraint";
  const isObjectiveRole = (role) => role === "objective" || role === "objective_and_constraint";
  for (const disposition of input.clause_dispositions) {
    if (!clauses.has(disposition.clause_id) || dispositions.has(disposition.clause_id)) throw coded("Every request clause must have exactly one disposition", "shopping_decision_context_clause_coverage");
    if (["context", "nonshopping"].includes(disposition.role) && !disposition.reason) throw coded("Context and nonshopping clause dispositions require a reason", "shopping_decision_context_clause_coverage");
    if ((clauses.get(disposition.clause_id).constraint_hints.length || clauses.get(disposition.clause_id).literal_facts.length) && !isConstraintRole(disposition.role)) throw coded("A hinted request constraint or typed literal cannot be classified as non-constraint text", "shopping_decision_context_constraint_omitted");
    if (isConstraintRole(disposition.role) && !disposition.constraint_ids?.length) throw coded("Constraint clauses must identify their normalized constraints", "shopping_decision_context_clause_coverage");
    if (!isConstraintRole(disposition.role) && disposition.constraint_ids?.length) throw coded("Only constraint clauses may identify normalized constraints", "shopping_decision_context_clause_coverage");
    dispositions.set(disposition.clause_id, disposition);
  }
  if (dispositions.size !== clauses.size) throw coded("Every request clause must have exactly one disposition", "shopping_decision_context_clause_coverage");
  const objectiveIds = new Set(input.objective_clause_ids);
  if (objectiveIds.size !== input.objective_clause_ids.length || [...objectiveIds].some((id) => !isObjectiveRole(dispositions.get(id)?.role)) || [...dispositions.values()].some((item) => isObjectiveRole(item.role) && !objectiveIds.has(item.clause_id))) throw coded("Objective clauses do not match their dispositions", "shopping_decision_context_clause_coverage");
  const constraints = new Map();
  for (const constraint of input.constraints) {
    if (constraints.has(constraint.id)) throw coded("Normalized constraint IDs must be distinct", "shopping_decision_context_constraint_coverage");
    constraints.set(constraint.id, constraint);
  }
  for (const [clauseId, disposition] of dispositions) {
    if (!isConstraintRole(disposition.role)) continue;
    const linked = disposition.constraint_ids.map((id) => constraints.get(id));
    if (linked.some((item) => !item) || linked.some((item) => !item.source_clause_ids.includes(clauseId))) throw coded("Constraint clause links are not reciprocal", "shopping_decision_context_constraint_coverage");
    for (const hint of clauses.get(clauseId).constraint_hints) if (!linked.some((item) => item.kind === hint)) throw coded(`Request clause omitted its ${hint} constraint`, "shopping_decision_context_constraint_omitted");
    const coveredLiteralIds = new Set(linked.flatMap((item) => item.literal_bindings.map((binding) => binding.literal_id)));
    for (const fact of clauses.get(clauseId).literal_facts) if (!coveredLiteralIds.has(fact.literal_id)) throw coded("A typed request literal was omitted from its normalized constraints", "shopping_decision_context_literal_omitted");
  }
  for (const constraint of constraints.values()) {
    if (new Set(constraint.source_clause_ids).size !== constraint.source_clause_ids.length || constraint.source_clause_ids.some((id) => !isConstraintRole(dispositions.get(id)?.role) || !dispositions.get(id).constraint_ids.includes(constraint.id))) throw coded("Normalized constraints must link only to reciprocal constraint clauses", "shopping_decision_context_constraint_coverage");
    const boundIds = new Set();
    for (const binding of constraint.literal_bindings) {
      const source = literals.get(binding.literal_id);
      if (!source || boundIds.has(binding.literal_id) || !constraint.source_clause_ids.includes(source.clause_id)) throw coded("Constraint literal provenance is invalid", "shopping_decision_context_literal_mismatch");
      if (source.fact.operator === "unknown") throw coded("A typed request literal has an ambiguous comparison direction", "shopping_decision_context_literal_ambiguous");
      boundIds.add(binding.literal_id);
      const { literal_id, kind, operator, value, unit } = source.fact;
      if (JSON.stringify(stable(binding)) !== JSON.stringify(stable({ literal_id, kind, operator, value, unit }))) throw coded("Constraint changed a process-extracted literal", "shopping_decision_context_literal_mismatch");
    }
  }
  const evaluatedAt = currentAt;
  if (!Number.isFinite(evaluatedAt)) throw coded("Shopping decision context process clock is invalid");
  const evaluated_at = new Date(evaluatedAt).toISOString();
  const expiresAt = new Date(evaluatedAt + input.max_age_seconds * 1_000).toISOString();
  const { max_age_seconds: ignored, ...bounded } = input;
  const constraint_routes = deriveShoppingConstraintRoutes(input);
  const materializedConstraints = materializeShoppingConstraintBindings({ constraints: input.constraints, clauses, constraint_routes, market_country_code: input.market_country_code });
  validateShoppingConstraintBindings({ constraints: materializedConstraints, clauses, constraint_routes });
  const payload = { ...bounded, constraints: materializedConstraints, request_id: input.request_receipt.request_id, request_revision: input.request_receipt.request_revision, evaluated_at, expires_at: expiresAt, constraint_routes };
  return attestShoppingArtifact("decision_context", { context_id: contextId(payload), ...payload });
}

export function verifyShoppingDecisionContext(artifact, evaluatedAt = Date.now()) {
  const parsed = shoppingDecisionContextArtifactSchema.safeParse(artifact);
  if (!parsed.success || !verifyShoppingArtifactAttestation("decision_context", artifact) || !verifyShoppingRequestReceipt(artifact.request_receipt)) return false;
  if (artifact.request_id !== artifact.request_receipt.request_id || artifact.request_revision !== artifact.request_receipt.request_revision) return false;
  try {
    if (JSON.stringify(stable(artifact.constraint_routes)) !== JSON.stringify(stable(deriveShoppingConstraintRoutes(artifact)))) return false;
    const materializedConstraints = materializeShoppingConstraintBindings({ constraints: artifact.constraints, clauses: artifact.request_receipt.clauses, constraint_routes: artifact.constraint_routes, market_country_code: artifact.market_country_code });
    if (JSON.stringify(stable(materializedConstraints)) !== JSON.stringify(stable(artifact.constraints))) return false;
    validateShoppingConstraintBindings({ constraints: materializedConstraints, clauses: artifact.request_receipt.clauses, constraint_routes: artifact.constraint_routes });
  } catch {
    return false;
  }
  const at = typeof evaluatedAt === "number" ? evaluatedAt : Date.parse(evaluatedAt || "");
  const created = Date.parse(artifact.evaluated_at || "");
  const expires = Date.parse(artifact.expires_at || "");
  if (![at, created, expires].every(Number.isFinite) || created > at + 300_000 || at > expires || expires <= created) return false;
  return artifact.context_id === contextId(contextPayload(artifact));
}

export function shoppingDecisionContextMatches(context, input) {
  if (!context || !input) return false;
  const offerId = input.offer_id ?? null;
  return context.phase === input.phase
    && context.product_id === input.product_id
    && context.offer_id === offerId
    && JSON.stringify(stable(context.applicability)) === JSON.stringify(stable(input.applicability));
}
