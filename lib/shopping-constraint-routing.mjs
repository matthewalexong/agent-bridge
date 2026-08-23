import { validateShoppingConstraintProjectionInput } from "./shopping-constraint-projection.mjs";

const ROUTES = Object.freeze({
  product_recommendation: {
    budget: ["preferences"], deadline: [], compatibility: ["compatibility"], safety: ["safety"], composition: ["composition"], privacy: ["privacy"], condition: [], merchant: [], fulfillment: [], preference: ["preferences"], other: ["preferences"],
  },
  offer_recommendation: {
    budget: ["fulfillment", "offer"], deadline: ["fulfillment"], compatibility: ["compatibility"], safety: ["safety"], composition: ["composition"], privacy: ["privacy"], condition: ["condition"], merchant: ["merchant"], fulfillment: ["fulfillment"], preference: ["preferences"], other: ["preferences"],
  },
  checkout_review: {
    budget: ["checkout"], deadline: ["fulfillment"], compatibility: ["compatibility"], safety: ["safety"], composition: ["composition"], privacy: ["privacy"], condition: ["condition", "checkout"], merchant: ["merchant"], fulfillment: ["fulfillment"], preference: ["preferences"], other: ["preferences"],
  },
});

const DEFERRED_PHASE = Object.freeze({ deadline: "offer_recommendation", condition: "offer_recommendation", merchant: "offer_recommendation", fulfillment: "offer_recommendation" });
const OPTIONAL_STAGE = Object.freeze({ preferences: "preferences", compatibility: "compatibility", composition: "composition", privacy: "privacy", condition: "condition" });

function coded(message, code = "shopping_constraint_route_invalid") {
  return Object.assign(new Error(message), { code });
}

function sameSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function constraintSourceText(input, constraint) {
  const ids = new Set(constraint.source_clause_ids || []);
  return (input?.request_receipt?.clauses || []).filter((clause) => ids.has(clause.clause_id)).map((clause) => clause.text).join(" ");
}

export function deriveShoppingConstraintRoutes(input) {
  const policy = ROUTES[input?.phase];
  if (!policy) throw coded("Shopping constraint phase is invalid");
  return (input.constraints || []).map((constraint) => {
    let stages = policy[constraint.kind];
    if (!stages) throw coded(`Shopping constraint kind is not routable: ${constraint.kind}`);
    if (constraint.kind === "merchant" && stages.length && /\bauthori[sz]ed\s+(?:seller|retailer|dealer|store)\b/i.test(constraintSourceText(input, constraint))) stages = ["counterfeit"];
    if (constraint.kind === "deadline" && stages.length) {
      const deadline = (constraint.literal_bindings || []).find((binding) => binding.kind === "deadline");
      if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(String(deadline.value))) throw coded(`Constraint ${constraint.id} requires an unambiguous ISO arrival date`, "shopping_constraint_deadline_unresolved");
    }
    for (const stage of stages) {
      const applicability = OPTIONAL_STAGE[stage];
      if (applicability && input.applicability?.[applicability]?.required !== true) throw coded(`Constraint ${constraint.id} requires applicable ${applicability}`, "shopping_constraint_route_applicability");
    }
    return { constraint_id: constraint.id, kind: constraint.kind, status: stages.length ? "active" : "deferred", stages, deferred_until: stages.length ? null : (DEFERRED_PHASE[constraint.kind] || "offer_recommendation") };
  });
}

export function requiredConstraintIdsForStage(context, stage) {
  return (context?.constraint_routes || []).filter((route) => route.status === "active" && route.stages.includes(stage)).map((route) => route.constraint_id).sort();
}

function constraintById(context, id) {
  return (context?.constraints || []).find((constraint) => constraint.id === id);
}

function literal(constraint, kind) {
  return (constraint?.literal_bindings || []).find((binding) => binding.kind === kind) || null;
}

function compatibleOperator(value) {
  return ({ lt: "lt", lte: "lte", gt: "gt", gte: "gte", eq: "eq", not_allowed: "neq" })[value] || null;
}

function validateLiteralConsumption(stage, constraint, input) {
  const money = literal(constraint, "money");
  const deadline = literal(constraint, "deadline");
  if (stage === "preferences") {
    const routed = (input?.constraints || []).filter((item) => item.id === constraint.id);
    if (!routed.length) throw coded(`Preference input omitted constraint ${constraint.id}`, "shopping_constraint_input_missing");
    for (const binding of constraint.literal_bindings || []) {
      const projection = routed.find((item) => item.literal_id === binding.literal_id);
      if (!projection) throw coded(`Preference input omitted literal ${binding.literal_id}`, "shopping_constraint_input_missing");
      if (projection.value !== binding.value || projection.operator !== compatibleOperator(binding.operator) || (projection.unit ?? null) !== (binding.unit ?? null)) throw coded(`Preference input altered constraint ${constraint.id}`, "shopping_constraint_input_mismatch");
    }
  }
  if (constraint.kind === "compatibility" && stage === "compatibility" && !(input?.requirements || []).some((item) => item.id === constraint.id)) throw coded(`Compatibility input omitted constraint ${constraint.id}`, "shopping_constraint_input_missing");
  if (money && money.unit !== "USD") throw coded(`Evaluator requires normalized USD for constraint ${constraint.id}`, "shopping_constraint_currency_unsupported");
  if (money && !["lt", "lte"].includes(money.operator)) throw coded(`Budget direction is unsupported for constraint ${constraint.id}`, "shopping_constraint_operator_unsupported");
  if (money && stage === "fulfillment" && (input?.requirements?.max_fully_landed_usd !== money.value || input?.requirements?.max_fully_landed_operator !== money.operator)) throw coded(`Fulfillment input altered constraint ${constraint.id}`, "shopping_constraint_input_mismatch");
  if (money && stage === "offer" && (input?.requirements?.max_landed_usd !== money.value || input?.requirements?.max_landed_operator !== money.operator)) throw coded(`Offer input altered constraint ${constraint.id}`, "shopping_constraint_input_mismatch");
  if (money && stage === "checkout" && (input?.expected?.max_total_usd !== money.value || input?.expected?.max_total_operator !== money.operator)) throw coded(`Checkout input altered constraint ${constraint.id}`, "shopping_constraint_input_mismatch");
  if (deadline && stage === "fulfillment" && String(input?.requirements?.required_by || "").slice(0, 10).toLowerCase() !== String(deadline.value).toLowerCase()) throw coded(`Fulfillment input altered deadline ${constraint.id}`, "shopping_constraint_input_mismatch");
  validateShoppingConstraintProjectionInput(stage, constraint, input);
}

export function validateShoppingConstraintJob({ decision_context, stage, constraint_ids = [], input }) {
  const claimed = [...new Set(constraint_ids)].sort();
  if (claimed.length !== constraint_ids.length) throw coded("Constraint job IDs must be distinct");
  const required = requiredConstraintIdsForStage(decision_context, stage);
  if (!sameSet(claimed, required)) throw coded(`Evaluator stage ${stage} must consume its complete routed constraint set`, "shopping_constraint_route_incomplete");
  for (const id of claimed) {
    const constraint = constraintById(decision_context, id);
    if (!constraint) throw coded(`Unknown shopping constraint: ${id}`);
    validateLiteralConsumption(stage, constraint, input);
  }
  return claimed;
}
