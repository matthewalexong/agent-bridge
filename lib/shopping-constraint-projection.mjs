const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const RULES = Object.freeze({
  excluded_ingredient: { kind: "composition", stage: "composition", read: (input) => input?.requirements?.excluded_ingredients?.map((item) => item.name) || [] },
  excluded_material: { kind: "composition", stage: "composition", read: (input) => input?.requirements?.excluded_materials?.map((item) => item.name) || [] },
  max_concentration: { kind: "composition", stage: "composition", read: (input) => input?.requirements?.max_concentrations || [] },
  allergen: { kind: "composition", stage: "composition", read: (input) => input?.requirements?.allergens?.map((item) => item.name) || [] },
  required_claim: { kind: "composition", stage: "composition", read: (input) => input?.requirements?.required_claims?.map((item) => item.name) || [] },
  prohibited_hazard: { kind: "composition", stage: "composition", read: (input) => input?.requirements?.prohibited_hazards || [] },

  prohibited_data_category: { kind: "privacy", stage: "privacy", read: (input) => input?.requirements?.prohibited_data_categories || [] },
  prohibit_targeted_ads: { kind: "privacy", stage: "privacy", pattern: /\btarget(?:ed|ing)?\s+(?:ads?|advertising)\b/i, read: (input) => input?.requirements?.prohibit_targeted_ads },
  prohibit_data_sale: { kind: "privacy", stage: "privacy", pattern: /\b(?:data\s+sale|sell(?:ing)?\s+(?:my\s+)?data|sale\s+of\s+(?:my\s+)?data)\b/i, read: (input) => input?.requirements?.prohibit_data_sale },
  allowed_third_party_purpose: { kind: "privacy", stage: "privacy", match: exactSet, read: (input) => input?.requirements?.allowed_third_party_purposes || [] },
  max_retention_days: { kind: "privacy", stage: "privacy", pattern: /\bretention|retain(?:ed|s|ing)?\b/i, read: (input) => input?.requirements?.max_retention_days },
  account_optional_required: { kind: "privacy", stage: "privacy", pattern: /\baccount\b/i, read: (input) => input?.requirements?.account_optional_required },
  local_core_operation_required: { kind: "privacy", stage: "privacy", pattern: /\b(?:local|offline|cloud)\b/i, read: (input) => input?.requirements?.local_core_operation_required },
  deletion_required: { kind: "privacy", stage: "privacy", pattern: /\bdelet(?:e|ion|able)\b/i, read: (input) => input?.requirements?.deletion_required },
  export_required: { kind: "privacy", stage: "privacy", pattern: /\b(?:data\s+)?export\b/i, read: (input) => input?.requirements?.export_required },
  consent_withdrawal_required: { kind: "privacy", stage: "privacy", pattern: /\b(?:withdraw|revoke).{0,20}\bconsent\b|\bconsent.{0,20}(?:withdraw|revoke)/i, read: (input) => input?.requirements?.consent_withdrawal_required },
  max_deletion_days: { kind: "privacy", stage: "privacy", pattern: /\bdelet(?:e|ion)\b/i, read: (input) => input?.requirements?.max_deletion_days },
  encryption_in_transit_required: { kind: "privacy", stage: "privacy", pattern: /\bencrypt(?:ed|ion)?.{0,24}\btransit\b|\btransit.{0,24}\bencrypt/i, read: (input) => input?.requirements?.encryption_in_transit_required },
  encryption_at_rest_required: { kind: "privacy", stage: "privacy", pattern: /\bencrypt(?:ed|ion)?.{0,24}\bat\s+rest\b|\bat\s+rest.{0,24}\bencrypt/i, read: (input) => input?.requirements?.encryption_at_rest_required },
  mfa_required: { kind: "privacy", stage: "privacy", pattern: /\b(?:mfa|multi factor|two factor|2fa)\b/i, read: (input) => input?.requirements?.mfa_required },
  prohibited_required_permission: { kind: "privacy", stage: "privacy", read: (input) => input?.requirements?.prohibited_required_permissions || [] },
  secure_resale_required: { kind: "privacy", stage: "privacy", pattern: /\b(?:resale|resell|factory reset|unlink|ownership transfer)\b/i, read: (input) => input?.requirements?.secure_resale_required },

  allowed_condition: {
    kind: "condition", stages: ["condition", "checkout"],
    read: (input, stage) => stage === "checkout" ? input?.expected?.condition : input?.requirements?.allowed_conditions || [],
    match: (actual, expected, stage) => stage === "checkout" ? (Array.isArray(expected) ? expected : [expected]).some((item) => scalarEqual(actual, item)) : exactSet(actual, expected),
  },
  allow_for_parts: { kind: "condition", stage: "condition", pattern: /\bfor\s+parts\b/i, read: (input) => input?.requirements?.allow_for_parts },
  required_function_test: { kind: "condition", stage: "condition", read: (input) => input?.requirements?.required_function_tests || [] },
  require_authorized_refurbisher: { kind: "condition", stage: "condition", pattern: /\b(?:authorized|manufacturer).{0,24}\brefurbish/i, read: (input) => input?.requirements?.require_authorized_refurbisher },
  data_wipe_required: { kind: "condition", stage: "condition", pattern: /\b(?:data\s+wipe|wiped|erase(?:d)?|factory reset)\b/i, read: (input) => input?.requirements?.data_wipe_required },
  sanitation_required: { kind: "condition", stage: "condition", pattern: /\b(?:sanitiz|sanitis|cleaned|hygiene)/i, read: (input) => input?.requirements?.sanitation_required },
  battery_health_required: { kind: "condition", stage: "condition", pattern: /\bbattery\s+health\b/i, read: (input) => input?.requirements?.battery_health_required },
  min_battery_health_percent: { kind: "condition", stage: "condition", pattern: /\bbattery\s+health\b/i, read: (input) => input?.requirements?.min_battery_health_percent },
  max_battery_cycles: { kind: "condition", stage: "condition", pattern: /\bbattery\s+cycles?|cycle\s+count\b/i, read: (input) => input?.requirements?.max_battery_cycles },
  device_lock_checks_required: { kind: "condition", stage: "condition", pattern: /\b(?:device|activation|mdm|carrier)\s+lock/i, read: (input) => input?.requirements?.device_lock_checks_required },
  carrier_lock_allowed: { kind: "condition", stage: "condition", pattern: /\b(?:carrier\s+lock|unlocked)\b/i, read: (input) => input?.requirements?.carrier_lock_allowed },
  required_accessory: { kind: "condition", stage: "condition", read: (input) => input?.requirements?.required_accessories || [] },

  verified_legal_seller_required: { kind: "merchant", stage: "merchant", pattern: /\b(?:legal\s+seller|seller\s+identity|verified\s+seller)\b/i, read: (input) => input?.requirements?.verified_legal_seller_required },
  authorized_seller_required: { kind: "merchant", stage: "counterfeit", pattern: /\bauthori[sz]ed\s+(?:seller|retailer|dealer|store)\b/i, read: (input) => input?.requirements?.authorized_seller_required },
  return_destination_required: { kind: "merchant", stage: "merchant", pattern: /\breturn.{0,20}\b(?:address|destination|country)\b/i, read: (input) => input?.requirements?.return_destination_required },
  allowed_merchant_return_country: { kind: "merchant", stage: "merchant", match: exactSet, read: (input) => input?.requirements?.allowed_return_countries || [] },
  reversible_payment_required: { kind: "merchant", stage: "merchant", pattern: /\b(?:reversible\s+payment|chargeback|credit\s+card)\b/i, read: (input) => input?.requirements?.reversible_payment_required },
  buyer_protection_required: { kind: "merchant", stage: "merchant", pattern: /\bbuyer\s+protection\b/i, read: (input) => input?.requirements?.buyer_protection_required },

  require_tracking: { kind: "fulfillment", stage: "fulfillment", pattern: /\btrack(?:ed|ing)?\b/i, read: (input) => input?.requirements?.require_tracking },
  require_verified_return_destination: { kind: "fulfillment", stage: "fulfillment", pattern: /\breturn.{0,20}\b(?:address|destination|country)\b/i, read: (input) => input?.requirements?.require_verified_return_destination },
  require_return_cost: { kind: "fulfillment", stage: "fulfillment", pattern: /\breturn.{0,20}\b(?:cost|shipping|postage|fee)\b/i, read: (input) => input?.requirements?.require_return_cost },
  allowed_fulfillment_return_country: { kind: "fulfillment", stage: "fulfillment", match: exactSet, read: (input) => input?.requirements?.allowed_return_countries || [] },
  delivery_evidence_required: { kind: "fulfillment", stage: "fulfillment", pattern: /\b(?:deliver(?:y|ed|ing)?|arrival|arrive[sd]?)\b/i, read: (input) => Boolean(input?.offers?.length) && input.offers.every((offer) => offer?.delivery && typeof offer.delivery === "object") },

  certification_requirement: { kind: "safety", stage: "safety", read: (input) => input?.certification_requirements || [] },
});

