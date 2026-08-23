const clean = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const unique = (items) => [...new Set(items)];

function verified(item) {
  return item?.evidence_status === "verified" && clean(item.source_id);
}

function names(requirement) {
  return new Set([requirement.name, ...(requirement.aliases || [])].map(clean).filter(Boolean));
}

function componentMatches(requirement, component) {
  const accepted = names(requirement);
  return [component.name, ...(component.declared_components || [])].map(clean).some((value) => accepted.has(value));
}

function exactScope(candidate) {
  const offer = candidate.offer_formulation || {};
  const label = candidate.label || {};
  for (const field of ["formulation_id", "region", "version"]) {
    if (!clean(offer[field]) || !clean(label[field])) return { matches: null, reason: `formulation_${field}_missing` };
    if (clean(offer[field]) !== clean(label[field])) return { matches: false, reason: `formulation_${field}_mismatch` };
  }
  return { matches: true };
}

function claimLevel(status) {
  return { absent: 0, unverified: 1, marketing: 1, verified: 2, certified: 3 }[status] ?? 0;
}

function assessCandidate(input, candidate) {
  const blockers = [];
  const research = [];
  const clarifications = [];
  const warnings = [];
  const matches = [];
  const requirements = input.requirements || {};
  if (candidate.identity_verified !== true) research.push(`${candidate.id}:identity_not_verified`);
  const scope = exactScope(candidate);
  if (scope.matches !== true) research.push(`${candidate.id}:${scope.reason}`);
  if (!verified(candidate.label)) research.push(`${candidate.id}:label_not_verified`);
  if (candidate.label?.ingredient_inventory_complete !== true) research.push(`${candidate.id}:ingredient_inventory_incomplete`);
  if (requirements.excluded_materials?.length && candidate.label?.material_inventory_complete !== true) research.push(`${candidate.id}:material_inventory_incomplete`);

  const ingredients = candidate.ingredients || [];
  for (const requirement of requirements.excluded_ingredients || []) {
    for (const component of ingredients.filter((item) => componentMatches(requirement, item))) {
      if (!verified(component)) research.push(`${candidate.id}:ingredient_evidence:${clean(requirement.name).replaceAll(" ", "_")}`);
      else {
        blockers.push(`${candidate.id}:excluded_ingredient:${clean(requirement.name).replaceAll(" ", "_")}`);
        matches.push({ requirement: requirement.name, type: "ingredient", declared_as: component.name, source_id: component.source_id });
      }
    }
  }

  for (const requirement of requirements.excluded_materials || []) {
    for (const component of (candidate.materials || []).filter((item) => componentMatches(requirement, item))) {
      if (!verified(component)) research.push(`${candidate.id}:material_evidence:${clean(requirement.name).replaceAll(" ", "_")}`);
      else {
        blockers.push(`${candidate.id}:excluded_material:${clean(requirement.name).replaceAll(" ", "_")}`);
        matches.push({ requirement: requirement.name, type: "material", declared_as: component.name, source_id: component.source_id });
      }
    }
  }

  for (const requirement of requirements.max_concentrations || []) {
    const component = ingredients.find((item) => componentMatches(requirement, item));
    if (!component) {
      if (candidate.label?.ingredient_inventory_complete !== true) research.push(`${candidate.id}:concentration_component_unknown:${clean(requirement.name).replaceAll(" ", "_")}`);
      continue;
    }
    const concentration = component.concentration;
    if (!verified(component) || !verified(concentration) || typeof concentration.value !== "number" || clean(concentration.unit) !== clean(requirement.unit)) research.push(`${candidate.id}:concentration_unverified:${clean(requirement.name).replaceAll(" ", "_")}`);
    else if (concentration.value > requirement.max) blockers.push(`${candidate.id}:concentration_exceeds_limit:${clean(requirement.name).replaceAll(" ", "_")}`);
  }

  for (const requirement of requirements.allergens || []) {
    const key = clean(requirement.name).replaceAll(" ", "_");
    const directIngredient = ingredients.find((item) => componentMatches(requirement, item) && verified(item));
    const statement = (candidate.allergen_statements || []).find((item) => names(requirement).has(clean(item.allergen)));
    if (directIngredient || (verified(statement) && statement.status === "contains")) {
      blockers.push(`${candidate.id}:allergen_contains:${key}`);
      continue;
    }
    if (!statement || !verified(statement) || statement.status === "unknown") {
      research.push(`${candidate.id}:allergen_statement_unresolved:${key}`);
      continue;
    }
    if (["may_contain", "shared_equipment", "shared_facility"].includes(statement.status)) {
      if (requirement.cross_contact_policy === "avoid") blockers.push(`${candidate.id}:allergen_cross_contact:${key}`);
      else if (requirement.cross_contact_policy === "clarify") clarifications.push(`${candidate.id}:allergen_cross_contact:${key}`);
      else warnings.push(`${candidate.id}:allergen_cross_contact_disclosed:${key}`);
    } else if (statement.status !== "free_from") research.push(`${candidate.id}:allergen_statement_unresolved:${key}`);
  }

  for (const requirement of requirements.required_claims || []) {
    const key = clean(requirement.name).replaceAll(" ", "_");
    const claim = (candidate.claims || []).find((item) => clean(item.name) === clean(requirement.name));
    if (!claim || !verified(claim)) research.push(`${candidate.id}:claim_unverified:${key}`);
    else if (claim.status === "absent") blockers.push(`${candidate.id}:required_claim_absent:${key}`);
    else if (claimLevel(claim.status) < claimLevel(requirement.minimum_evidence || "verified")) research.push(`${candidate.id}:claim_evidence_insufficient:${key}`);
  }

  for (const prohibited of requirements.prohibited_hazards || []) {
    const key = clean(prohibited);
    const hazard = (candidate.hazards || []).find((item) => clean(item.classification) === key);
    if (!hazard) {
      if (candidate.label?.hazard_inventory_complete !== true) research.push(`${candidate.id}:hazard_inventory_incomplete:${key}`);
      continue;
    }
    if (!verified(hazard)) research.push(`${candidate.id}:hazard_evidence:${key}`);
    else if (hazard.present === true) blockers.push(`${candidate.id}:prohibited_hazard:${key}`);
  }

  const normalizedBlockers = unique(blockers);
  const normalizedResearch = unique(research);
  const normalizedClarifications = unique(clarifications);
  const action = normalizedBlockers.length ? "reject" : normalizedResearch.length ? "research_more" : normalizedClarifications.length ? "clarify" : "eligible";
  return { id: candidate.id, action, formulation_scope: scope, blockers: normalizedBlockers, research: normalizedResearch, clarifications: normalizedClarifications, warnings: unique(warnings), matched_exclusions: matches, composition_cleared_for_ranking: action === "eligible", medical_diagnosis_provided: false, purchase_allowed: false };
}

export function assessShoppingComposition(input) {
  const assessments = (input.candidates || []).map((candidate) => assessCandidate(input, candidate));
  return {
    assessments,
    decision: {
      eligible_candidates: assessments.filter((item) => item.action === "eligible").map((item) => item.id),
      research_candidates: assessments.filter((item) => item.action === "research_more").map((item) => item.id),
      clarify_candidates: assessments.filter((item) => item.action === "clarify").map((item) => item.id),
      rejected_candidates: assessments.filter((item) => item.action === "reject").map((item) => item.id),
      selected_candidate: null,
      purchase_allowed: false,
    },
  };
}