const BINDING_REQUIRED_KINDS = new Set(["composition", "privacy", "condition", "merchant", "fulfillment", "safety"]);
const NEGATIVE_RULES = new Set(["excluded_ingredient", "excluded_material", "prohibited_hazard", "prohibited_data_category", "prohibit_targeted_ads", "prohibit_data_sale", "prohibited_required_permission"]);

function coded(message, code = "shopping_constraint_projection_invalid") {
  return Object.assign(new Error(message), { code });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function stages(policy) {
  return policy.stages || [policy.stage];
}

function scalarEqual(actual, expected) {
  if (typeof expected === "string") return clean(actual) === clean(expected);
  return actual === expected;
}

function exactSet(actual, expected) {
  if (!Array.isArray(actual)) return false;
  const expectedItems = Array.isArray(expected) ? expected : [expected];
  return actual.length === expectedItems.length && expectedItems.every((item) => actual.some((candidate) => scalarEqual(candidate, item)));
}

function objectEqual(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => scalarEqual(actual[key], value));
}

function projected(actual, expected) {
  if (Array.isArray(actual)) {
    const expectedItems = Array.isArray(expected) ? expected : [expected];
    return expectedItems.every((item) => actual.some((candidate) => typeof item === "object" ? objectEqual(candidate, item) : scalarEqual(candidate, item)));
  }
  if (Array.isArray(expected)) return expected.length === 1 && scalarEqual(actual, expected[0]);
  if (expected && typeof expected === "object") return objectEqual(actual, expected);
  return scalarEqual(actual, expected);
}

function quoteContainsValue(quote, value) {
  if (typeof value === "string") return clean(quote).includes(clean(value));
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").every((item) => clean(quote).includes(clean(item)));
  if (value && typeof value === "object") return [value.name, value.scheme].filter(Boolean).every((item) => clean(quote).includes(clean(item)));
  return true;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function sourceClauses(constraint, clauses) {
  const clauseMap = clauses instanceof Map ? clauses : new Map((clauses || []).map((clause) => [clause.clause_id, clause]));
  return constraint.source_clause_ids.map((id) => clauseMap.get(id)).filter(Boolean);
}

function normalizedConditions(text) {
  const found = [];
  const values = [
    ["open_box", /\bopen[- ]box\b/i], ["display_model", /\bdisplay(?:[- ]model)?\b/i], ["for_parts", /\bfor[- ]parts\b/i],
    ["refurbished", /\b(?:refurbished|renewed|remanufactured)\b/i], ["used", /\b(?:used|preowned|pre-owned)\b/i], ["new", /\bnew\b/i],
  ];
  for (const [value, pattern] of values) if (pattern.test(text)) found.push(value);
  return found;
}

function numericBinding(constraint, pattern = null) {
  return (constraint.literal_bindings || []).find((binding) => typeof binding.value === "number" && (!pattern || pattern.test(binding.unit || ""))) || null;
}

function compositionExclusions(text) {
  const match = /\b(?:no|without|avoid|exclude(?:d)?|must\s+not\s+(?:contain|include|use))\s+(.+)$/i.exec(text);
  if (!match) return [];
  return match[1]
    .replace(/^(?:any\s+)?(?:products?\s+)?(?:made\s+(?:from|of|with)\s+|containing\s+|with\s+)?/i, "")
    .split(/\s*(?:,|\band\b|\bor\b)\s*/i)
    .map((item) => item.replace(/^(?:any|a|an|the)\s+/i, "").replace(/\s+(?:materials?|ingredients?)$/i, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 120);
}

function deriveBindingsForConstraint(constraint, clauses, route, marketCountryCode) {
  if (!route || route.status !== "active") return [];
  const output = [];
  const emit = (rule, value, clause) => {
    const policy = RULES[rule];
    if (!policy) return;
    for (const stage of route.stages.filter((name) => stages(policy).includes(name))) output.push({ stage, rule, value, source_clause_id: clause.clause_id, source_quote: clause.text });
  };
  for (const clause of sourceClauses(constraint, clauses)) {
    const text = clause.text;
    const clauseLiteralIds = new Set((clause.literal_facts || []).map((binding) => binding.literal_id));
    const negative = (constraint.literal_bindings || []).some((binding) => binding.kind === "negation" && binding.operator === "not_allowed" && clauseLiteralIds.has(binding.literal_id));
    if (constraint.kind === "composition" && negative) {
      for (const term of compositionExclusions(text)) {
        const material = /\b(?:leather|wool|latex|rubber|plastic|vinyl|pvc|nickel|metal|silicone|silicon)\b/i.test(term) || /\bmaterial\b/i.test(constraint.requirement);
        emit(material ? "excluded_material" : "excluded_ingredient", term, clause);
      }
    } else if (constraint.kind === "privacy") {
      if (/\b(?:data\s+sale|sell(?:ing)?\s+(?:my\s+)?data|sale\s+of\s+(?:my\s+)?data)\b/i.test(text) && negative) emit("prohibit_data_sale", true, clause);
      if (/\btarget(?:ed|ing)?\s+(?:ads?|advertising)\b/i.test(text) && negative) emit("prohibit_targeted_ads", true, clause);
      if (/\baccount\b/i.test(text) && /\b(?:no|without|optional|not\s+required)\b/i.test(text)) emit("account_optional_required", true, clause);
      if (/\b(?:local|offline)\b/i.test(text)) emit("local_core_operation_required", true, clause);
      if (/\bdelet(?:e|ion|able)\b/i.test(text)) emit("deletion_required", true, clause);
      if (/\b(?:data\s+)?export\b/i.test(text)) emit("export_required", true, clause);
      if (/\b(?:mfa|multi[- ]factor|two[- ]factor|2fa)\b/i.test(text)) emit("mfa_required", true, clause);
      if (/\bencrypt(?:ed|ion)?.{0,24}\btransit\b|\btransit.{0,24}\bencrypt/i.test(text)) emit("encryption_in_transit_required", true, clause);
      if (/\bencrypt(?:ed|ion)?.{0,24}\bat\s+rest\b|\bat\s+rest.{0,24}\bencrypt/i.test(text)) emit("encryption_at_rest_required", true, clause);
    } else if (constraint.kind === "condition") {
      const allowed = normalizedConditions(text);
      if (allowed.length) emit("allowed_condition", allowed, clause);
      const number = numericBinding(constraint);
      if (number && /\bbattery\s+health\b/i.test(text)) emit("min_battery_health_percent", number.value, clause);
      if (number && /\b(?:battery\s+cycles?|cycle\s+count)\b/i.test(text)) emit("max_battery_cycles", number.value, clause);
      if (/\b(?:authorized|manufacturer).{0,24}\brefurbish/i.test(text)) emit("require_authorized_refurbisher", true, clause);
      if (/\b(?:data\s+wipe|wiped|erase(?:d)?|factory reset)\b/i.test(text)) emit("data_wipe_required", true, clause);
      if (/\b(?:carrier\s+lock|unlocked)\b/i.test(text)) emit("carrier_lock_allowed", false, clause);
    } else if (constraint.kind === "merchant") {
      if (/\bauthori[sz]ed\s+(?:seller|retailer|dealer|store)\b/i.test(text)) emit("authorized_seller_required", true, clause);
      if (/\b(?:legal\s+seller|seller\s+identity|verified\s+seller)\b/i.test(text)) emit("verified_legal_seller_required", true, clause);
      if (/\b(?:reversible\s+payment|chargeback|credit\s+card)\b/i.test(text)) emit("reversible_payment_required", true, clause);
      if (/\bbuyer\s+protection\b/i.test(text)) emit("buyer_protection_required", true, clause);
      if (/\breturn.{0,20}\b(?:address|destination|country)\b/i.test(text)) emit("return_destination_required", true, clause);
    } else if (constraint.kind === "fulfillment") {
      if (/\btrack(?:ed|ing)?\b/i.test(text)) emit("require_tracking", true, clause);
      if (/\breturn.{0,20}\b(?:address|destination|country)\b/i.test(text)) emit("require_verified_return_destination", true, clause);
      if (/\breturn.{0,20}\b(?:cost|shipping|postage|fee)\b/i.test(text)) emit("require_return_cost", true, clause);
      if (/\b(?:deliver(?:y|ed|ing)?|arrival|arrive[sd]?)\b/i.test(text)) emit("delivery_evidence_required", true, clause);
    } else if (constraint.kind === "safety") {
      const match = /\b([A-Za-z][A-Za-z0-9-]{1,30})\s+(?:certified|certification)\b/i.exec(text);
      if (match) emit("certification_requirement", { scheme: match[1], jurisdiction: marketCountryCode }, clause);
    }
  }
  return output;
}

export function materializeShoppingConstraintBindings({ constraints = [], clauses, constraint_routes = [], market_country_code }) {
  return constraints.map((constraint) => {
    const route = constraint_routes.find((item) => item.constraint_id === constraint.id);
    const derived = deriveBindingsForConstraint(constraint, clauses, route, market_country_code);
    if ((constraint.evaluator_bindings || []).length && !same(constraint.evaluator_bindings, derived)) throw coded(`Constraint ${constraint.id} supplied evaluator bindings that differ from process derivation`, "shopping_constraint_projection_mismatch");
    return { ...constraint, evaluator_bindings: derived };
  });
}

function summaryContainsValue(summary, value) {
  if (typeof value === "string") return clean(summary).includes(clean(value));
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").every((item) => clean(summary).includes(clean(item)));
  if (value && typeof value === "object") return [value.name, value.scheme].filter(Boolean).every((item) => clean(summary).includes(clean(item)));
  if (typeof value === "number") return clean(summary).includes(clean(value));
  return true;
}

export function validateShoppingConstraintBindings({ constraints = [], clauses, constraint_routes = [] }) {
  const clauseMap = clauses instanceof Map ? clauses : new Map((clauses || []).map((clause) => [clause.clause_id, clause]));
  for (const constraint of constraints) {
    const routes = constraint_routes.filter((route) => route.constraint_id === constraint.id && route.status === "active");
    for (const binding of constraint.evaluator_bindings || []) {
      const policy = RULES[binding.rule];
      if (!policy || policy.kind !== constraint.kind || !stages(policy).includes(binding.stage) || !routes.some((route) => route.stages.includes(binding.stage))) throw coded(`Constraint ${constraint.id} has an invalid ${binding.rule} stage mapping`, "shopping_constraint_projection_route");
      if (!constraint.source_clause_ids.includes(binding.source_clause_id)) throw coded(`Constraint ${constraint.id} projection is not linked to its source clause`, "shopping_constraint_projection_source");
      const clause = clauseMap.get(binding.source_clause_id);
      if (!clause || !clause.text.includes(binding.source_quote)) throw coded(`Constraint ${constraint.id} projection quote is not verbatim request text`, "shopping_constraint_projection_source");
      if (policy.pattern && !policy.pattern.test(binding.source_quote)) throw coded(`Constraint ${constraint.id} projection rule is not supported by its request quote`, "shopping_constraint_projection_source");
      if (!quoteContainsValue(binding.source_quote, binding.value)) throw coded(`Constraint ${constraint.id} projection value is not grounded in its request quote`, "shopping_constraint_projection_source");
      if (!summaryContainsValue(constraint.value, binding.value)) throw coded(`Constraint ${constraint.id} normalized value disagrees with its evaluator projection`, "shopping_constraint_projection_source");
      if (NEGATIVE_RULES.has(binding.rule) && !(constraint.literal_bindings || []).some((item) => item.kind === "negation" && item.operator === "not_allowed")) throw coded(`Constraint ${constraint.id} prohibition lacks process-extracted negation`, "shopping_constraint_projection_polarity");
      if (typeof binding.value === "number" && !(constraint.literal_bindings || []).some((item) => item.value === binding.value)) throw coded(`Constraint ${constraint.id} numeric projection lacks its canonical literal`, "shopping_constraint_projection_source");
    }
    if (constraint.hard_gate && BINDING_REQUIRED_KINDS.has(constraint.kind)) {
      for (const route of routes) {
        for (const stage of route.stages) {
          if (!(constraint.evaluator_bindings || []).some((binding) => binding.stage === stage)) throw coded(`Hard constraint ${constraint.id} lacks an exact ${stage} evaluator projection`, "shopping_constraint_projection_missing");
        }
      }
    }
  }
  return true;
}

export function validateShoppingConstraintProjectionInput(stage, constraint, input) {
  for (const binding of (constraint.evaluator_bindings || []).filter((item) => item.stage === stage)) {
    const policy = RULES[binding.rule];
    const actual = policy?.read(input, stage);
    if (!policy || !(policy.match ? policy.match(actual, binding.value, stage) : projected(actual, binding.value))) throw coded(`Evaluator ${stage} omitted or altered ${binding.rule} for constraint ${constraint.id}`, "shopping_constraint_input_mismatch");
  }
}
